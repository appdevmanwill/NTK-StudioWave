import { Mp3Encoder } from '@breezystack/lamejs';
import { encodeWavPCM } from '../../utils/audioDsp';
import { setNativeKeepScreenOn } from '../../utils/platformFileSave';
import type { NtkLiveConsoleSettings } from '../types';
import { NTK_7BAND_EQ_SPECS } from '../utils/ntkAudioUtils';

export interface NtkCaptureCallbacks {
  onLevel: (level: { rmsDb: number; peakDb: number; clipping: boolean; gateOpen: boolean }) => void;
  onChunk: (chunk: Blob, chunkIndex: number) => void;
  onMutedMicWarning: () => void;
  onProlongedSilenceStop: () => void;
  onMaxDurationStop: () => void;
}

export function isMeetingCaptureSupported(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  const isMobile = /android|iphone|ipad|ipod|mobile/i.test(ua);
  const isChromium = /chrome|edg|chromium/i.test(ua) && !/firefox/i.test(ua);
  return !isMobile && isChromium && Boolean(navigator.mediaDevices?.getDisplayMedia);
}

export function pickSupportedMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

/**
 * Real-time Web Audio API capture & live sound engineering engine.
 * Supports:
 * - Default invisible novice noise reduction & auto-leveling
 * - Live 7-band EQ, Real-time Noise Gate, Compressor, Brickwall Limiter, Input Gain, Headphone Monitor
 * - Dual Safety Mode: Bake EQ Live into Recording vs Keep Raw Master (non-destructive)
 * - Desktop Chrome/Edge Meeting Audio + Mic mixing
 * - 3-second crash-proof chunk streaming, 5s muted-mic detector, silence & max-duration guards, Wake Lock
 */
export class NtkLiveCaptureEngine {
  private ctx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private displayStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private rawMasterRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private rawChunks: Blob[] = [];
  private chunkCounter = 0;

  // Live processing nodes
  private inputGainNode: GainNode | null = null;
  private eqFilters: BiquadFilterNode[] = [];
  private gateGainNode: GainNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private limiterNode: DynamicsCompressorNode | null = null;
  private monitorGainNode: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;

  private settings: NtkLiveConsoleSettings;
  private defaultNovicePolish = true;
  private rafId: number | null = null;
  private startedAt = 0;
  private pausedAccumMs = 0;
  private pauseStartedAt = 0;
  private isPaused = false;
  private mutedCheckDone = false;
  private maxDetectedDbInFirst5s = -90;
  private lastSoundAt = 0;
  private maxDurationMs = 60 * 60 * 1000;
  private autoStopSilenceMs = 0;
  private mimeType = 'audio/webm';
  private wakeLock: { release: () => Promise<void> } | null = null;
  private callbacks: NtkCaptureCallbacks | null = null;

  constructor(initialSettings: NtkLiveConsoleSettings) {
    this.settings = { ...initialSettings };
  }

  async start(options: {
    deviceId?: string;
    includeMeetingAudio: boolean;
    defaultNovicePolish: boolean;
    settings: NtkLiveConsoleSettings;
    maxRecordingMinutes: number;
    autoStopSilenceSec: number;
    callbacks: NtkCaptureCallbacks;
  }): Promise<{ mimeType: string }> {
    this.settings = { ...options.settings };
    this.defaultNovicePolish = options.defaultNovicePolish;
    this.callbacks = options.callbacks;
    this.maxDurationMs = Math.max(1, options.maxRecordingMinutes) * 60 * 1000;
    this.autoStopSilenceMs = Math.max(0, options.autoStopSilenceSec) * 1000;
    this.chunks = [];
    this.rawChunks = [];
    this.chunkCounter = 0;
    this.mutedCheckDone = false;
    this.maxDetectedDbInFirst5s = -90;
    this.isPaused = false;
    this.pausedAccumMs = 0;

    // Acquire Screen Wake Lock if supported (keeps phone screen awake while recording)
    try {
      const navWithWake = navigator as unknown as {
        wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
      };
      if (navWithWake.wakeLock) {
        this.wakeLock = await navWithWake.wakeLock.request('screen');
      }
    } catch {
      // Optional best-effort wake lock
    }

    const micConstraints: MediaTrackConstraints = {
      echoCancellation: options.defaultNovicePolish,
      noiseSuppression: options.defaultNovicePolish,
      autoGainControl: options.defaultNovicePolish,
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
    };

    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints });

    if (options.includeMeetingAudio && isMeetingCaptureSupported()) {
      this.displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      // Stop unneeded video track immediately so low-RAM PCs don't encode video
      this.displayStream.getVideoTracks().forEach((t) => t.stop());
    }

    const ctx = new AudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => undefined);
    }
    this.ctx = ctx;

    const mixBus = ctx.createGain();
    mixBus.gain.value = 1.0;

    const micSource = ctx.createMediaStreamSource(this.micStream);
    micSource.connect(mixBus);

    if (this.displayStream && this.displayStream.getAudioTracks().length > 0) {
      const tabStream = new MediaStream(this.displayStream.getAudioTracks());
      const tabSource = ctx.createMediaStreamSource(tabStream);
      const tabGain = ctx.createGain();
      tabGain.gain.value = 0.85;
      tabSource.connect(tabGain);
      tabGain.connect(mixBus);
    }

    // Raw Master Destination (preserves untouched raw audio for Safety Mode)
    const rawDest = ctx.createMediaStreamDestination();
    mixBus.connect(rawDest);

    // Processed Channel Strip: Input Gain -> 7-Band EQ -> Noise Gate -> Compressor -> Limiter -> Processed Dest
    const inputGain = ctx.createGain();
    this.inputGainNode = inputGain;

    const filters = NTK_7BAND_EQ_SPECS.map((spec) => {
      const f = ctx.createBiquadFilter();
      f.type = spec.filterType;
      f.frequency.value = spec.freqHz;
      f.Q.value = spec.q;
      f.gain.value = 0;
      return f;
    });
    this.eqFilters = filters;

    const gateGain = ctx.createGain();
    gateGain.gain.value = 1.0;
    this.gateGainNode = gateGain;

    const comp = ctx.createDynamicsCompressor();
    comp.knee.value = 16;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.008;
    comp.release.value = 0.18;
    this.compressorNode = comp;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.08;
    this.limiterNode = limiter;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;
    this.analyserNode = analyser;

    const processedDest = ctx.createMediaStreamDestination();
    const monitorGain = ctx.createGain();
    monitorGain.gain.value = 0;
    this.monitorGainNode = monitorGain;

    // Wire graph
    mixBus.connect(inputGain);
    let node: AudioNode = inputGain;
    for (const f of filters) {
      node.connect(f);
      node = f;
    }
    node.connect(gateGain);
    gateGain.connect(comp);
    comp.connect(limiter);
    limiter.connect(analyser);
    analyser.connect(processedDest);
    analyser.connect(monitorGain);
    monitorGain.connect(ctx.destination);

    this.applySettings(this.settings);

    const detectedMime = pickSupportedMimeType();
    const recordStream = this.settings.bakeEqLive ? processedDest.stream : rawDest.stream;

    const recOptions: MediaRecorderOptions = detectedMime ? { mimeType: detectedMime } : {};
    const recorder = new MediaRecorder(recordStream, recOptions);
    this.mimeType = recorder.mimeType || detectedMime || 'audio/webm';
    this.recorder = recorder;
    setNativeKeepScreenOn(true);

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        this.chunks.push(ev.data);
        const idx = this.chunkCounter++;
        this.callbacks?.onChunk(ev.data, idx);
      }
    };

    // If Bake EQ Live is enabled, also keep an untouched raw backup stream in memory for non-destructive restore
    if (this.settings.bakeEqLive) {
      const rawRec = new MediaRecorder(rawDest.stream, recOptions);
      this.rawMasterRecorder = rawRec;
      rawRec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) this.rawChunks.push(ev.data);
      };
      rawRec.start(3000);
    }

    // Stream chunks every 3 seconds for crash-proof IndexedDB backup
    recorder.start(3000);
    this.startedAt = Date.now();
    this.lastSoundAt = this.startedAt;
    this.startMeterLoop();

    return { mimeType: this.mimeType };
  }

  applySettings(next: NtkLiveConsoleSettings): void {
    this.settings = { ...next };
    const now = this.ctx?.currentTime ?? 0;

    if (this.inputGainNode) {
      const lin = Math.pow(10, next.inputGainDb / 20);
      this.inputGainNode.gain.setTargetAtTime(lin, now, 0.02);
    }

    this.eqFilters.forEach((f, idx) => {
      const db = next.eqBandsDb[idx] ?? 0;
      f.gain.setTargetAtTime(db, now, 0.025);
    });

    if (this.compressorNode) {
      const active = next.compressorEnabled || this.defaultNovicePolish;
      this.compressorNode.threshold.setTargetAtTime(
        active ? next.compressorThresholdDb : 0,
        now,
        0.02
      );
      this.compressorNode.ratio.setTargetAtTime(active ? 3.8 : 1, now, 0.02);
    }

    if (this.limiterNode) {
      this.limiterNode.threshold.setTargetAtTime(next.limiterEnabled ? -1.2 : 0, now, 0.02);
      this.limiterNode.ratio.setTargetAtTime(next.limiterEnabled ? 20 : 1, now, 0.02);
    }

    if (this.monitorGainNode) {
      this.monitorGainNode.gain.setTargetAtTime(next.liveMonitorEnabled ? 0.85 : 0, now, 0.03);
    }
  }

  pause(): void {
    if (!this.recorder || this.recorder.state !== 'recording') return;
    this.recorder.pause();
    if (this.rawMasterRecorder?.state === 'recording') this.rawMasterRecorder.pause();
    this.isPaused = true;
    this.pauseStartedAt = Date.now();
  }

  resume(): void {
    if (!this.recorder || this.recorder.state !== 'paused') return;
    this.recorder.resume();
    if (this.rawMasterRecorder?.state === 'paused') this.rawMasterRecorder.resume();
    this.pausedAccumMs += Date.now() - this.pauseStartedAt;
    this.isPaused = false;
    this.lastSoundAt = Date.now();
  }

  getElapsedSeconds(): number {
    if (!this.startedAt) return 0;
    const now = this.isPaused ? this.pauseStartedAt : Date.now();
    return Math.max(0, (now - this.startedAt - this.pausedAccumMs) / 1000);
  }

  private startMeterLoop(): void {
    const data = new Float32Array(this.analyserNode?.fftSize ?? 1024);
    const tick = () => {
      if (!this.analyserNode || !this.ctx) return;
      this.analyserNode.getFloatTimeDomainData(data);
      let sumSq = 0;
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const a = Math.abs(data[i]);
        sumSq += a * a;
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sumSq / data.length);
      const rmsDb = rms > 1e-6 ? 20 * Math.log10(rms) : -90;
      const peakDb = peak > 1e-6 ? 20 * Math.log10(peak) : -90;
      const clipping = peak >= 0.98;

      // Real-time Noise Gate automation
      let gateOpen = true;
      if (this.settings.noiseGateEnabled && this.gateGainNode) {
        gateOpen = rmsDb >= this.settings.noiseGateThresholdDb;
        this.gateGainNode.gain.setTargetAtTime(
          gateOpen ? 1.0 : 0.05,
          this.ctx.currentTime,
          gateOpen ? 0.015 : 0.09
        );
      } else if (this.gateGainNode) {
        this.gateGainNode.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.02);
      }

      if (!this.isPaused) {
        const elapsedMs = this.getElapsedSeconds() * 1000;
        if (rmsDb > this.maxDetectedDbInFirst5s) {
          this.maxDetectedDbInFirst5s = rmsDb;
        }
        // 5-Second Muted / Silent-Mic Detector
        if (!this.mutedCheckDone && elapsedMs >= 5000) {
          this.mutedCheckDone = true;
          if (this.maxDetectedDbInFirst5s < -62) {
            this.callbacks?.onMutedMicWarning();
          }
        }
        // Prolonged silence guard
        if (rmsDb > -48) {
          this.lastSoundAt = Date.now();
        } else if (
          this.autoStopSilenceMs > 0 &&
          elapsedMs > 8000 &&
          Date.now() - this.lastSoundAt >= this.autoStopSilenceMs
        ) {
          this.callbacks?.onProlongedSilenceStop();
          return;
        }
        // Max recording duration guard
        if (elapsedMs >= this.maxDurationMs) {
          this.callbacks?.onMaxDurationStop();
          return;
        }
      }

      this.callbacks?.onLevel({ rmsDb, peakDb, clipping, gateOpen });
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  async stop(): Promise<{
    audioBlob: Blob;
    rawMasterBlob?: Blob;
    durationSec: number;
    mimeType: string;
  }> {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    const durationSec = Math.max(0.5, Number(this.getElapsedSeconds().toFixed(2)));

    const stopRec = (rec: MediaRecorder | null) =>
      new Promise<void>((resolve) => {
        if (!rec || rec.state === 'inactive') {
          resolve();
          return;
        }
        rec.onstop = () => resolve();
        try {
          rec.stop();
        } catch {
          resolve();
        }
      });

    await Promise.all([stopRec(this.recorder), stopRec(this.rawMasterRecorder)]);

    this.micStream?.getTracks().forEach((t) => t.stop());
    this.displayStream?.getTracks().forEach((t) => t.stop());
    if (this.wakeLock) {
      await this.wakeLock.release().catch(() => undefined);
      this.wakeLock = null;
    }
    setNativeKeepScreenOn(false);
    if (this.ctx) {
      await this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }

    const audioBlob = new Blob(this.chunks, { type: this.mimeType });
    const rawMasterBlob =
      this.rawChunks.length > 0
        ? new Blob(this.rawChunks, { type: this.mimeType })
        : undefined;

    this.recorder = null;
    this.rawMasterRecorder = null;
    this.micStream = null;
    this.displayStream = null;

    return { audioBlob, rawMasterBlob, durationSec, mimeType: this.mimeType };
  }
}

/**
 * Decodes any audio Blob into a Web Audio AudioBuffer.
 */
export async function decodeBlobToAudioBuffer(blob: Blob): Promise<AudioBuffer> {
  const arr = await blob.arrayBuffer();
  const ctx = new AudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume().catch(() => undefined);
  }
  try {
    return await ctx.decodeAudioData(arr.slice(0));
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/**
 * Renders an AudioBuffer offline through the 7-Band Live Equalizer, Compressor, and Limiter
 * so users who recorded in Non-Destructive Safety Mode get their exact EQ settings in exported WAV/MP3 files.
 */
export async function renderBufferWithConsoleEq(
  input: AudioBuffer,
  settings: NtkLiveConsoleSettings
): Promise<AudioBuffer> {
  const offline = new OfflineAudioContext(
    input.numberOfChannels,
    input.length,
    input.sampleRate
  );
  const src = offline.createBufferSource();
  src.buffer = input;

  const gain = offline.createGain();
  gain.gain.value = Math.pow(10, settings.inputGainDb / 20);
  src.connect(gain);

  let node: AudioNode = gain;
  NTK_7BAND_EQ_SPECS.forEach((spec, idx) => {
    const f = offline.createBiquadFilter();
    f.type = spec.filterType;
    f.frequency.value = spec.freqHz;
    f.Q.value = spec.q;
    f.gain.value = settings.eqBandsDb[idx] ?? 0;
    node.connect(f);
    node = f;
  });

  if (settings.compressorEnabled) {
    const comp = offline.createDynamicsCompressor();
    comp.threshold.value = settings.compressorThresholdDb;
    comp.knee.value = 16;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.008;
    comp.release.value = 0.18;
    node.connect(comp);
    node = comp;
  }

  if (settings.limiterEnabled) {
    const lim = offline.createDynamicsCompressor();
    lim.threshold.value = -1.2;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.002;
    lim.release.value = 0.08;
    node.connect(lim);
    node = lim;
  }

  node.connect(offline.destination);
  src.start(0);
  return offline.startRendering();
}

export function encodeAudioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const chs: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    chs.push(buffer.getChannelData(c));
  }
  const wavBytes = encodeWavPCM(chs, buffer.sampleRate);
  const copy = new Uint8Array(wavBytes.length);
  copy.set(wavBytes);
  return new Blob([copy.buffer], { type: 'audio/wav' });
}

export function encodeAudioBufferToMp3Blob(buffer: AudioBuffer, kbps = 128): Blob {
  const numCh = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const encoder = new Mp3Encoder(numCh, sampleRate, kbps);
  const left = floatToInt16(buffer.getChannelData(0));
  const right = numCh > 1 ? floatToInt16(buffer.getChannelData(1)) : undefined;
  const blockSize = 1152;
  const mp3Parts: Uint8Array[] = [];

  for (let i = 0; i < left.length; i += blockSize) {
    const lChunk = left.subarray(i, i + blockSize);
    const rChunk = right ? right.subarray(i, i + blockSize) : undefined;
    const encoded = numCh > 1 && rChunk
      ? encoder.encodeBuffer(lChunk, rChunk)
      : encoder.encodeBuffer(lChunk);
    if (encoded.length > 0) mp3Parts.push(new Uint8Array(encoded));
  }
  const flushed = encoder.flush();
  if (flushed.length > 0) mp3Parts.push(new Uint8Array(flushed));
  const total = mp3Parts.reduce((s, p) => s + p.length, 0);
  const merged = new Uint8Array(total);
  let pos = 0;
  for (const part of mp3Parts) {
    merged.set(part, pos);
    pos += part.length;
  }
  return new Blob([merged.buffer], { type: 'audio/mpeg' });
}

function floatToInt16(src: Float32Array): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const s = Math.max(-1, Math.min(1, src[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}
