import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import type {
  NtkCustomAiButton,
  NtkFailoverLogEntry,
  NtkPoolType,
  NtkProviderId,
  NtkPublicKey,
  NtkStoredKey,
  NtkVisibilityMatrix,
  NtkVoiceStoreData,
  NtkWorkstationSettings,
} from './ntkVoiceTypes';

export const DEFAULT_VISIBILITY: NtkVisibilityMatrix = {
  aiFeaturesEnabled: false, // AI & API keys are 100% optional (OFF by default)
  showAdvancedToggle: true,
  meetingAudioCapture: true,
  liveEqConsole: true,
  aiStemMixer: true, // Now 100% offline rule-based (plus optional cloud HTDemucs)
  waveformTrimmer: true,
  momentFlags: true,
  multiFormatExport: true,
  defaultNoisePolish: true,
  optionalProfiles: false, // Guest / Shared Office mode by default
  localBrowserWhisperFallback: false, // Disabled by default for low-RAM PCs
};

export const DEFAULT_AI_BUTTONS: NtkCustomAiButton[] = [
  {
    id: 'btn-transcribe',
    label: 'Get Text',
    description: 'Turn speech into clean, clickable text with timestamps.',
    kind: 'transcribe',
    prompt: 'Transcribe accurately with clear punctuation and speaker turns when audible.',
    enabled: true,
  },
  {
    id: 'btn-summary',
    label: 'Short Summary',
    description: '3–5 clear bullet points so anyone can catch up in 20 seconds.',
    kind: 'intelligence',
    prompt:
      'Summarize this office recording into 3 to 5 short, crystal-clear bullet points using plain everyday English.',
    enabled: true,
  },
  {
    id: 'btn-actions',
    label: 'Action Items',
    description: 'List every task, decision, owner, and deadline mentioned.',
    kind: 'intelligence',
    prompt:
      'Extract every concrete action item, decision, assigned person (if mentioned), and deadline as a neat checklist.',
    enabled: true,
  },
  {
    id: 'btn-formal-email',
    label: 'Clean Formal Email',
    description: 'Fix grammar and turn spoken notes into a polished office email.',
    kind: 'intelligence',
    prompt:
      'Remove filler words, fix grammar, and rewrite this recording as a polite, ready-to-send formal office email with a concise Subject line.',
    enabled: true,
  },
  {
    id: 'btn-translate',
    label: 'Translate Notes',
    description: 'Translate transcript cleanly into your selected target language.',
    kind: 'intelligence',
    prompt:
      'Translate this transcript naturally and accurately into the requested target language while keeping professional office tone.',
    enabled: false,
    targetLanguage: 'Spanish',
  },
];

export const DEFAULT_WORKSTATION: NtkWorkstationSettings = {
  suiteName: 'NTK Reorder Suite',
  welcomeMessage: '1. Tap Record • 2. Speak normally • 3. Play, edit, or save',
  defaultLanguage: 'auto',
  maxRecordingMinutes: 60,
  autoStopSilenceSec: 0,
  retentionPolicy: '7d',
  dailyAiRequestCap: 250,
  stemSeparationUrl: process.env.HF_DEMUCS_SPACE_URL?.trim() || '',
};

export const PROVIDER_CATALOG: Record<
  NtkPoolType,
  Array<{
    id: NtkProviderId;
    name: string;
    defaultModel: string;
    models: string[];
    needsAccountId?: boolean;
    needsBaseUrl?: boolean;
    supportsDiarization?: boolean;
    freeTierNote: string;
  }>
> = {
  stt: [
    {
      id: 'groq',
      name: 'Groq Whisper',
      defaultModel: 'whisper-large-v3-turbo',
      models: ['whisper-large-v3-turbo', 'whisper-large-v3'],
      freeTierNote: 'Ultra-fast free Whisper API (~2,000 req/day per key)',
    },
    {
      id: 'gemini',
      name: 'Google Gemini API',
      defaultModel: 'gemini-2.5-flash',
      models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
      freeTierNote: 'Built-in server Gemini audio transcription',
    },
    {
      id: 'deepgram',
      name: 'Deepgram Nova',
      defaultModel: 'nova-3',
      models: ['nova-3', 'nova-2'],
      supportsDiarization: true,
      freeTierNote: 'Free credit tier with speaker diarization',
    },
    {
      id: 'assemblyai',
      name: 'AssemblyAI',
      defaultModel: 'universal-2',
      models: ['universal-2', 'nano'],
      supportsDiarization: true,
      freeTierNote: 'Free speech hours + automatic speaker labels',
    },
    {
      id: 'cloudflare',
      name: 'Cloudflare Workers AI',
      defaultModel: '@cf/openai/whisper-large-v3-turbo',
      models: ['@cf/openai/whisper-large-v3-turbo', '@cf/openai/whisper'],
      needsAccountId: true,
      freeTierNote: '10,000 free daily neurons with Account ID + API Token',
    },
    {
      id: 'mistral',
      name: 'Mistral AI Voxtral',
      defaultModel: 'voxtral-mini-transcribe-2507',
      models: ['voxtral-mini-transcribe-2507', 'voxtral-mini-latest'],
      freeTierNote: 'Free experiment tier for Voxtral transcription',
    },
    {
      id: 'custom_openai',
      name: 'Custom OpenAI-Compatible STT',
      defaultModel: 'whisper-1',
      models: ['whisper-1'],
      needsBaseUrl: true,
      freeTierNote: 'Any HTTPS OpenAI `/audio/transcriptions` endpoint',
    },
  ],
  llm: [
    {
      id: 'gemini',
      name: 'Google Gemini API',
      defaultModel: 'gemini-2.5-flash',
      models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
      freeTierNote: 'Built-in server Gemini Flash & Flash-Lite',
    },
    {
      id: 'groq',
      name: 'Groq LLMs',
      defaultModel: 'llama-3.3-70b-versatile',
      models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'qwen/qwen3-32b'],
      freeTierNote: 'Ultra-fast free LLM tokens per minute per key',
    },
    {
      id: 'cerebras',
      name: 'Cerebras Free Tier',
      defaultModel: 'llama-3.3-70b',
      models: ['llama-3.3-70b', 'qwen-3-32b'],
      freeTierNote: 'OpenAI-compatible high-speed free inference',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter (:free)',
      defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
      models: [
        'meta-llama/llama-3.3-70b-instruct:free',
        'qwen/qwen3-32b:free',
        'mistralai/mistral-small-3.1-24b-instruct:free',
      ],
      freeTierNote: 'Free-tier `:free` open-weight models',
    },
    {
      id: 'cloudflare',
      name: 'Cloudflare Workers AI',
      defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      models: [
        '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        '@cf/mistral/mistral-7b-instruct-v0.2-lora',
        '@cf/qwen/qwen1.5-14b-chat-awq',
      ],
      needsAccountId: true,
      freeTierNote: '10,000 free daily neurons with Account ID + API Token',
    },
    {
      id: 'mistral',
      name: 'Mistral AI',
      defaultModel: 'mistral-small-latest',
      models: ['mistral-small-latest', 'open-mistral-nemo'],
      freeTierNote: 'Free experiment tier for Mistral chat models',
    },
    {
      id: 'custom_openai',
      name: 'Custom OpenAI-Compatible Chat',
      defaultModel: 'gpt-4o-mini',
      models: ['gpt-4o-mini'],
      needsBaseUrl: true,
      freeTierNote: 'Any HTTPS OpenAI `/chat/completions` endpoint',
    },
  ],
};

const DEFAULT_STORE_DIR = path.resolve(process.cwd(), 'data');

let runtimeFallbackSecret: Buffer | null = null;

function resolveEncryptionKey(storeDir: string, persistToDisk: boolean): Buffer {
  const envSecret = process.env.NTK_VOICE_STORE_SECRET || process.env.GEMINI_API_KEY;
  if (envSecret && envSecret.trim()) {
    return crypto.createHash('sha256').update(`ntk-voice-v1:${envSecret.trim()}`).digest();
  }
  if (persistToDisk) {
    const secretFile = path.join(storeDir, '.store-secret');
    try {
      if (fs.existsSync(secretFile)) {
        const existing = fs.readFileSync(secretFile, 'utf8').trim();
        if (existing.length >= 32) {
          return crypto.createHash('sha256').update(`ntk-voice-v1:${existing}`).digest();
        }
      }
      fs.mkdirSync(storeDir, { recursive: true });
      const generated = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(secretFile, generated, { mode: 0o600 });
      return crypto.createHash('sha256').update(`ntk-voice-v1:${generated}`).digest();
    } catch {
      // Fall through to in-memory secret in read-only environments
    }
  }
  if (!runtimeFallbackSecret) {
    runtimeFallbackSecret = crypto.randomBytes(32);
  }
  return runtimeFallbackSecret;
}

function encryptText(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decryptText(payload: string, key: Buffer): string | null {
  try {
    const [ivB64, tagB64, dataB64] = payload.split('.');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivB64, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}

export function maskSecret(secret: string | undefined, fromEnv?: boolean): string {
  if (!secret || !secret.trim()) return fromEnv ? 'Server Env' : 'Not set';
  const trimmed = secret.trim();
  if (fromEnv) {
    const tail = trimmed.length >= 4 ? trimmed.slice(-4) : '••••';
    return `Server Env (••••${tail})`;
  }
  if (trimmed.length <= 8) return '••••••••';
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

/**
 * Strict SSRF validator for user-supplied custom endpoint URLs and Hugging Face Space URLs.
 * Allows only public HTTPS URLs and blocks loopback, RFC1918 private networks, and cloud metadata IPs.
 */
export function validateExternalHttpsUrl(rawUrl: string): { valid: boolean; normalized?: string; error?: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { valid: true, normalized: '' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Please enter a valid HTTPS URL.' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'Only secure HTTPS URLs are permitted for external API endpoints.' };
  }

  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80:')
  ) {
    return { valid: false, error: 'Private, loopback, or internal hostnames are not permitted.' };
  }

  const ipType = net.isIP(host);
  if (ipType === 4) {
    const parts = host.split('.').map(Number);
    const [a, b] = parts;
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return { valid: false, error: 'Private or link-local IP addresses are not permitted.' };
    }
  } else if (ipType === 6) {
    return { valid: false, error: 'Direct IPv6 literal addresses are not permitted.' };
  }

  return { valid: true, normalized: parsed.toString().replace(/\/+$/, '') };
}

function todayDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildEnvSeededKeys(): NtkStoredKey[] {
  const keys: NtkStoredKey[] = [];
  let priorityCounter = 1;

  const addKeysFromCsv = (
    envName: string,
    pool: NtkPoolType,
    provider: NtkProviderId,
    labelPrefix: string,
    model: string,
    accountId?: string
  ) => {
    const raw = process.env[envName];
    if (!raw || !raw.trim()) return;
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    parts.forEach((apiKey, idx) => {
      keys.push({
        id: `env-${pool}-${provider}-${idx + 1}`,
        pool,
        provider,
        label: parts.length > 1 ? `${labelPrefix} (Env #${idx + 1})` : `${labelPrefix} (Server Env)`,
        apiKey,
        accountId,
        model,
        enabled: true,
        priority: priorityCounter++,
        fromEnv: true,
        envVarName: envName,
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
      });
    });
  };

  // Seed built-in Gemini server key automatically into both pools
  addKeysFromCsv('GEMINI_API_KEY', 'stt', 'gemini', 'Gemini Audio', 'gemini-2.5-flash');
  addKeysFromCsv('GEMINI_API_KEY', 'llm', 'gemini', 'Gemini Flash', 'gemini-2.5-flash');

  // Optional free-tier pools configured in server environment
  addKeysFromCsv('GROQ_API_KEYS', 'stt', 'groq', 'Groq Whisper', 'whisper-large-v3-turbo');
  addKeysFromCsv('GROQ_API_KEYS', 'llm', 'groq', 'Groq LLM', 'llama-3.3-70b-versatile');
  addKeysFromCsv('DEEPGRAM_API_KEYS', 'stt', 'deepgram', 'Deepgram Nova', 'nova-3');
  addKeysFromCsv('ASSEMBLYAI_API_KEYS', 'stt', 'assemblyai', 'AssemblyAI', 'universal-2');
  addKeysFromCsv('MISTRAL_API_KEYS', 'stt', 'mistral', 'Mistral Voxtral', 'voxtral-mini-transcribe-2507');
  addKeysFromCsv('MISTRAL_API_KEYS', 'llm', 'mistral', 'Mistral Small', 'mistral-small-latest');
  addKeysFromCsv('CEREBRAS_API_KEYS', 'llm', 'cerebras', 'Cerebras LLM', 'llama-3.3-70b');
  addKeysFromCsv('OPENROUTER_API_KEYS', 'llm', 'openrouter', 'OpenRouter Free', 'meta-llama/llama-3.3-70b-instruct:free');

  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
    addKeysFromCsv(
      'CLOUDFLARE_API_TOKEN',
      'stt',
      'cloudflare',
      'Cloudflare Whisper',
      '@cf/openai/whisper-large-v3-turbo',
      process.env.CLOUDFLARE_ACCOUNT_ID.trim()
    );
    addKeysFromCsv(
      'CLOUDFLARE_API_TOKEN',
      'llm',
      'cloudflare',
      'Cloudflare Llama',
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      process.env.CLOUDFLARE_ACCOUNT_ID.trim()
    );
  }

  return keys;
}

export function createInitialStoreData(): NtkVoiceStoreData {
  return {
    version: 1,
    sttStrategy: 'round_robin',
    llmStrategy: 'round_robin',
    sttCursor: 0,
    llmCursor: 0,
    keys: buildEnvSeededKeys(),
    visibility: { ...DEFAULT_VISIBILITY },
    aiButtons: DEFAULT_AI_BUTTONS.map((b) => ({ ...b })),
    workstation: { ...DEFAULT_WORKSTATION },
    dailyUsageDate: todayDateKey(),
    dailyAiRequests: 0,
    failoverLogs: [],
  };
}

export class NtkVoiceStore {
  private data: NtkVoiceStoreData;
  private persistToDisk: boolean;
  private storeDir: string;
  private storeFile: string;
  private encryptionKey: Buffer;

  constructor(persistToDisk = true, storeDir?: string) {
    this.persistToDisk = persistToDisk;
    const envDir = process.env.NTK_DATA_DIR?.trim();
    this.storeDir = storeDir
      ? path.resolve(storeDir)
      : envDir
      ? path.resolve(envDir)
      : DEFAULT_STORE_DIR;
    this.storeFile = path.join(this.storeDir, 'ntk-voice-store.enc.json');
    this.encryptionKey = resolveEncryptionKey(this.storeDir, this.persistToDisk);
    this.data = this.load();
  }

  private load(): NtkVoiceStoreData {
    const initial = createInitialStoreData();
    if (!this.persistToDisk) return initial;

    try {
      if (!fs.existsSync(this.storeFile)) {
        return initial;
      }
      const raw = JSON.parse(fs.readFileSync(this.storeFile, 'utf8')) as { encrypted?: string };
      if (!raw.encrypted) return initial;
      const decrypted = decryptText(raw.encrypted, this.encryptionKey);
      if (!decrypted) return initial;
      const parsed = JSON.parse(decrypted) as Partial<NtkVoiceStoreData>;

      // Merge any newly configured env keys without duplicating existing IDs
      const savedKeys = Array.isArray(parsed.keys) ? parsed.keys : [];
      const envKeys = buildEnvSeededKeys();
      const mergedKeys: NtkStoredKey[] = [...savedKeys];
      for (const ek of envKeys) {
        const existingIdx = mergedKeys.findIndex((k) => k.id === ek.id);
        if (existingIdx >= 0) {
          // Keep user's enabled/priority/stats, refresh secret from env
          mergedKeys[existingIdx] = {
            ...mergedKeys[existingIdx],
            apiKey: ek.apiKey,
            accountId: ek.accountId ?? mergedKeys[existingIdx].accountId,
            fromEnv: true,
          };
        } else {
          mergedKeys.push(ek);
        }
      }

      return {
        ...initial,
        ...parsed,
        keys: mergedKeys,
        visibility: { ...DEFAULT_VISIBILITY, ...(parsed.visibility ?? {}) },
        aiButtons:
          Array.isArray(parsed.aiButtons) && parsed.aiButtons.length > 0
            ? parsed.aiButtons
            : initial.aiButtons,
        workstation: { ...DEFAULT_WORKSTATION, ...(parsed.workstation ?? {}) },
        failoverLogs: Array.isArray(parsed.failoverLogs) ? parsed.failoverLogs.slice(0, 60) : [],
      };
    } catch {
      return initial;
    }
  }

  save(): void {
    if (!this.persistToDisk) return;
    try {
      fs.mkdirSync(this.storeDir, { recursive: true });
      const encrypted = encryptText(JSON.stringify(this.data), this.encryptionKey);
      fs.writeFileSync(this.storeFile, JSON.stringify({ encrypted }), { mode: 0o600 });
    } catch {
      // Non-fatal in read-only containers
    }
  }

  getData(): NtkVoiceStoreData {
    const today = todayDateKey();
    if (this.data.dailyUsageDate !== today) {
      this.data.dailyUsageDate = today;
      this.data.dailyAiRequests = 0;
    }
    return this.data;
  }

  toPublicKey(key: NtkStoredKey, now = Date.now()): NtkPublicKey {
    const { apiKey, ...rest } = key;
    let effectiveStatus = rest.status;
    if (!rest.enabled) {
      effectiveStatus = 'disabled';
    } else if (rest.cooldownUntil > now || rest.dailyExhaustedUntil > now) {
      effectiveStatus = 'cooldown';
    } else if (effectiveStatus === 'cooldown' && rest.cooldownUntil <= now && rest.dailyExhaustedUntil <= now) {
      effectiveStatus = 'ready';
    }
    return {
      ...rest,
      status: effectiveStatus,
      keyMask: maskSecret(apiKey, rest.fromEnv),
    };
  }

  getPublicSnapshot() {
    const d = this.getData();
    const now = Date.now();
    const publicKeys = d.keys.map((k) => this.toPublicKey(k, now));
    const sttReady = publicKeys.filter((k) => k.pool === 'stt' && k.enabled && k.status === 'ready').length;
    const llmReady = publicKeys.filter((k) => k.pool === 'llm' && k.enabled && k.status === 'ready').length;
    const sttTotal = publicKeys.filter((k) => k.pool === 'stt' && k.enabled).length;
    const llmTotal = publicKeys.filter((k) => k.pool === 'llm' && k.enabled).length;

    return {
      sttStrategy: d.sttStrategy,
      llmStrategy: d.llmStrategy,
      keys: publicKeys,
      visibility: d.visibility,
      aiButtons: d.aiButtons,
      workstation: {
        ...d.workstation,
        stemApiTokenMask: d.stemApiToken ? maskSecret(d.stemApiToken, false) : '',
      },
      dailyUsageDate: d.dailyUsageDate,
      dailyAiRequests: d.dailyAiRequests,
      failoverLogs: d.failoverLogs.slice(0, 40),
      catalog: PROVIDER_CATALOG,
      summary: {
        sttReady,
        sttTotal,
        llmReady,
        llmTotal,
        stemConfigured: Boolean(d.workstation.stemSeparationUrl?.trim()),
      },
    };
  }

  appendLog(entry: Omit<NtkFailoverLogEntry, 'id' | 'timestamp'>): void {
    const d = this.getData();
    d.failoverLogs.unshift({
      ...entry,
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
    });
    if (d.failoverLogs.length > 60) {
      d.failoverLogs.length = 60;
    }
  }
}
