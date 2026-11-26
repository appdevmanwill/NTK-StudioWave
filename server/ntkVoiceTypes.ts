export type NtkPoolType = 'stt' | 'llm';

export type NtkSttProvider =
  | 'groq'
  | 'cloudflare'
  | 'assemblyai'
  | 'deepgram'
  | 'mistral'
  | 'gemini'
  | 'custom_openai';

export type NtkLlmProvider =
  | 'groq'
  | 'cerebras'
  | 'cloudflare'
  | 'openrouter'
  | 'gemini'
  | 'mistral'
  | 'custom_openai';

export type NtkProviderId = NtkSttProvider | NtkLlmProvider;

export type NtkRotationStrategy = 'round_robin' | 'priority_failover';

export type NtkKeyHealthStatus = 'ready' | 'cooldown' | 'error' | 'disabled';

export interface NtkStoredKey {
  id: string;
  pool: NtkPoolType;
  provider: NtkProviderId;
  label: string;
  apiKey: string; // Stored ONLY on server, encrypted at rest; NEVER returned in API responses
  accountId?: string; // Required for Cloudflare Workers AI
  baseUrl?: string; // Custom OpenAI-compatible URL
  model: string;
  enabled: boolean;
  priority: number; // Lower = higher priority
  fromEnv?: boolean;
  envVarName?: string;
  status: NtkKeyHealthStatus;
  cooldownUntil: number; // Epoch ms
  dailyExhaustedUntil: number; // Epoch ms
  consecutiveErrors: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
  lastError: string | null;
  lastLatencyMs: number | null;
  lastUsedAt: number | null;
}

export type NtkPublicKey = Omit<NtkStoredKey, 'apiKey'> & {
  keyMask: string;
};

export interface NtkFailoverLogEntry {
  id: string;
  timestamp: number;
  pool: NtkPoolType | 'stem';
  keyId: string;
  provider: string;
  label: string;
  event: 'success' | 'failover' | 'cooldown' | 'error' | 'test_ok' | 'test_fail';
  statusCode?: number;
  message: string;
  chunkIndex?: number;
}

export interface NtkVisibilityMatrix {
  aiFeaturesEnabled: boolean; // OFF by default — AI & API keys are 100% optional
  showAdvancedToggle: boolean;
  meetingAudioCapture: boolean;
  liveEqConsole: boolean;
  aiStemMixer: boolean;
  waveformTrimmer: boolean;
  momentFlags: boolean;
  multiFormatExport: boolean;
  defaultNoisePolish: boolean;
  optionalProfiles: boolean; // OFF by default for shared office use
  localBrowserWhisperFallback: boolean; // OFF by default for low-RAM PCs
}

export interface NtkCustomAiButton {
  id: string;
  label: string;
  description: string;
  kind: 'transcribe' | 'intelligence';
  prompt: string;
  enabled: boolean;
  targetLanguage?: string;
}

export interface NtkWorkstationSettings {
  suiteName: string;
  welcomeMessage: string;
  defaultLanguage: string; // 'auto' or ISO code like 'en', 'es', 'fr'
  maxRecordingMinutes: number; // 5..240
  autoStopSilenceSec: number; // 0 = disabled, or 30..600
  retentionPolicy: '24h' | '7d' | 'manual';
  dailyAiRequestCap: number; // 0 = unlimited
  stemSeparationUrl: string; // Optional HF Gradio Space (HTDemucs) or custom stem API URL
  stemApiTokenMask?: string;
}

export interface NtkVoiceStoreData {
  version: 1;
  sttStrategy: NtkRotationStrategy;
  llmStrategy: NtkRotationStrategy;
  sttCursor: number;
  llmCursor: number;
  keys: NtkStoredKey[];
  visibility: NtkVisibilityMatrix;
  aiButtons: NtkCustomAiButton[];
  workstation: NtkWorkstationSettings;
  stemApiToken?: string; // Server-only encrypted token if private HF space
  dailyUsageDate: string; // YYYY-MM-DD
  dailyAiRequests: number;
  failoverLogs: NtkFailoverLogEntry[];
}

export interface NtkTranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  speaker?: string;
  provider?: string;
  chunkIndex?: number;
}

export interface NtkAudioChunkPayload {
  chunkIndex: number;
  offsetSeconds: number;
  durationSeconds: number;
  audioBase64: string;
  mimeType: string;
}
