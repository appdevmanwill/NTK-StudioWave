export type NtkPoolType = 'stt' | 'llm';

export type NtkRotationStrategy = 'round_robin' | 'priority_failover';

export type NtkKeyHealthStatus = 'ready' | 'cooldown' | 'error' | 'disabled';

export interface NtkPublicKey {
  id: string;
  pool: NtkPoolType;
  provider: string;
  label: string;
  keyMask: string;
  accountId?: string;
  baseUrl?: string;
  model: string;
  enabled: boolean;
  priority: number;
  fromEnv?: boolean;
  status: NtkKeyHealthStatus;
  cooldownUntil: number;
  dailyExhaustedUntil: number;
  consecutiveErrors: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
  lastError: string | null;
  lastLatencyMs: number | null;
  lastUsedAt: number | null;
}

export interface NtkFailoverLogEntry {
  id: string;
  timestamp: number;
  pool: 'stt' | 'llm' | 'stem';
  keyId: string;
  provider: string;
  label: string;
  event: 'success' | 'failover' | 'cooldown' | 'error' | 'test_ok' | 'test_fail';
  statusCode?: number;
  message: string;
  chunkIndex?: number;
}

export interface NtkVisibilityMatrix {
  aiFeaturesEnabled: boolean;
  showAdvancedToggle: boolean;
  meetingAudioCapture: boolean;
  liveEqConsole: boolean;
  aiStemMixer: boolean;
  waveformTrimmer: boolean;
  momentFlags: boolean;
  multiFormatExport: boolean;
  defaultNoisePolish: boolean;
  optionalProfiles: boolean;
  localBrowserWhisperFallback: boolean;
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
  defaultLanguage: string;
  maxRecordingMinutes: number;
  autoStopSilenceSec: number;
  retentionPolicy: '24h' | '7d' | 'manual';
  dailyAiRequestCap: number;
  stemSeparationUrl: string;
  stemApiTokenMask?: string;
}

export interface NtkProviderCatalogItem {
  id: string;
  name: string;
  defaultModel: string;
  models: string[];
  needsAccountId?: boolean;
  needsBaseUrl?: boolean;
  supportsDiarization?: boolean;
  freeTierNote: string;
}

export interface NtkVoiceConfigSnapshot {
  sttStrategy: NtkRotationStrategy;
  llmStrategy: NtkRotationStrategy;
  keys: NtkPublicKey[];
  visibility: NtkVisibilityMatrix;
  aiButtons: NtkCustomAiButton[];
  workstation: NtkWorkstationSettings;
  dailyUsageDate: string;
  dailyAiRequests: number;
  failoverLogs: NtkFailoverLogEntry[];
  catalog: {
    stt: NtkProviderCatalogItem[];
    llm: NtkProviderCatalogItem[];
  };
  summary: {
    sttReady: number;
    sttTotal: number;
    llmReady: number;
    llmTotal: number;
    stemConfigured: boolean;
  };
}

export interface NtkMomentFlag {
  id: string;
  timeSec: number;
  note: string;
  createdAt: number;
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

export interface NtkAiNoteResult {
  id: string;
  buttonId: string;
  label: string;
  text: string;
  provider: string;
  model: string;
  createdAt: number;
}

export type NtkEqPresetId =
  | 'clear-office'
  | 'cut-rumble'
  | 'soften-music'
  | 'broadcast-radio'
  | 'flat-raw';

export interface NtkLiveConsoleSettings {
  presetId: NtkEqPresetId;
  /** 7 bands: 60Hz, 150Hz, 400Hz, 1kHz, 2.5kHz, 6kHz, 12kHz in dB (-12..+12) */
  eqBandsDb: [number, number, number, number, number, number, number];
  noiseGateEnabled: boolean;
  noiseGateThresholdDb: number; // -65..-20
  compressorEnabled: boolean;
  compressorThresholdDb: number; // -36..-6
  limiterEnabled: boolean;
  inputGainDb: number; // -12..+18
  liveMonitorEnabled: boolean;
  /** true = Bake EQ live into recording; false = Keep Raw Master + apply EQ non-destructively */
  bakeEqLive: boolean;
}

export interface NtkStemGains {
  vocals: number; // 0..1.5
  drums: number;
  bass: number;
  other: number;
  muted: {
    vocals: boolean;
    drums: boolean;
    bass: boolean;
    other: boolean;
  };
  solo: 'vocals' | 'drums' | 'bass' | 'other' | null;
}

export interface NtkSeparatedStems {
  vocals?: string; // data URL or blob URL
  drums?: string;
  bass?: string;
  other?: string;
  source?: string;
  createdAt: number;
}

export interface NtkRecordingItem {
  id: string;
  title: string;
  speakerName: string;
  profileTag?: string;
  createdAt: number;
  updatedAt: number;
  durationSec: number;
  mimeType: string;
  audioBlob: Blob;
  rawMasterBlob?: Blob; // Preserved for non-destructive Undo / Restore Original
  voiceOverBlob?: Blob; // Optional 2nd voice-over track
  voiceOverOffsetSec?: number;
  voiceOverGain?: number;
  trimRange?: { startSec: number; endSec: number };
  eqAppliedNonDestructively?: NtkLiveConsoleSettings;
  flags: NtkMomentFlag[];
  transcript: NtkTranscriptSegment[];
  transcriptText: string;
  transcriptProvider?: string;
  aiNotes: NtkAiNoteResult[];
  stems?: NtkSeparatedStems;
  deletedAt: number | null; // Soft-delete timestamp (7-day trash)
  clearedFromScreen?: boolean;
}

export interface NtkCrashSession {
  id: string;
  title: string;
  speakerName: string;
  startedAt: number;
  updatedAt: number;
  durationSec: number;
  mimeType: string;
  chunkCount: number;
  flags: NtkMomentFlag[];
}
