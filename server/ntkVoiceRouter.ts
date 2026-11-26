import { GoogleGenAI } from '@google/genai';
import type {
  NtkAudioChunkPayload,
  NtkPoolType,
  NtkStoredKey,
  NtkTranscriptSegment,
} from './ntkVoiceTypes';
import { NtkVoiceStore, validateExternalHttpsUrl } from './ntkVoiceStore';

export class ProviderCallError extends Error {
  statusCode: number;
  retryAfterSec?: number;
  isDailyQuota?: boolean;

  constructor(
    message: string,
    statusCode: number,
    options?: { retryAfterSec?: number; isDailyQuota?: boolean }
  ) {
    super(message);
    this.name = 'ProviderCallError';
    this.statusCode = statusCode;
    this.retryAfterSec = options?.retryAfterSec;
    this.isDailyQuota = options?.isDailyQuota;
  }
}

export interface SttResult {
  text: string;
  segments: NtkTranscriptSegment[];
  provider: string;
  keyId: string;
  keyLabel: string;
}

export interface LlmResult {
  text: string;
  provider: string;
  keyId: string;
  keyLabel: string;
  model: string;
}

export type PoolAttemptExecutor<T> = (key: NtkStoredKey) => Promise<T>;

const REQUEST_TIMEOUT_MS = 28000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProviderCallError(`Provider timed out after ${Math.round(timeoutMs / 1000)}s`, 504);
    }
    throw new ProviderCallError(
      err instanceof Error ? err.message : 'Network error reaching provider',
      503
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseRetryAfter(headers: Headers): number | undefined {
  const val = headers.get('retry-after');
  if (!val) return undefined;
  const num = Number(val);
  if (Number.isFinite(num) && num > 0) return Math.min(3600, Math.ceil(num));
  const dateMs = Date.parse(val);
  if (!Number.isNaN(dateMs)) {
    const diff = Math.ceil((dateMs - Date.now()) / 1000);
    if (diff > 0) return Math.min(3600, diff);
  }
  return undefined;
}

function segmentTextFallback(
  text: string,
  offsetSeconds: number,
  durationSeconds: number,
  provider: string,
  chunkIndex: number
): NtkTranscriptSegment[] {
  const clean = text.replace(/\r/g, '').trim();
  if (!clean) return [];
  const rawSentences = clean
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const sentences = rawSentences.length > 0 ? rawSentences : [clean];
  const dur = Math.max(1, Number.isFinite(durationSeconds) ? durationSeconds : sentences.length * 4);
  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0) || 1;
  let cursor = offsetSeconds;
  return sentences.map((sentence, idx) => {
    const share = (sentence.length / totalChars) * dur;
    const start = Number(cursor.toFixed(2));
    const end = Number(Math.min(offsetSeconds + dur, cursor + Math.max(0.6, share)).toFixed(2));
    cursor = end;
    return {
      id: `ntk-seg-${chunkIndex}-${idx}-${Date.now()}`,
      start,
      end: Math.max(start + 0.4, end),
      text: sentence,
      provider,
      chunkIndex,
    };
  });
}

function fileExtensionForMime(mimeType: string): string {
  if (/mp3|mpeg/i.test(mimeType)) return 'mp3';
  if (/webm/i.test(mimeType)) return 'webm';
  if (/ogg/i.test(mimeType)) return 'ogg';
  if (/mp4|m4a/i.test(mimeType)) return 'm4a';
  return 'wav';
}

export class NtkVoiceRouter {
  private store: NtkVoiceStore;

  constructor(store: NtkVoiceStore) {
    this.store = store;
  }

  /**
   * Builds the ordered list of candidate keys for a pool using Round-Robin or Priority Failover,
   * automatically recovering keys whose cooldown window has elapsed.
   */
  getCandidateKeys(pool: NtkPoolType, now = Date.now()): NtkStoredKey[] {
    const data = this.store.getData();
    const enabled = data.keys
      .filter((k) => k.pool === pool && k.enabled && k.apiKey.trim().length > 0)
      .sort((a, b) => a.priority - b.priority);

    // Auto-recover keys whose cooldown expired
    for (const k of enabled) {
      if (k.status === 'cooldown' && k.cooldownUntil <= now && k.dailyExhaustedUntil <= now) {
        k.status = 'ready';
        k.consecutiveErrors = 0;
      }
    }

    const healthy = enabled.filter(
      (k) => k.cooldownUntil <= now && k.dailyExhaustedUntil <= now
    );

    if (healthy.length === 0) {
      // If all keys are cooling down, try the one closest to expiry as last resort
      return [...enabled].sort(
        (a, b) =>
          Math.max(a.cooldownUntil, a.dailyExhaustedUntil) -
          Math.max(b.cooldownUntil, b.dailyExhaustedUntil)
      );
    }

    const strategy = pool === 'stt' ? data.sttStrategy : data.llmStrategy;
    if (strategy === 'round_robin' && healthy.length > 1) {
      const cursor = pool === 'stt' ? data.sttCursor : data.llmCursor;
      const startIdx = cursor % healthy.length;
      if (pool === 'stt') {
        data.sttCursor = (startIdx + 1) % healthy.length;
      } else {
        data.llmCursor = (startIdx + 1) % healthy.length;
      }
      return [...healthy.slice(startIdx), ...healthy.slice(0, startIdx)];
    }

    return healthy;
  }

  /**
   * Executes an operation across the pool with silent automatic failover,
   * Retry-After cooldown tracking, circuit-breaker escalation, and audit logging.
   */
  async executeWithFailover<T>(
    pool: NtkPoolType,
    executor: PoolAttemptExecutor<T>,
    meta?: { chunkIndex?: number; skipDailyCap?: boolean }
  ): Promise<{ result: T; key: NtkStoredKey; attempts: number; failovers: number }> {
    const data = this.store.getData();
    if (
      !meta?.skipDailyCap &&
      data.workstation.dailyAiRequestCap > 0 &&
      data.dailyAiRequests >= data.workstation.dailyAiRequestCap
    ) {
      throw new ProviderCallError(
        `Daily office AI cap (${data.workstation.dailyAiRequestCap} requests) reached. Adjust in Manage -> Workstation Settings.`,
        429
      );
    }

    const candidates = this.getCandidateKeys(pool);
    if (candidates.length === 0) {
      throw new ProviderCallError(
        pool === 'stt'
          ? 'No Speech-to-Text API keys are enabled yet. Open Manage -> API Key Pool to add a free Groq, Gemini, Deepgram, or Cloudflare key.'
          : 'No Text AI keys are enabled yet. Open Manage -> API Key Pool to add a free Gemini, Groq, Cerebras, or OpenRouter key.',
        503
      );
    }

    let attempts = 0;
    let failovers = 0;
    let lastErrorMessage = 'All configured providers failed.';
    let lastStatus = 502;

    for (let i = 0; i < candidates.length; i++) {
      const key = candidates[i];
      attempts++;
      const started = Date.now();
      key.requestCount++;
      key.lastUsedAt = started;

      try {
        const result = await executor(key);
        const latency = Date.now() - started;
        key.successCount++;
        key.consecutiveErrors = 0;
        key.status = 'ready';
        key.cooldownUntil = 0;
        key.lastError = null;
        key.lastLatencyMs = latency;
        if (!meta?.skipDailyCap) {
          data.dailyAiRequests++;
        }
        this.store.appendLog({
          pool,
          keyId: key.id,
          provider: key.provider,
          label: key.label,
          event: 'success',
          message: `Completed in ${latency}ms${
            meta?.chunkIndex !== undefined ? ` (chunk #${meta.chunkIndex + 1})` : ''
          }`,
          chunkIndex: meta?.chunkIndex,
        });
        this.store.save();
        return { result, key, attempts, failovers };
      } catch (err) {
        const pErr =
          err instanceof ProviderCallError
            ? err
            : new ProviderCallError(err instanceof Error ? err.message : String(err), 500);

        const now = Date.now();
        key.errorCount++;
        key.consecutiveErrors++;
        key.lastError = pErr.message;
        key.lastLatencyMs = now - started;
        lastErrorMessage = pErr.message;
        lastStatus = pErr.statusCode;

        // Classify error for cooldown / circuit-breaker
        if (pErr.statusCode === 429) {
          const waitSec = pErr.retryAfterSec ?? Math.min(300, 30 * key.consecutiveErrors);
          key.status = 'cooldown';
          key.cooldownUntil = now + waitSec * 1000;
          if (pErr.isDailyQuota) {
            key.dailyExhaustedUntil = now + 6 * 3600 * 1000;
          }
        } else if (pErr.statusCode === 401 || pErr.statusCode === 403) {
          key.status = 'error';
          // Put auth-failed key into longer circuit-breaker cooldown so healthy keys take over immediately
          key.cooldownUntil = now + 10 * 60 * 1000;
        } else {
          // 5xx or timeout
          const waitSec = Math.min(180, 15 * Math.pow(2, Math.min(4, key.consecutiveErrors - 1)));
          key.status = key.consecutiveErrors >= 3 ? 'error' : 'cooldown';
          key.cooldownUntil = now + waitSec * 1000;
        }

        const hasNext = i < candidates.length - 1;
        if (hasNext) failovers++;

        this.store.appendLog({
          pool,
          keyId: key.id,
          provider: key.provider,
          label: key.label,
          event: hasNext ? 'failover' : 'error',
          statusCode: pErr.statusCode,
          message: hasNext
            ? `HTTP ${pErr.statusCode}: ${pErr.message} -> rotating silently to ${candidates[i + 1].label}`
            : `HTTP ${pErr.statusCode}: ${pErr.message}`,
          chunkIndex: meta?.chunkIndex,
        });
        this.store.save();

        // Retry automatically on 429, 401/403, 5xx, timeout
        if (!hasNext) {
          throw new ProviderCallError(lastErrorMessage, lastStatus);
        }
      }
    }

    throw new ProviderCallError(lastErrorMessage, lastStatus);
  }

  /**
   * Transcribes one or more audio chunks sequentially, performing seamless mid-recording
   * chunk handover across keys/providers if any chunk hits a rate limit or transient failure.
   */
  async transcribeChunks(
    chunks: NtkAudioChunkPayload[],
    language: string,
    customExecutor?: (key: NtkStoredKey, chunk: NtkAudioChunkPayload) => Promise<SttResult>
  ): Promise<{
    text: string;
    segments: NtkTranscriptSegment[];
    providersUsed: string[];
    failovers: number;
    chunkSummaries: Array<{ chunkIndex: number; provider: string; keyLabel: string }>;
  }> {
    const allSegments: NtkTranscriptSegment[] = [];
    const textParts: string[] = [];
    const providersUsed = new Set<string>();
    const chunkSummaries: Array<{ chunkIndex: number; provider: string; keyLabel: string }> = [];
    let totalFailovers = 0;

    for (const chunk of chunks) {
      const { result, key, failovers } = await this.executeWithFailover<SttResult>(
        'stt',
        (candidate) =>
          customExecutor
            ? customExecutor(candidate, chunk)
            : this.callSttProvider(candidate, chunk, language),
        { chunkIndex: chunk.chunkIndex }
      );
      totalFailovers += failovers;
      providersUsed.add(key.provider);
      chunkSummaries.push({
        chunkIndex: chunk.chunkIndex,
        provider: key.provider,
        keyLabel: key.label,
      });
      if (result.text.trim()) {
        textParts.push(result.text.trim());
      }
      for (const seg of result.segments) {
        allSegments.push({
          ...seg,
          provider: key.provider,
          chunkIndex: chunk.chunkIndex,
        });
      }
    }

    return {
      text: textParts.join(' ').trim(),
      segments: allSegments,
      providersUsed: Array.from(providersUsed),
      failovers: totalFailovers,
      chunkSummaries,
    };
  }

  async runIntelligence(
    transcript: string,
    prompt: string,
    options?: { targetLanguage?: string; buttonLabel?: string },
    customExecutor?: (key: NtkStoredKey) => Promise<LlmResult>
  ): Promise<LlmResult & { failovers: number }> {
    const { result, failovers } = await this.executeWithFailover<LlmResult>(
      'llm',
      (candidate) =>
        customExecutor
          ? customExecutor(candidate)
          : this.callLlmProvider(candidate, transcript, prompt, options)
    );
    return { ...result, failovers };
  }

  /**
   * Live provider adapters for STT Pool
   */
  async callSttProvider(
    key: NtkStoredKey,
    chunk: NtkAudioChunkPayload,
    language: string
  ): Promise<SttResult> {
    const audioBuf = Buffer.from(chunk.audioBase64, 'base64');
    const mime = chunk.mimeType || 'audio/wav';
    const ext = fileExtensionForMime(mime);
    const langCode = language && language !== 'auto' ? language.trim() : undefined;

    if (key.provider === 'gemini') {
      const ai = new GoogleGenAI({ apiKey: key.apiKey });
      const langHint = langCode ? ` Primary language: ${langCode}.` : '';
      try {
        const response = await ai.models.generateContent({
          model: key.model || 'gemini-2.5-flash',
          contents: {
            parts: [
              { inlineData: { mimeType: mime, data: chunk.audioBase64 } },
              {
                text: `Transcribe this audio clearly with natural punctuation and speaker labels if multiple speakers are clearly audible. Return only the spoken transcript.${langHint}`,
              },
            ],
          },
        });
        const text = (response.text ?? '').trim();
        return {
          text,
          segments: segmentTextFallback(
            text,
            chunk.offsetSeconds,
            chunk.durationSeconds,
            'gemini',
            chunk.chunkIndex
          ),
          provider: 'gemini',
          keyId: key.id,
          keyLabel: key.label,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = /429|RESOURCE_EXHAUSTED/i.test(msg)
          ? 429
          : /401|403|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg)
          ? 403
          : 502;
        throw new ProviderCallError(msg, code);
      }
    }

    if (key.provider === 'groq' || key.provider === 'mistral' || key.provider === 'custom_openai') {
      let endpoint = 'https://api.groq.com/openai/v1/audio/transcriptions';
      if (key.provider === 'mistral') {
        endpoint = 'https://api.mistral.ai/v1/audio/transcriptions';
      } else if (key.provider === 'custom_openai') {
        const check = validateExternalHttpsUrl(key.baseUrl || '');
        if (!check.valid || !check.normalized) {
          throw new ProviderCallError(check.error || 'Custom STT HTTPS URL is missing.', 400);
        }
        endpoint = check.normalized.endsWith('/audio/transcriptions')
          ? check.normalized
          : `${check.normalized}/audio/transcriptions`;
      }

      const form = new FormData();
      const blob = new Blob([audioBuf], { type: mime });
      form.append('file', blob, `chunk_${chunk.chunkIndex}.${ext}`);
      form.append('model', key.model || 'whisper-large-v3-turbo');
      form.append('response_format', 'verbose_json');
      if (langCode) form.append('language', langCode);

      const res = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key.apiKey}` },
        body: form,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => res.statusText);
        throw new ProviderCallError(errBody.slice(0, 220) || res.statusText, res.status, {
          retryAfterSec: parseRetryAfter(res.headers),
          isDailyQuota: /daily|quota/i.test(errBody),
        });
      }

      const json = (await res.json()) as {
        text?: string;
        segments?: Array<{ start?: number; end?: number; text?: string }>;
      };
      const text = (json.text || '').trim();
      const segments: NtkTranscriptSegment[] =
        Array.isArray(json.segments) && json.segments.length > 0
          ? json.segments
              .filter((s) => typeof s.text === 'string' && s.text.trim())
              .map((s, idx) => ({
                id: `ntk-${key.provider}-${chunk.chunkIndex}-${idx}`,
                start: Number(((s.start ?? 0) + chunk.offsetSeconds).toFixed(2)),
                end: Number(((s.end ?? (s.start ?? 0) + 1) + chunk.offsetSeconds).toFixed(2)),
                text: (s.text || '').trim(),
                provider: key.provider,
                chunkIndex: chunk.chunkIndex,
              }))
          : segmentTextFallback(
              text,
              chunk.offsetSeconds,
              chunk.durationSeconds,
              key.provider,
              chunk.chunkIndex
            );

      return { text, segments, provider: key.provider, keyId: key.id, keyLabel: key.label };
    }

    if (key.provider === 'deepgram') {
      const qs = new URLSearchParams({
        model: key.model || 'nova-3',
        smart_format: 'true',
        punctuate: 'true',
        diarize: 'true',
        utterances: 'true',
      });
      if (langCode) qs.set('language', langCode);
      else qs.set('detect_language', 'true');

      const res = await fetchWithTimeout(`https://api.deepgram.com/v1/listen?${qs.toString()}`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${key.apiKey}`,
          'Content-Type': mime,
        },
        body: audioBuf,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => res.statusText);
        throw new ProviderCallError(errBody.slice(0, 220) || res.statusText, res.status, {
          retryAfterSec: parseRetryAfter(res.headers),
        });
      }

      const json = (await res.json()) as {
        results?: {
          channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
          utterances?: Array<{
            start?: number;
            end?: number;
            transcript?: string;
            speaker?: number;
          }>;
        };
      };
      const text = (json.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
      const utterances = json.results?.utterances || [];
      const segments: NtkTranscriptSegment[] =
        utterances.length > 0
          ? utterances.map((u, idx) => ({
              id: `ntk-dg-${chunk.chunkIndex}-${idx}`,
              start: Number(((u.start ?? 0) + chunk.offsetSeconds).toFixed(2)),
              end: Number(((u.end ?? (u.start ?? 0) + 1) + chunk.offsetSeconds).toFixed(2)),
              text: (u.transcript || '').trim(),
              speaker: typeof u.speaker === 'number' ? `Speaker ${u.speaker + 1}` : undefined,
              provider: 'deepgram',
              chunkIndex: chunk.chunkIndex,
            }))
          : segmentTextFallback(
              text,
              chunk.offsetSeconds,
              chunk.durationSeconds,
              'deepgram',
              chunk.chunkIndex
            );

      return { text, segments, provider: 'deepgram', keyId: key.id, keyLabel: key.label };
    }

    if (key.provider === 'assemblyai') {
      // Step 1: Upload raw bytes
      const upRes = await fetchWithTimeout('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: {
          Authorization: key.apiKey,
          'Content-Type': 'application/octet-stream',
        },
        body: audioBuf,
      });
      if (!upRes.ok) {
        const errBody = await upRes.text().catch(() => upRes.statusText);
        throw new ProviderCallError(errBody.slice(0, 220) || upRes.statusText, upRes.status, {
          retryAfterSec: parseRetryAfter(upRes.headers),
        });
      }
      const { upload_url } = (await upRes.json()) as { upload_url?: string };
      if (!upload_url) throw new ProviderCallError('AssemblyAI upload URL missing', 502);

      // Step 2: Create transcript with speaker labels
      const createRes = await fetchWithTimeout('https://api.assemblyai.com/v2/transcript', {
        method: 'POST',
        headers: {
          Authorization: key.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audio_url: upload_url,
          speaker_labels: true,
          language_detection: !langCode,
          ...(langCode ? { language_code: langCode } : {}),
        }),
      });
      if (!createRes.ok) {
        const errBody = await createRes.text().catch(() => createRes.statusText);
        throw new ProviderCallError(errBody.slice(0, 220) || createRes.statusText, createRes.status);
      }
      const created = (await createRes.json()) as { id?: string };
      if (!created.id) throw new ProviderCallError('AssemblyAI transcript ID missing', 502);

      // Step 3: Poll up to 24s
      const pollDeadline = Date.now() + 24000;
      while (Date.now() < pollDeadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const pollRes = await fetchWithTimeout(
          `https://api.assemblyai.com/v2/transcript/${created.id}`,
          { headers: { Authorization: key.apiKey } },
          10000
        );
        if (!pollRes.ok) continue;
        const polled = (await pollRes.json()) as {
          status?: string;
          text?: string;
          error?: string;
          utterances?: Array<{ start?: number; end?: number; text?: string; speaker?: string }>;
        };
        if (polled.status === 'completed') {
          const text = (polled.text || '').trim();
          const segments: NtkTranscriptSegment[] =
            Array.isArray(polled.utterances) && polled.utterances.length > 0
              ? polled.utterances.map((u, idx) => ({
                  id: `ntk-aai-${chunk.chunkIndex}-${idx}`,
                  start: Number((((u.start ?? 0) / 1000) + chunk.offsetSeconds).toFixed(2)),
                  end: Number((((u.end ?? 1000) / 1000) + chunk.offsetSeconds).toFixed(2)),
                  text: (u.text || '').trim(),
                  speaker: u.speaker ? `Speaker ${u.speaker}` : undefined,
                  provider: 'assemblyai',
                  chunkIndex: chunk.chunkIndex,
                }))
              : segmentTextFallback(
                  text,
                  chunk.offsetSeconds,
                  chunk.durationSeconds,
                  'assemblyai',
                  chunk.chunkIndex
                );
          return { text, segments, provider: 'assemblyai', keyId: key.id, keyLabel: key.label };
        }
        if (polled.status === 'error') {
          throw new ProviderCallError(polled.error || 'AssemblyAI transcription failed', 502);
        }
      }
      throw new ProviderCallError('AssemblyAI polling timed out', 504);
    }

    if (key.provider === 'cloudflare') {
      if (!key.accountId?.trim()) {
        throw new ProviderCallError('Cloudflare Account ID is required.', 400);
      }
      const model = key.model || '@cf/openai/whisper-large-v3-turbo';
      const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
        key.accountId.trim()
      )}/ai/run/${model}`;
      const isTurbo = model.includes('turbo');
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key.apiKey}`,
          'Content-Type': isTurbo ? 'application/json' : 'application/octet-stream',
        },
        body: isTurbo
          ? JSON.stringify({
              audio: chunk.audioBase64,
              ...(langCode ? { language: langCode } : {}),
            })
          : audioBuf,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => res.statusText);
        throw new ProviderCallError(errBody.slice(0, 220) || res.statusText, res.status, {
          retryAfterSec: parseRetryAfter(res.headers),
        });
      }
      const json = (await res.json()) as {
        result?: { text?: string; segments?: Array<{ start?: number; end?: number; text?: string }> };
      };
      const text = (json.result?.text || '').trim();
      const segments =
        Array.isArray(json.result?.segments) && json.result.segments.length > 0
          ? json.result.segments.map((s, idx) => ({
              id: `ntk-cf-${chunk.chunkIndex}-${idx}`,
              start: Number(((s.start ?? 0) + chunk.offsetSeconds).toFixed(2)),
              end: Number(((s.end ?? (s.start ?? 0) + 1) + chunk.offsetSeconds).toFixed(2)),
              text: (s.text || '').trim(),
              provider: 'cloudflare',
              chunkIndex: chunk.chunkIndex,
            }))
          : segmentTextFallback(
              text,
              chunk.offsetSeconds,
              chunk.durationSeconds,
              'cloudflare',
              chunk.chunkIndex
            );
      return { text, segments, provider: 'cloudflare', keyId: key.id, keyLabel: key.label };
    }

    throw new ProviderCallError(`Unsupported STT provider: ${key.provider}`, 400);
  }

  /**
   * Live provider adapters for Text Intelligence Pool
   */
  async callLlmProvider(
    key: NtkStoredKey,
    transcript: string,
    prompt: string,
    options?: { targetLanguage?: string; buttonLabel?: string }
  ): Promise<LlmResult> {
    const langInstruction = options?.targetLanguage
      ? `\nTarget language: ${options.targetLanguage}.`
      : '';
    const fullUserPrompt = `${prompt}${langInstruction}\n\nTranscript:\n${transcript.slice(0, 32000)}`;
    const systemPrompt =
      'You are an everyday shared-office audio notes assistant. Reply in crisp, easy-to-read plain text or clean markdown bullet points with zero jargon.';

    if (key.provider === 'gemini') {
      const ai = new GoogleGenAI({ apiKey: key.apiKey });
      const model = key.model || 'gemini-2.5-flash';
      try {
        const response = await ai.models.generateContent({
          model,
          contents: fullUserPrompt,
          config: { systemInstruction: systemPrompt },
        });
        return {
          text: (response.text ?? '').trim(),
          provider: 'gemini',
          keyId: key.id,
          keyLabel: key.label,
          model,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = /429|RESOURCE_EXHAUSTED/i.test(msg)
          ? 429
          : /401|403|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg)
          ? 403
          : 502;
        throw new ProviderCallError(msg, code);
      }
    }

    if (key.provider === 'cloudflare') {
      if (!key.accountId?.trim()) {
        throw new ProviderCallError('Cloudflare Account ID is required.', 400);
      }
      const model = key.model || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
      const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
        key.accountId.trim()
      )}/ai/run/${model}`;
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: fullUserPrompt },
          ],
        }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => res.statusText);
        throw new ProviderCallError(errBody.slice(0, 220) || res.statusText, res.status, {
          retryAfterSec: parseRetryAfter(res.headers),
        });
      }
      const json = (await res.json()) as { result?: { response?: string } };
      return {
        text: (json.result?.response || '').trim(),
        provider: 'cloudflare',
        keyId: key.id,
        keyLabel: key.label,
        model,
      };
    }

    // OpenAI-compatible Chat providers: Groq, Cerebras, OpenRouter, Mistral, Custom
    const endpointMap: Record<string, string> = {
      groq: 'https://api.groq.com/openai/v1/chat/completions',
      cerebras: 'https://api.cerebras.ai/v1/chat/completions',
      openrouter: 'https://openrouter.ai/api/v1/chat/completions',
      mistral: 'https://api.mistral.ai/v1/chat/completions',
    };

    let endpoint = endpointMap[key.provider];
    if (key.provider === 'custom_openai') {
      const check = validateExternalHttpsUrl(key.baseUrl || '');
      if (!check.valid || !check.normalized) {
        throw new ProviderCallError(check.error || 'Custom Chat HTTPS URL is missing.', 400);
      }
      endpoint = check.normalized.endsWith('/chat/completions')
        ? check.normalized
        : `${check.normalized}/chat/completions`;
    }
    if (!endpoint) {
      throw new ProviderCallError(`Unsupported Text AI provider: ${key.provider}`, 400);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${key.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (key.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://ntk-studiowave.local';
      headers['X-Title'] = 'NTK Reorder Suite';
    }

    const res = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: key.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: fullUserPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => res.statusText);
      throw new ProviderCallError(errBody.slice(0, 220) || res.statusText, res.status, {
        retryAfterSec: parseRetryAfter(res.headers),
        isDailyQuota: /daily|quota/i.test(errBody),
      });
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = (json.choices?.[0]?.message?.content || '').trim();
    return {
      text,
      provider: key.provider,
      keyId: key.id,
      keyLabel: key.label,
      model: key.model,
    };
  }

  /**
   * Live lightweight health check for a single key (used by "Test All Keys" in Manager Console)
   */
  async testKey(key: NtkStoredKey): Promise<{ ok: boolean; status: NtkStoredKey['status']; latencyMs: number; message: string }> {
    const started = Date.now();
    try {
      if (key.provider === 'gemini') {
        const ai = new GoogleGenAI({ apiKey: key.apiKey });
        await ai.models.generateContent({
          model: 'gemini-2.5-flash-lite',
          contents: 'Reply with OK.',
        });
      } else if (key.provider === 'groq') {
        const r = await fetchWithTimeout('https://api.groq.com/openai/v1/models', {
          headers: { Authorization: `Bearer ${key.apiKey}` },
        }, 10000);
        if (!r.ok) throw new ProviderCallError(`HTTP ${r.status}`, r.status);
      } else if (key.provider === 'cerebras') {
        const r = await fetchWithTimeout('https://api.cerebras.ai/v1/models', {
          headers: { Authorization: `Bearer ${key.apiKey}` },
        }, 10000);
        if (!r.ok) throw new ProviderCallError(`HTTP ${r.status}`, r.status);
      } else if (key.provider === 'openrouter') {
        const r = await fetchWithTimeout('https://openrouter.ai/api/v1/auth/key', {
          headers: { Authorization: `Bearer ${key.apiKey}` },
        }, 10000);
        if (!r.ok) throw new ProviderCallError(`HTTP ${r.status}`, r.status);
      } else if (key.provider === 'mistral') {
        const r = await fetchWithTimeout('https://api.mistral.ai/v1/models', {
          headers: { Authorization: `Bearer ${key.apiKey}` },
        }, 10000);
        if (!r.ok) throw new ProviderCallError(`HTTP ${r.status}`, r.status);
      } else if (key.provider === 'deepgram') {
        const r = await fetchWithTimeout('https://api.deepgram.com/v1/projects', {
          headers: { Authorization: `Token ${key.apiKey}` },
        }, 10000);
        if (!r.ok) throw new ProviderCallError(`HTTP ${r.status}`, r.status);
      } else if (key.provider === 'assemblyai') {
        const r = await fetchWithTimeout('https://api.assemblyai.com/v2/transcript?limit=1', {
          headers: { Authorization: key.apiKey },
        }, 10000);
        if (!r.ok) throw new ProviderCallError(`HTTP ${r.status}`, r.status);
      } else if (key.provider === 'cloudflare') {
        if (!key.accountId?.trim()) {
          throw new ProviderCallError('Account ID required', 400);
        }
        const r = await fetchWithTimeout(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
            key.accountId.trim()
          )}/ai/models/search?per_page=1`,
          { headers: { Authorization: `Bearer ${key.apiKey}` } },
          10000
        );
        if (!r.ok) throw new ProviderCallError(`HTTP ${r.status}`, r.status);
      } else if (key.provider === 'custom_openai') {
        const check = validateExternalHttpsUrl(key.baseUrl || '');
        if (!check.valid || !check.normalized) {
          throw new ProviderCallError(check.error || 'Invalid custom URL', 400);
        }
        const modelsUrl = check.normalized.replace(/\/(chat\/completions|audio\/transcriptions)$/, '') + '/models';
        const r = await fetchWithTimeout(modelsUrl, {
          headers: { Authorization: `Bearer ${key.apiKey}` },
        }, 10000);
        if (!r.ok && r.status !== 404) throw new ProviderCallError(`HTTP ${r.status}`, r.status);
      }

      const latencyMs = Date.now() - started;
      key.status = 'ready';
      key.cooldownUntil = 0;
      key.dailyExhaustedUntil = 0;
      key.consecutiveErrors = 0;
      key.lastError = null;
      key.lastLatencyMs = latencyMs;
      this.store.appendLog({
        pool: key.pool,
        keyId: key.id,
        provider: key.provider,
        label: key.label,
        event: 'test_ok',
        message: `Key verified OK (${latencyMs}ms)`,
      });
      this.store.save();
      return { ok: true, status: 'ready', latencyMs, message: `Ready (${latencyMs}ms)` };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const pErr =
        err instanceof ProviderCallError
          ? err
          : new ProviderCallError(err instanceof Error ? err.message : String(err), 500);
      key.status = pErr.statusCode === 429 ? 'cooldown' : 'error';
      if (pErr.statusCode === 429) {
        key.cooldownUntil = Date.now() + (pErr.retryAfterSec ?? 60) * 1000;
      }
      key.lastError = pErr.message;
      key.lastLatencyMs = latencyMs;
      this.store.appendLog({
        pool: key.pool,
        keyId: key.id,
        provider: key.provider,
        label: key.label,
        event: 'test_fail',
        statusCode: pErr.statusCode,
        message: pErr.message,
      });
      this.store.save();
      return { ok: false, status: key.status, latencyMs, message: pErr.message };
    }
  }

  /**
   * Proxies audio to a configured free Hugging Face Gradio Space (HTDemucs) or custom stem API.
   * Strictly validates URL against SSRF before connecting.
   */
  async separateStems(audioBase64: string, mimeType: string): Promise<{
    stems: { vocals?: string; drums?: string; bass?: string; other?: string };
    source: string;
  }> {
    const data = this.store.getData();
    const rawUrl = data.workstation.stemSeparationUrl?.trim() || '';
    if (!rawUrl) {
      throw new ProviderCallError(
        'No Stem Separation API URL configured. Open Manage -> API Key Pool and paste your free Hugging Face HTDemucs Space URL.',
        503
      );
    }

    const check = validateExternalHttpsUrl(rawUrl);
    if (!check.valid || !check.normalized) {
      throw new ProviderCallError(check.error || 'Invalid Stem Separation URL.', 400);
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (data.stemApiToken?.trim()) {
      headers.Authorization = `Bearer ${data.stemApiToken.trim()}`;
    }

    const endpoint = check.normalized.includes('/api/')
      ? check.normalized
      : `${check.normalized}/api/predict`;

    const res = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          data: [`data:${mimeType || 'audio/wav'};base64,${audioBase64}`],
        }),
      },
      60000
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new ProviderCallError(
        `Stem Space returned HTTP ${res.status}: ${errText.slice(0, 180)}`,
        res.status
      );
    }

    const payload = (await res.json()) as {
      stems?: { vocals?: string; drums?: string; bass?: string; other?: string };
      data?: Array<string | { url?: string; data?: string }>;
    };

    if (payload.stems) {
      return { stems: payload.stems, source: check.normalized };
    }

    const list = Array.isArray(payload.data) ? payload.data : [];
    const pickAudio = (item: string | { url?: string; data?: string } | undefined): string | undefined => {
      if (!item) return undefined;
      if (typeof item === 'string') return item;
      return item.data || item.url;
    };

    return {
      stems: {
        vocals: pickAudio(list[0]),
        drums: pickAudio(list[1]),
        bass: pickAudio(list[2]),
        other: pickAudio(list[3]),
      },
      source: check.normalized,
    };
  }
}
