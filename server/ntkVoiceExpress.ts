import express from 'express';
import {
  DEFAULT_AI_BUTTONS,
  DEFAULT_VISIBILITY,
  DEFAULT_WORKSTATION,
  NtkVoiceStore,
  PROVIDER_CATALOG,
  validateExternalHttpsUrl,
} from './ntkVoiceStore';
import { NtkVoiceRouter, ProviderCallError } from './ntkVoiceRouter';
import type {
  NtkAudioChunkPayload,
  NtkPoolType,
  NtkProviderId,
  NtkRotationStrategy,
  NtkStoredKey,
} from './ntkVoiceTypes';

const VALID_POOLS: NtkPoolType[] = ['stt', 'llm'];
const VALID_STRATEGIES: NtkRotationStrategy[] = ['round_robin', 'priority_failover'];

export function createNtkVoiceRouter(store = new NtkVoiceStore(true)) {
  const router = express.Router();
  const engine = new NtkVoiceRouter(store);

  // GET /api/ntk-voice/config — sanitized snapshot (never leaks raw API keys)
  router.get('/config', (_req, res) => {
    res.json(store.getPublicSnapshot());
  });

  // PUT /api/ntk-voice/config — update strategies, visibility matrix, AI buttons, workstation settings
  router.put('/config', (req, res) => {
    const body = req.body ?? {};
    const data = store.getData();

    if (body.sttStrategy && VALID_STRATEGIES.includes(body.sttStrategy)) {
      data.sttStrategy = body.sttStrategy;
    }
    if (body.llmStrategy && VALID_STRATEGIES.includes(body.llmStrategy)) {
      data.llmStrategy = body.llmStrategy;
    }

    if (body.visibility && typeof body.visibility === 'object') {
      const nextVis = { ...data.visibility };
      for (const k of Object.keys(DEFAULT_VISIBILITY) as Array<keyof typeof DEFAULT_VISIBILITY>) {
        if (typeof body.visibility[k] === 'boolean') {
          nextVis[k] = body.visibility[k];
        }
      }
      data.visibility = nextVis;
    }

    if (Array.isArray(body.aiButtons) && body.aiButtons.length > 0 && body.aiButtons.length <= 6) {
      data.aiButtons = body.aiButtons.map((b: Record<string, unknown>, idx: number) => ({
        id: typeof b.id === 'string' && b.id.trim() ? b.id.trim().slice(0, 48) : `btn-custom-${idx + 1}`,
        label:
          typeof b.label === 'string' && b.label.trim()
            ? b.label.trim().slice(0, 40)
            : DEFAULT_AI_BUTTONS[idx]?.label || `Action ${idx + 1}`,
        description:
          typeof b.description === 'string' ? b.description.trim().slice(0, 140) : '',
        kind: b.kind === 'transcribe' ? 'transcribe' : 'intelligence',
        prompt: typeof b.prompt === 'string' ? b.prompt.trim().slice(0, 1200) : '',
        enabled: typeof b.enabled === 'boolean' ? b.enabled : true,
        targetLanguage:
          typeof b.targetLanguage === 'string' ? b.targetLanguage.trim().slice(0, 40) : undefined,
      }));
    }

    if (body.workstation && typeof body.workstation === 'object') {
      const ws = body.workstation as Record<string, unknown>;
      if (typeof ws.suiteName === 'string' && ws.suiteName.trim()) {
        data.workstation.suiteName = ws.suiteName.trim().slice(0, 60);
      }
      if (typeof ws.welcomeMessage === 'string') {
        data.workstation.welcomeMessage = ws.welcomeMessage.trim().slice(0, 180);
      }
      if (typeof ws.defaultLanguage === 'string' && ws.defaultLanguage.trim()) {
        data.workstation.defaultLanguage = ws.defaultLanguage.trim().slice(0, 24);
      }
      if (typeof ws.maxRecordingMinutes === 'number' && Number.isFinite(ws.maxRecordingMinutes)) {
        data.workstation.maxRecordingMinutes = Math.max(5, Math.min(240, Math.round(ws.maxRecordingMinutes)));
      }
      if (typeof ws.autoStopSilenceSec === 'number' && Number.isFinite(ws.autoStopSilenceSec)) {
        data.workstation.autoStopSilenceSec = Math.max(0, Math.min(600, Math.round(ws.autoStopSilenceSec)));
      }
      if (ws.retentionPolicy === '24h' || ws.retentionPolicy === '7d' || ws.retentionPolicy === 'manual') {
        data.workstation.retentionPolicy = ws.retentionPolicy;
      }
      if (typeof ws.dailyAiRequestCap === 'number' && Number.isFinite(ws.dailyAiRequestCap)) {
        data.workstation.dailyAiRequestCap = Math.max(0, Math.min(50000, Math.round(ws.dailyAiRequestCap)));
      }
      if (typeof ws.stemSeparationUrl === 'string') {
        const check = validateExternalHttpsUrl(ws.stemSeparationUrl);
        if (!check.valid) {
          res.status(400).json({ error: check.error });
          return;
        }
        data.workstation.stemSeparationUrl = check.normalized ?? '';
      }
      if (typeof ws.stemApiToken === 'string') {
        data.stemApiToken = ws.stemApiToken.trim() || undefined;
      }
    }

    store.save();
    res.json(store.getPublicSnapshot());
  });

  // POST /api/ntk-voice/keys — add a new key to STT or Text AI pool
  router.post('/keys', (req, res) => {
    const body = req.body ?? {};
    const pool = body.pool as NtkPoolType;
    const provider = body.provider as NtkProviderId;
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';
    const model = typeof body.model === 'string' ? body.model.trim().slice(0, 120) : '';
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim().slice(0, 80) : undefined;
    const baseUrlRaw = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';

    if (!VALID_POOLS.includes(pool)) {
      res.status(400).json({ error: 'Pool must be "stt" or "llm".' });
      return;
    }

    const catalogEntry = PROVIDER_CATALOG[pool].find((p) => p.id === provider);
    if (!catalogEntry) {
      res.status(400).json({ error: `Unknown provider "${provider}" for ${pool} pool.` });
      return;
    }

    if (apiKey.length < 6) {
      res.status(400).json({ error: 'Please enter a valid API key.' });
      return;
    }

    if (catalogEntry.needsAccountId && !accountId) {
      res.status(400).json({ error: `${catalogEntry.name} requires your Cloudflare Account ID.` });
      return;
    }

    let normalizedBaseUrl: string | undefined;
    if (catalogEntry.needsBaseUrl) {
      const check = validateExternalHttpsUrl(baseUrlRaw);
      if (!check.valid || !check.normalized) {
        res.status(400).json({ error: check.error || 'A valid HTTPS base URL is required.' });
        return;
      }
      normalizedBaseUrl = check.normalized;
    }

    const data = store.getData();
    const poolKeys = data.keys.filter((k) => k.pool === pool);
    const maxPriority = poolKeys.reduce((m, k) => Math.max(m, k.priority), 0);

    const newKey: NtkStoredKey = {
      id: `key-${pool}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      pool,
      provider,
      label: label || `${catalogEntry.name} #${poolKeys.filter((k) => k.provider === provider).length + 1}`,
      apiKey,
      accountId,
      baseUrl: normalizedBaseUrl,
      model: model || catalogEntry.defaultModel,
      enabled: true,
      priority: maxPriority + 1,
      fromEnv: false,
      status: 'ready',
      cooldownUntil: 0,
      dailyExhaustedUntil: 0,
      consecutiveErrors: 0,
      requestCount: 0,
      successCount: 0,
      errorCount: 0,
      lastError: null,
      lastLatencyMs: null,
      lastUsedAt: null,
    };

    data.keys.push(newKey);
    store.save();
    res.status(201).json(store.getPublicSnapshot());
  });

  // PUT /api/ntk-voice/keys/:id — update key metadata, enabled state, or replace secret
  router.put('/keys/:id', (req, res) => {
    const data = store.getData();
    const key = data.keys.find((k) => k.id === req.params.id);
    if (!key) {
      res.status(404).json({ error: 'Key not found.' });
      return;
    }
    const body = req.body ?? {};
    if (typeof body.label === 'string' && body.label.trim()) {
      key.label = body.label.trim().slice(0, 60);
    }
    if (typeof body.model === 'string' && body.model.trim()) {
      key.model = body.model.trim().slice(0, 120);
    }
    if (typeof body.enabled === 'boolean') {
      key.enabled = body.enabled;
      if (body.enabled && key.status === 'disabled') key.status = 'ready';
      if (!body.enabled) key.status = 'disabled';
    }
    if (typeof body.accountId === 'string') {
      key.accountId = body.accountId.trim().slice(0, 80) || undefined;
    }
    if (typeof body.baseUrl === 'string' && key.provider === 'custom_openai') {
      const check = validateExternalHttpsUrl(body.baseUrl);
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }
      key.baseUrl = check.normalized || undefined;
    }
    if (typeof body.apiKey === 'string' && body.apiKey.trim().length >= 6 && !key.fromEnv) {
      key.apiKey = body.apiKey.trim();
      key.status = 'ready';
      key.cooldownUntil = 0;
      key.consecutiveErrors = 0;
      key.lastError = null;
    }
    if (body.clearCooldown === true) {
      key.status = key.enabled ? 'ready' : 'disabled';
      key.cooldownUntil = 0;
      key.dailyExhaustedUntil = 0;
      key.consecutiveErrors = 0;
      key.lastError = null;
    }
    store.save();
    res.json(store.getPublicSnapshot());
  });

  // DELETE /api/ntk-voice/keys/:id
  router.delete('/keys/:id', (req, res) => {
    const data = store.getData();
    const idx = data.keys.findIndex((k) => k.id === req.params.id);
    if (idx < 0) {
      res.status(404).json({ error: 'Key not found.' });
      return;
    }
    if (data.keys[idx].fromEnv) {
      // Server-env keys can be disabled rather than deleted so env sync stays clean
      data.keys[idx].enabled = false;
      data.keys[idx].status = 'disabled';
    } else {
      data.keys.splice(idx, 1);
    }
    store.save();
    res.json(store.getPublicSnapshot());
  });

  // POST /api/ntk-voice/keys/reorder — update key priority ordering within a pool
  router.post('/keys/reorder', (req, res) => {
    const { pool, orderedIds } = req.body ?? {};
    if (!VALID_POOLS.includes(pool) || !Array.isArray(orderedIds)) {
      res.status(400).json({ error: 'Valid pool and orderedIds array are required.' });
      return;
    }
    const data = store.getData();
    orderedIds.forEach((id: unknown, idx: number) => {
      if (typeof id !== 'string') return;
      const found = data.keys.find((k) => k.id === id && k.pool === pool);
      if (found) found.priority = idx + 1;
    });
    store.save();
    res.json(store.getPublicSnapshot());
  });

  // POST /api/ntk-voice/keys/test — live health probe for all enabled keys or one specific key
  router.post('/keys/test', async (req, res) => {
    const { keyId } = req.body ?? {};
    const data = store.getData();
    const targets =
      typeof keyId === 'string' && keyId
        ? data.keys.filter((k) => k.id === keyId)
        : data.keys.filter((k) => k.enabled);

    const results = await Promise.all(
      targets.map(async (k) => ({
        id: k.id,
        label: k.label,
        provider: k.provider,
        pool: k.pool,
        ...(await engine.testKey(k)),
      }))
    );

    // Optional stem endpoint reachability check
    let stemStatus: { configured: boolean; ok: boolean; message: string } = {
      configured: Boolean(data.workstation.stemSeparationUrl?.trim()),
      ok: false,
      message: 'Not configured',
    };
    if (data.workstation.stemSeparationUrl?.trim()) {
      const check = validateExternalHttpsUrl(data.workstation.stemSeparationUrl);
      if (check.valid && check.normalized) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 7000);
          const r = await fetch(check.normalized, { method: 'HEAD', signal: ctrl.signal });
          clearTimeout(t);
          stemStatus = {
            configured: true,
            ok: r.ok || r.status === 405,
            message: r.ok || r.status === 405 ? 'Reachable' : `HTTP ${r.status}`,
          };
        } catch {
          stemStatus = { configured: true, ok: false, message: 'Space unreachable or sleeping' };
        }
      }
    }

    res.json({
      results,
      stemStatus,
      snapshot: store.getPublicSnapshot(),
    });
  });

  // POST /api/ntk-voice/transcribe — multi-chunk STT with seamless mid-recording failover
  router.post('/transcribe', async (req, res) => {
    const body = req.body ?? {};
    const language =
      typeof body.language === 'string' && body.language.trim()
        ? body.language.trim()
        : store.getData().workstation.defaultLanguage;

    let chunks: NtkAudioChunkPayload[] = [];
    if (Array.isArray(body.chunks) && body.chunks.length > 0) {
      chunks = body.chunks
        .filter((c: Record<string, unknown>) => typeof c?.audioBase64 === 'string' && c.audioBase64.length >= 32)
        .slice(0, 24)
        .map((c: Record<string, unknown>, idx: number) => ({
          chunkIndex: typeof c.chunkIndex === 'number' ? c.chunkIndex : idx,
          offsetSeconds: typeof c.offsetSeconds === 'number' ? Math.max(0, c.offsetSeconds) : 0,
          durationSeconds: typeof c.durationSeconds === 'number' ? Math.max(1, c.durationSeconds) : 15,
          audioBase64: String(c.audioBase64),
          mimeType: typeof c.mimeType === 'string' ? c.mimeType : 'audio/wav',
        }));
    } else if (typeof body.audioBase64 === 'string' && body.audioBase64.length >= 32) {
      chunks = [
        {
          chunkIndex: 0,
          offsetSeconds: 0,
          durationSeconds: Number(body.durationSeconds) || 15,
          audioBase64: body.audioBase64,
          mimeType: typeof body.mimeType === 'string' ? body.mimeType : 'audio/wav',
        },
      ];
    }

    if (chunks.length === 0) {
      res.status(400).json({ error: 'Valid audio chunk payload is required.' });
      return;
    }

    try {
      const result = await engine.transcribeChunks(chunks, language);
      res.json({
        ...result,
        snapshotSummary: store.getPublicSnapshot().summary,
      });
    } catch (err) {
      const pErr =
        err instanceof ProviderCallError
          ? err
          : new ProviderCallError(err instanceof Error ? err.message : 'Transcription failed', 502);
      res.status(pErr.statusCode).json({ error: pErr.message });
    }
  });

  // POST /api/ntk-voice/intelligence — text summaries, action items, formal email, translation
  router.post('/intelligence', async (req, res) => {
    const body = req.body ?? {};
    const transcript = typeof body.transcript === 'string' ? body.transcript.trim() : '';
    if (transcript.length < 4) {
      res.status(400).json({ error: 'Transcribe the recording or add text first.' });
      return;
    }

    const data = store.getData();
    const matchedButton =
      typeof body.buttonId === 'string'
        ? data.aiButtons.find((b) => b.id === body.buttonId)
        : undefined;

    const prompt =
      (typeof body.prompt === 'string' && body.prompt.trim()) ||
      matchedButton?.prompt ||
      'Summarize this recording clearly in 3-5 plain bullet points.';
    const targetLanguage =
      (typeof body.targetLanguage === 'string' && body.targetLanguage.trim()) ||
      matchedButton?.targetLanguage;

    try {
      const result = await engine.runIntelligence(transcript, prompt, {
        targetLanguage,
        buttonLabel: matchedButton?.label,
      });
      res.json({
        ...result,
        buttonId: matchedButton?.id || body.buttonId || 'custom',
        buttonLabel: matchedButton?.label || body.buttonLabel || 'AI Notes',
      });
    } catch (err) {
      const pErr =
        err instanceof ProviderCallError
          ? err
          : new ProviderCallError(err instanceof Error ? err.message : 'AI notes failed', 502);
      res.status(pErr.statusCode).json({ error: pErr.message });
    }
  });

  // POST /api/ntk-voice/stems — optional Hugging Face HTDemucs / custom stem separation proxy
  router.post('/stems', async (req, res) => {
    const { audioBase64, mimeType } = req.body ?? {};
    if (typeof audioBase64 !== 'string' || audioBase64.length < 32) {
      res.status(400).json({ error: 'Valid audio payload is required for stem separation.' });
      return;
    }
    try {
      const result = await engine.separateStems(
        audioBase64,
        typeof mimeType === 'string' ? mimeType : 'audio/wav'
      );
      res.json(result);
    } catch (err) {
      const pErr =
        err instanceof ProviderCallError
          ? err
          : new ProviderCallError(err instanceof Error ? err.message : 'Stem separation failed', 502);
      res.status(pErr.statusCode).json({ error: pErr.message });
    }
  });

  // POST /api/ntk-voice/reset-stats — clear logs & reset daily usage counter
  router.post('/reset-stats', (_req, res) => {
    const data = store.getData();
    data.dailyAiRequests = 0;
    data.failoverLogs = [];
    data.keys.forEach((k) => {
      k.cooldownUntil = 0;
      k.dailyExhaustedUntil = 0;
      k.consecutiveErrors = 0;
      k.lastError = null;
      if (k.enabled) k.status = 'ready';
    });
    store.save();
    res.json(store.getPublicSnapshot());
  });

  // POST /api/ntk-voice/reset-defaults — restore default visibility/buttons/workstation settings
  router.post('/reset-defaults', (_req, res) => {
    const data = store.getData();
    data.visibility = { ...DEFAULT_VISIBILITY };
    data.aiButtons = DEFAULT_AI_BUTTONS.map((b) => ({ ...b }));
    data.workstation = {
      ...DEFAULT_WORKSTATION,
      stemSeparationUrl: data.workstation.stemSeparationUrl,
    };
    store.save();
    res.json(store.getPublicSnapshot());
  });

  return router;
}
