export type AppStep = 'record' | 'edit' | 'export' | 'library' | 'batch' | 'ntk-suite';
export type UserMode = 'simple' | 'pro';
export type ThemeMode = 'dark' | 'light';
export type ThemePreference = 'system' | 'light' | 'dark';
export type CaptureSource = 'mic' | 'tab' | 'mic+tab';
export type AudioCategory = 'Work' | 'Meetings' | 'Podcast' | 'Ideas' | 'Music' | 'Private';
export type ExportFormat = 'mp3' | 'wav' | 'ogg' | 'm4a' | 'flac';
export type SilencePreset = 'gentle' | 'normal' | 'tight';
export type VoiceProfile = 'speech' | 'music';

export interface SilenceRegion {
  id: string;
  start: number; // seconds
  end: number;   // seconds
  duration: number;
}

export interface RepetitionRegion {
  id: string;
  start: number;
  end: number;
  matchedWithStart: number;
  matchedWithEnd: number;
  similarity: number; // 0-1
  source: 'detected' | 'oops';
  label: string;
}

export interface BookmarkMarker {
  id: string;
  time: number; // seconds
  label: string;
  starred?: boolean;
}

export interface OopsMarker {
  id: string;
  time: number; // seconds
}

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
}

export type MusicalKey =
  | 'C'
  | 'C#'
  | 'D'
  | 'D#'
  | 'E'
  | 'F'
  | 'F#'
  | 'G'
  | 'G#'
  | 'A'
  | 'A#'
  | 'B';

export type MusicalScale =
  | 'chromatic'
  | 'major'
  | 'minor'
  | 'pentatonicMajor'
  | 'pentatonicMinor'
  | 'blues'
  | 'dorian'
  | 'mixolydian';

export interface TrackEqSettings {
  enabled: boolean;
  lowGainDb: number;   // -12 to +12 dB (Low Shelf)
  lowFreqHz: number;   // 60 to 400 Hz
  midGainDb: number;   // -12 to +12 dB (Mid Peaking)
  midFreqHz: number;   // 400 to 4500 Hz
  midQ: number;        // 0.5 to 4.0
  highGainDb: number;  // -12 to +12 dB (High Shelf)
  highFreqHz: number;  // 3000 to 14000 Hz
}

export interface DynamicsProcessorOptions {
  enabled: boolean;
  thresholdDb: number;      // -36 to -6 dB
  kneeDb: number;           // 0 to 30 dB
  ratio: number;            // 1.5 to 12
  attackSec: number;        // 0.001 to 0.08
  releaseSec: number;       // 0.05 to 0.6
  makeupGainDb: number;     // 0 to +12 dB
  limiterCeilingDb: number; // -3.0 to -0.1 dBFS
}

export interface NoiseProfile {
  fftSize: number;
  sampleRate: number;
  binMagnitudes: Float32Array; // average noise magnitude spectrum per FFT bin (0..fftSize/2)
  noiseFloorDb: number;
  dominantHumHz: number | null;
  sourceLabel: string;
  frameCount: number;
}

export interface SpectralDenoiseOptions {
  reductionStrength: number; // 0 to 100 (controls oversubtraction alpha)
  vocalProtection: number;   // 0 to 100 (preserves high-SNR vocal formants)
  spectralFloorDb: number;   // -36 to -12 dB (residual floor to avoid musical noise)
}

export type MasteringTarget = 'podcast' | 'streaming' | 'broadcast' | 'club';

export interface MultibandBandSettings {
  name: 'Low' | 'Mid' | 'High';
  rangeLabel: string;
  thresholdDb: number;
  ratio: number;
  attackSec: number;
  releaseSec: number;
  makeupGainDb: number;
}

export interface MasteringAnalysis {
  integratedLufs: number;
  peakDb: number;
  crestFactorDb: number;
  lowEnergyDb: number;
  midEnergyDb: number;
  highEnergyDb: number;
  stereoCorrelation: number;
  isMonoSource: boolean;
}

export interface MasteringPlan {
  target: MasteringTarget;
  targetLufs: number;
  analysis: MasteringAnalysis;
  multiband: {
    lowCutoffHz: number;
    highCutoffHz: number;
    low: MultibandBandSettings;
    mid: MultibandBandSettings;
    high: MultibandBandSettings;
  };
  stereoEnhancer: {
    enabled: boolean;
    width: number;        // 1.0 (neutral) to 1.5 (wide)
    monoBelowHz: number;  // keep sub-bass mono below this frequency
  };
  limiter: {
    ceilingDb: number;    // -2.0 to -0.1 dBTP
    driveDb: number;      // makeup loudness drive into brickwall limiter
  };
  recommendations: string[];
}

export type SoundElementKey = 'leadVoice' | 'backupVoice' | 'drums' | 'keyboard' | 'bass';

export interface SoundBalanceSettings {
  leadVoice: number;   // 0.0 (remove/mute) to 2.0 (+6dB boost), 1.0 = original
  backupVoice: number; // 0.0 to 2.0
  drums: number;       // 0.0 to 2.0
  keyboard: number;    // 0.0 to 2.0
  bass: number;        // 0.0 to 2.0
  muted: Record<SoundElementKey, boolean>;
  solo: SoundElementKey | null;
}

export interface RegionTransformOptions {
  startSec?: number;
  endSec?: number;
  pitchSemitones?: number; // -12 to +12
  speedRate?: number;      // 0.5 to 2.0
  preservePitch?: boolean;
  gainDb?: number;         // -24 to +24
}

export interface SteadyNormalizeOptions {
  mode: 'steady' | 'peak';
  targetLufs: number;    // e.g. -16 LUFS
  ceilingDb: number;     // e.g. -1.0 dBFS
  maxBoostDb?: number;   // default 18 dB
  noiseFloorDb?: number; // default -44 dBFS (prevents boosting background hiss)
  startSec?: number;
  endSec?: number;
}

export interface SteadyNormalizeStats {
  beforeLufs: number;
  afterLufs: number;
  beforeRangeDb: number;
  afterRangeDb: number;
  peakAfterDb: number;
}

export interface LiveRecordingControls {
  inputGain: number;          // 0.0 to 2.0 (1.0 = 100%)
  muted: boolean;
  steadyVoiceLeveler: boolean;
  voicePresenceDb: number;    // -12 to +12 dB (1.8 kHz vocal clarity)
  lowCutDb: number;           // -18 to +12 dB (120 Hz rumble/drums control)
  brightnessDb: number;       // -12 to +12 dB (6 kHz hiss/air control)
  liveNoiseGate: boolean;
  monitorEnabled: boolean;
  monitorVolume: number;      // 0.0 to 1.0
}

export interface EffectSettings {
  studioPolish: boolean;
  noiseGate: boolean;
  dynamicsProcessor: boolean;
  dynamicsThresholdDb: number;
  dynamicsRatio: number;
  dynamicsMakeupDb: number;
  limiterCeilingDb: number;
  autoTune: boolean;
  autoTuneKey: MusicalKey;
  autoTuneScale: MusicalScale;
  autoTuneStrength: number; // 0 to 100 (retune speed / snap strength)
  cleanNoise: boolean;
  removeEcho: boolean;
  autoLevel: boolean;
  warmRadio: boolean;
  breathSoftener: boolean;
  fadeInSec: number;
  fadeOutSec: number;
  wetDry: number; // 0 to 100
  profile: VoiceProfile;
  // Pro mode overrides
  highPassHz: number;
  noiseGateDb: number;
  deEsserFreqHz: number;
  compressorRatio: number;
}

export interface OverlayTrack {
  id: string;
  name: string;
  buffer: AudioBuffer;
  gain: number;      // 0 to 1.5 (1.0 = 100%)
  pan: number;       // -1 (Left) to +1 (Right)
  muted: boolean;
  solo: boolean;
  offsetSec: number; // start time offset on the timeline
  color: string;     // visual accent color
  eq?: TrackEqSettings;
  isMain?: boolean;
}

export interface SoundEffectPlacement {
  id: string;
  packItemId: string;
  name: string;
  time: number; // seconds
  volume: number; // 0-1
  buffer?: AudioBuffer;
}

export type AudiogramStyle = 'bars' | 'radial' | 'wave';

export interface MixerState {
  voiceVolume: number; // 0-1.5
  voiceMuted: boolean;
  musicVolume: number; // 0-1
  musicMuted: boolean;
  musicTrackId: string | null;
  musicTrackName: string | null;
  musicBuffer: AudioBuffer | null;
  autoDucking: boolean;
  duckAmountDb: number;    // e.g., -12 (-24 to -4)
  duckThresholdDb?: number; // default -34 dBFS
  duckAttackMs?: number;    // default 45 ms
  duckHoldMs?: number;      // default 180 ms
  duckReleaseMs?: number;   // default 380 ms
  sfxVolume: number; // 0-1
  sfxMuted: boolean;
  sfxPlacements: SoundEffectPlacement[];
}

export interface ProjectSnapshot {
  id: string;
  name: string;
  createdAt: number;
  duration: number;
  buffer: AudioBuffer;
}

export interface AudioMetadata {
  title: string;
  artist: string;
  album: string;
  coverDataUrl: string | null;
}

export interface ExportOptions {
  format: ExportFormat;
  qualityMode: 'bitrate' | 'targetSize';
  bitrateKbps: number; // 64, 96, 128, 192, 256, 320
  targetSizeMb: number;
  sampleRate: number; // 22050, 44100, 48000
  channels: 1 | 2;
  metadata: AudioMetadata;
  noiseGate?: {
    enabled: boolean;
    thresholdDb: number;
    floorGain?: number;
  };
  autoTune?: {
    enabled: boolean;
    key: MusicalKey;
    scale: MusicalScale;
    strength: number;
  };
  dynamics?: DynamicsProcessorOptions;
  mainEq?: TrackEqSettings;
}

export interface LibraryRecording {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  duration: number;
  sizeBytes: number;
  format: string;
  sampleRate: number;
  channels: number;
  category: AudioCategory;
  favorite: boolean;
  deletedAt: number | null; // null if active, timestamp if in 30-day trash
  blob: Blob;
  bookmarks: BookmarkMarker[];
  transcript: TranscriptSegment[];
  artist?: string;
  album?: string;
}

export interface AutoSaveSession {
  sessionId: string;
  startedAt: number;
  updatedAt: number;
  chunkCount: number;
  durationSec: number;
  mimeType: string;
  title: string;
}

export interface RoomCheckResult {
  noiseFloorDb: number;
  peakDb: number;
  diagnosis: string;
  recommendation: 'ready' | 'cleanup' | 'too-loud';
  sampleBlob?: Blob;
}

export interface StarterSoundItem {
  id: string;
  name: string;
  category: 'music' | 'sfx';
  durationSec: number;
  description: string;
}

export interface BatchRecipe {
  studioPolish: boolean;
  shrinkPauses: boolean;
  silencePreset: SilencePreset;
  autoLevel: boolean;
  format: ExportFormat;
  bitrateKbps: number;
}

export interface BatchJobItem {
  id: string;
  file: File;
  name: string;
  originalSize: number;
  status: 'queued' | 'processing' | 'done' | 'error';
  progress: number;
  outputBlob?: Blob;
  outputFilename?: string;
  outputSize?: number;
  savedSeconds?: number;
  error?: string;
}

export interface ImportedVideoRef {
  file: File;
  objectUrl: string;
  name: string;
  width?: number;
  height?: number;
}

export interface RealtimeNoiseGateOptions {
  enabled: boolean;
  thresholdDb: number;
  floorGain?: number;
  attackSec?: number;
  holdMs?: number;
  releaseSec?: number;
}

export interface RealtimeNoiseGateState {
  enabled: boolean;
  isOpen: boolean;
  inputDb: number;
  gain: number;
}

export interface RealtimeNoiseGateHandle {
  input: AudioNode;
  output: AudioNode;
  setEnabled(enabled: boolean): void;
  setThresholdDb(thresholdDb: number): void;
  updateOptions(opts: Partial<RealtimeNoiseGateOptions>): void;
  getState(): RealtimeNoiseGateState;
  dispose(): void;
}

export interface RealtimeAutoTuneOptions {
  enabled: boolean;
  key: MusicalKey;
  scale: MusicalScale;
  strength: number; // 0 to 100
}

export interface RealtimeAutoTuneState {
  enabled: boolean;
  detectedHz: number;
  detectedNote: string;
  targetHz: number;
  targetNote: string;
  centsOffset: number;
  shiftSemitones: number;
  voiced: boolean;
}

export interface RealtimeAutoTuneHandle {
  input: AudioNode;
  output: AudioNode;
  updateOptions(opts: Partial<RealtimeAutoTuneOptions>): void;
  getState(): RealtimeAutoTuneState;
  dispose(): void;
}

export interface TrackEqualizerHandle {
  input: AudioNode;
  output: AudioNode;
  updateEq(eq: TrackEqSettings): void;
  dispose(): void;
}

export interface RealtimeDynamicsHandle {
  input: AudioNode;
  output: AudioNode;
  updateOptions(opts: Partial<DynamicsProcessorOptions>): void;
  getState(): {
    enabled: boolean;
    reductionDb: number;
    limiterReductionDb: number;
    limiting: boolean;
  };
  dispose(): void;
}

export interface DeClickOptions {
  sensitivity?: number;     // 0..100 (default 60)
  removePlosives?: boolean; // default true
  plosiveStrength?: number; // 0..100 (default 65)
}

export interface DeReverbOptions {
  strength?: number;   // 0..100 (default 55)
  decaySec?: number;   // estimated room tail 0.12..0.60s (default 0.28)
}

export interface SpectralBoxSelection {
  startSec: number;
  endSec: number;
  minHz: number;
  maxHz: number;
  reductionDb?: number; // negative dB, e.g. -28 (default -30)
}

export interface AutomationPoint {
  id: string;
  timeSec: number; // 0..duration
  value: number;   // volume dB (-36..+12) OR pan (-1..+1)
}

export interface AutomationCurveOptions {
  volumePoints?: AutomationPoint[];
  panPoints?: AutomationPoint[];
}

export interface IAudioBackend {
  readonly name: string;
  getAudioContext(): AudioContext;
  decodeAudioData(arrayBuffer: ArrayBuffer): Promise<AudioBuffer>;
  createRealtimeNoiseGate(ctx: AudioContext, options: RealtimeNoiseGateOptions): RealtimeNoiseGateHandle;
  createRealtimeAutoTune(ctx: AudioContext, options: RealtimeAutoTuneOptions): RealtimeAutoTuneHandle;
  createTrackEqualizer(ctx: BaseAudioContext, eq?: TrackEqSettings): TrackEqualizerHandle;
  createRealtimeDynamicsProcessor(ctx: AudioContext, options: DynamicsProcessorOptions): RealtimeDynamicsHandle;
  createSpectrumAnalyser(ctx: AudioContext, fftSize?: number): AnalyserNode;
  renderEffects(buffer: AudioBuffer, effects: EffectSettings): Promise<AudioBuffer>;
  renderMix(voiceBuffer: AudioBuffer, mixer: MixerState): Promise<AudioBuffer>;
  renderMultiTrack(tracks: OverlayTrack[]): Promise<AudioBuffer>;
  captureNoiseProfile(
    buffer: AudioBuffer,
    range?: { startSec: number; endSec: number }
  ): NoiseProfile;
  applySpectralNoiseReduction(
    buffer: AudioBuffer,
    profile: NoiseProfile,
    options: SpectralDenoiseOptions
  ): { buffer: AudioBuffer; noiseReducedDb: number };
  analyzeMastering(buffer: AudioBuffer, target?: MasteringTarget): MasteringPlan;
  applyProMaster(
    buffer: AudioBuffer,
    plan: MasteringPlan
  ): Promise<{ buffer: AudioBuffer; afterAnalysis: MasteringAnalysis; maxReductionDb: number }>;
  rebalanceSoundElements(
    buffer: AudioBuffer,
    settings: SoundBalanceSettings,
    range?: { startSec: number; endSec: number }
  ): AudioBuffer;
  transformAudioRegion(buffer: AudioBuffer, options: RegionTransformOptions): AudioBuffer;
  normalizeSteadyVolume(
    buffer: AudioBuffer,
    options: SteadyNormalizeOptions
  ): { buffer: AudioBuffer; stats: SteadyNormalizeStats };
  repairClicksAndPlosives(
    buffer: AudioBuffer,
    options?: DeClickOptions
  ): { buffer: AudioBuffer; clicksRepaired: number; plosivesTamed: number };
  reduceRoomReverb(
    buffer: AudioBuffer,
    options?: DeReverbOptions
  ): { buffer: AudioBuffer; echoReducedDb: number };
  eraseSpectralBox(
    buffer: AudioBuffer,
    box: SpectralBoxSelection
  ): AudioBuffer;
  applyAutomationCurve(
    buffer: AudioBuffer,
    options: AutomationCurveOptions
  ): AudioBuffer;
  encodeAudio(buffer: AudioBuffer, options: ExportOptions): Promise<{ blob: Blob; extension: string; mimeType: string; actualBitrateKbps?: number }>;
  analyzeRoomNoise(stream: MediaStream, durationMs?: number): Promise<RoomCheckResult>;
  generateAudiogram(params: {
    buffer: AudioBuffer;
    title: string;
    artist: string;
    aspect: '9:16' | '1:1';
    theme: 'midnight' | 'sunrise' | 'studio';
    style?: AudiogramStyle;
    coverDataUrl: string | null;
    onProgress?: (pct: number) => void;
  }): Promise<Blob>;
  replaceVideoAudio(videoUrl: string, cleanedAudio: AudioBuffer, onProgress?: (pct: number) => void): Promise<Blob>;
}
