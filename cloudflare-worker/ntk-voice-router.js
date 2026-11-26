/**
 * NTK Reorder Suite — Standalone Cloudflare Worker Proxy Template
 * Deploy alongside a static build on Cloudflare Pages + Workers Free + KV.
 *
 * Required KV binding in wrangler.toml:
 *   [[kv_namespaces]]
 *   binding = "NTK_VOICE_KV"
 *   id = "<your-kv-namespace-id>"
 *
 * Optional Secrets (`wrangler secret put ...`):
 *   GROQ_API_KEYS, GEMINI_API_KEY, DEEPGRAM_API_KEYS, ASSEMBLYAI_API_KEYS,
 *   MISTRAL_API_KEYS, CEREBRAS_API_KEYS, OPENROUTER_API_KEYS,
 *   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, HF_DEMUCS_SPACE_URL
 */

const KV_KEY = 'ntk_voice_pool_state_v1';

const DEFAULT_STATE = {
  sttStrategy: 'round_robin',
  llmStrategy: 'round_robin',
  sttCursor: 0,
  llmCursor: 0,
  keys: [],
  dailyUsageDate: '',
  dailyAiRequests: 0,
  dailyAiRequestCap: 250,
  failoverLogs: [],
};

function jsonResponse(body, status = 200, corsOrigin = '*') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

function maskKey(secret, fromEnv = false) {
  if (!secret) return 'Not set';
  if (fromEnv) return `Server Env (••••${secret.slice(-4)})`;
  return secret.length > 8 ? `${secret.slice(0, 4)}••••${secret.slice(-4)}` : '••••••••';
}

function isSafeExternalHttps(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    if (
      h === 'localhost' ||
      h.endsWith('.local') ||
      h.endsWith('.internal') ||
      /^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function loadState(env) {
  let state = { ...DEFAULT_STATE };
  if (env.NTK_VOICE_KV) {
    const saved = await env.NTK_VOICE_KV.get(KV_KEY, { type: 'json' });
    if (saved) state = { ...state, ...saved };
  }

  // Merge comma-separated Worker secrets if present
  const envSpecs = [
    ['GEMINI_API_KEY', 'stt', 'gemini', 'Gemini Audio', 'gemini-2.5-flash'],
    ['GEMINI_API_KEY', 'llm', 'gemini', 'Gemini Flash', 'gemini-2.5-flash'],
    ['GROQ_API_KEYS', 'stt', 'groq', 'Groq Whisper', 'whisper-large-v3-turbo'],
    ['GROQ_API_KEYS', 'llm', 'groq', 'Groq LLM', 'llama-3.3-70b-versatile'],
    ['DEEPGRAM_API_KEYS', 'stt', 'deepgram', 'Deepgram Nova', 'nova-3'],
    ['CEREBRAS_API_KEYS', 'llm', 'cerebras', 'Cerebras LLM', 'llama-3.3-70b'],
    ['OPENROUTER_API_KEYS', 'llm', 'openrouter', 'OpenRouter Free', 'meta-llama/llama-3.3-70b-instruct:free'],
    ['MISTRAL_API_KEYS', 'stt', 'mistral', 'Mistral Voxtral', 'voxtral-mini-transcribe-2507'],
    ['MISTRAL_API_KEYS', 'llm', 'mistral', 'Mistral Small', 'mistral-small-latest'],
  ];

  let nextPriority = state.keys.length + 1;
  for (const [varName, pool, provider, labelPrefix, model] of envSpecs) {
    const raw = env[varName];
    if (!raw) continue;
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((apiKey, idx) => {
        const id = `env-${pool}-${provider}-${idx + 1}`;
        const existing = state.keys.find((k) => k.id === id);
        if (existing) {
          existing.apiKey = apiKey;
        } else {
          state.keys.push({
            id,
            pool,
            provider,
            label: `${labelPrefix} #${idx + 1}`,
            apiKey,
            model,
            enabled: true,
            priority: nextPriority++,
            fromEnv: true,
            status: 'ready',
            cooldownUntil: 0,
            consecutiveErrors: 0,
            requestCount: 0,
            successCount: 0,
            errorCount: 0,
          });
        }
      });
  }

  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyUsageDate !== today) {
    state.dailyUsageDate = today;
    state.dailyAiRequests = 0;
  }
  return state;
}

async function saveState(env, state) {
  if (!env.NTK_VOICE_KV) return;
  await env.NTK_VOICE_KV.put(KV_KEY, JSON.stringify(state));
}

function selectCandidates(state, pool) {
  const now = Date.now();
  const enabled = state.keys
    .filter((k) => k.pool === pool && k.enabled && k.apiKey)
    .sort((a, b) => a.priority - b.priority);

  const healthy = enabled.filter((k) => (k.cooldownUntil || 0) <= now);
  if (healthy.length === 0) return enabled;

  const strategy = pool === 'stt' ? state.sttStrategy : state.llmStrategy;
  if (strategy === 'round_robin' && healthy.length > 1) {
    const cursor = pool === 'stt' ? state.sttCursor : state.llmCursor;
    const start = cursor % healthy.length;
    if (pool === 'stt') state.sttCursor = (start + 1) % healthy.length;
    else state.llmCursor = (start + 1) % healthy.length;
    return [...healthy.slice(start), ...healthy.slice(0, start)];
  }
  return healthy;
}

async function executePool(state, pool, fn) {
  if (state.dailyAiRequestCap > 0 && state.dailyAiRequests >= state.dailyAiRequestCap) {
    throw { status: 429, message: 'Daily AI request cap reached.' };
  }
  const candidates = selectCandidates(state, pool);
  if (candidates.length === 0) {
    throw { status: 503, message: `No ${pool.toUpperCase()} keys configured in Worker.` };
  }

  let lastErr = { status: 502, message: 'All providers failed.' };
  for (let i = 0; i < candidates.length; i++) {
    const key = candidates[i];
    key.requestCount = (key.requestCount || 0) + 1;
    try {
      const result = await fn(key);
      key.successCount = (key.successCount || 0) + 1;
      key.status = 'ready';
      key.cooldownUntil = 0;
      key.consecutiveErrors = 0;
      state.dailyAiRequests++;
      return { result, key };
    } catch (err) {
      const status = err?.status || 502;
      const msg = err?.message || String(err);
      key.errorCount = (key.errorCount || 0) + 1;
      key.consecutiveErrors = (key.consecutiveErrors || 0) + 1;
      key.status = status === 429 ? 'cooldown' : 'error';
      const waitSec = status === 429 ? (err.retryAfter || 60) : Math.min(300, 30 * key.consecutiveErrors);
      key.cooldownUntil = Date.now() + waitSec * 1000;
      state.failoverLogs.unshift({
        timestamp: Date.now(),
        pool,
        label: key.label,
        status,
        message: msg,
      });
      state.failoverLogs = state.failoverLogs.slice(0, 40);
      lastErr = { status, message: msg };
    }
  }
  throw lastErr;
}

async function callOpenAiCompatibleChat(key, transcript, prompt) {
  const urls = {
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    cerebras: 'https://api.cerebras.ai/v1/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    mistral: 'https://api.mistral.ai/v1/chat/completions',
  };
  let url = urls[key.provider];
  if (key.provider === 'custom_openai') {
    if (!isSafeExternalHttps(key.baseUrl || '')) throw { status: 400, message: 'Unsafe custom URL' };
    url = key.baseUrl.endsWith('/chat/completions') ? key.baseUrl : `${key.baseUrl}/chat/completions`;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: key.model,
      messages: [
        { role: 'system', content: 'You are a clear, concise shared-office audio notes assistant.' },
        { role: 'user', content: `${prompt}\n\nTranscript:\n${transcript.slice(0, 32000)}` },
      ],
    }),
  });
  if (!res.ok) {
    throw {
      status: res.status,
      retryAfter: Number(res.headers.get('retry-after')) || undefined,
      message: (await res.text()).slice(0, 200),
    };
  }
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content?.trim() || '',
    provider: key.provider,
    model: key.model,
  };
}

async function callOpenAiCompatibleStt(key, chunk, language) {
  const bytes = Uint8Array.from(atob(chunk.audioBase64), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: chunk.mimeType || 'audio/wav' }), `chunk_${chunk.chunkIndex}.wav`);
  form.append('model', key.model || 'whisper-large-v3-turbo');
  form.append('response_format', 'verbose_json');
  if (language && language !== 'auto') form.append('language', language);

  let url =
    key.provider === 'mistral'
      ? 'https://api.mistral.ai/v1/audio/transcriptions'
      : 'https://api.groq.com/openai/v1/audio/transcriptions';

  if (key.provider === 'custom_openai') {
    if (!isSafeExternalHttps(key.baseUrl || '')) throw { status: 400, message: 'Unsafe custom URL' };
    url = key.baseUrl.endsWith('/audio/transcriptions')
      ? key.baseUrl
      : `${key.baseUrl}/audio/transcriptions`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key.apiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw {
      status: res.status,
      retryAfter: Number(res.headers.get('retry-after')) || undefined,
      message: (await res.text()).slice(0, 200),
    };
  }
  const json = await res.json();
  const offset = Number(chunk.offsetSeconds || 0);
  const segments = Array.isArray(json.segments)
    ? json.segments.map((s, idx) => ({
        id: `cfw-${chunk.chunkIndex}-${idx}`,
        start: Number(((s.start || 0) + offset).toFixed(2)),
        end: Number(((s.end || 1) + offset).toFixed(2)),
        text: (s.text || '').trim(),
        provider: key.provider,
      }))
    : [{ id: `cfw-${chunk.chunkIndex}-0`, start: offset, end: offset + Number(chunk.durationSeconds || 10), text: (json.text || '').trim(), provider: key.provider }];

  return { text: (json.text || '').trim(), segments, provider: key.provider };
}

export default {
  async fetch(request, env) {
    const corsOrigin = env.ALLOWED_ORIGIN || '*';
    if (request.method === 'OPTIONS') return jsonResponse({ ok: true }, 204, corsOrigin);

    const url = new URL(request.url);
    const state = await loadState(env);

    if (url.pathname === '/api/ntk-voice/config' && request.method === 'GET') {
      const sanitizedKeys = state.keys.map(({ apiKey, ...rest }) => ({
        ...rest,
        keyMask: maskKey(apiKey, rest.fromEnv),
      }));
      return jsonResponse({ ...state, keys: sanitizedKeys }, 200, corsOrigin);
    }

    if (url.pathname === '/api/ntk-voice/transcribe' && request.method === 'POST') {
      const body = await request.json();
      const chunks = Array.isArray(body.chunks) ? body.chunks : [];
      const segments = [];
      const textParts = [];
      const providersUsed = new Set();

      try {
        for (const chunk of chunks) {
          const { result, key } = await executePool(state, 'stt', (k) =>
            callOpenAiCompatibleStt(k, chunk, body.language || 'auto')
          );
          providersUsed.add(key.provider);
          if (result.text) textParts.push(result.text);
          segments.push(...result.segments);
        }
        await saveState(env, state);
        return jsonResponse(
          { text: textParts.join(' '), segments, providersUsed: Array.from(providersUsed) },
          200,
          corsOrigin
        );
      } catch (err) {
        await saveState(env, state);
        return jsonResponse({ error: err?.message || 'Transcription failed' }, err?.status || 502, corsOrigin);
      }
    }

    if (url.pathname === '/api/ntk-voice/intelligence' && request.method === 'POST') {
      const body = await request.json();
      try {
        const { result } = await executePool(state, 'llm', (k) =>
          callOpenAiCompatibleChat(k, body.transcript || '', body.prompt || 'Summarize concisely.')
        );
        await saveState(env, state);
        return jsonResponse(result, 200, corsOrigin);
      } catch (err) {
        await saveState(env, state);
        return jsonResponse({ error: err?.message || 'AI Notes failed' }, err?.status || 502, corsOrigin);
      }
    }

    return jsonResponse({ error: 'Not found' }, 404, corsOrigin);
  },
};
