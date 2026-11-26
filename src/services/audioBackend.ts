import { Mp3Encoder } from '@breezystack/lamejs';
import type {
  AudiogramStyle,
  AudioMetadata,
  AutomationCurveOptions,
  DeClickOptions,
  DeReverbOptions,
  DynamicsProcessorOptions,
  EffectSettings,
  ExportOptions,
  IAudioBackend,
  MasteringAnalysis,
  MasteringPlan,
  MasteringTarget,
  MixerState,
  NoiseProfile,
  OverlayTrack,
  RealtimeAutoTuneHandle,
  RealtimeAutoTuneOptions,
  RealtimeAutoTuneState,
  RealtimeDynamicsHandle,
  RealtimeNoiseGateHandle,
  RealtimeNoiseGateOptions,
  RegionTransformOptions,
  RoomCheckResult,
  SoundBalanceSettings,
  SpectralBoxSelection,
  SpectralDenoiseOptions,
  SteadyNormalizeOptions,
  SteadyNormalizeStats,
  TrackEqSettings,
  TrackEqualizerHandle,
} from '../types/audio';
import {
  DEFAULT_TRACK_EQ,
  NoiseGateStateMachine,
  applyDynamicsProcessorPCM,
  applyNoiseGatePCM,
  calculateBitrateForTargetSize,
  clampTrackEq,
  dbToLinear,
  encodeFlacPCM,
  encodeWavPCM,
  isTrackEqActive,
  linearToDb,
  mixToMono,
} from '../utils/audioDsp';
import {
  applyAutoTunePCM,
  computeTrackPlaybackParams,
  detectPitchFFT,
  freqToMidi,
  midiToFreq,
  snapMidiToScale,
} from '../utils/pitchCorrection';
import { applyMasteringChainPCM, analyzeForMastering } from '../utils/masteringEngine';
import {
  computeAutoDuckingCurve,
  normalizeSteadyVolumePCM,
  rebalanceSoundElementsPCM,
  transformAudioRegionPCM,
} from '../utils/ruleBasedEditorDsp';
import {
  applyAutomationCurvePCM,
  deClickAndDePlosivePCM,
  deReverbPCM,
  eraseSpectralBoxPCM,
} from '../utils/spectralRepairDsp';
import {
  createAudiogramParticles,
  renderAudiogramFrame,
} from '../utils/audiogramRenderer';
import { applySpectralSubtractionPCM, estimateNoiseProfileFFT } from '../utils/spectralDenoise';

export const DEFAULT_EFFECTS: EffectSettings = {
  studioPolish: false,
  noiseGate: false,
  dynamicsProcessor: false,
  dynamicsThresholdDb: -18,
  dynamicsRatio: 4.0,
  dynamicsMakeupDb: 3.0,
  limiterCeilingDb: -0.3,
  autoTune: false,
  autoTuneKey: 'C',
  autoTuneScale: 'major',
  autoTuneStrength: 85,
  cleanNoise: false,
  removeEcho: false,
  autoLevel: false,
  warmRadio: false,
  breathSoftener: false,
  fadeInSec: 0,
  fadeOutSec: 0,
  wetDry: 75,
  profile: 'speech',
  highPassHz: 85,
  noiseGateDb: -35,
  deEsserFreqHz: 6800,
  compressorRatio: 3.0,
};

export function extractChannels(buffer: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.push(new Float32Array(buffer.getChannelData(c)));
  }
  return out;
}

export function createAudioBufferFromChannels(
  ctx: BaseAudioContext,
  channels: Float32Array[],
  sampleRate: number
): AudioBuffer {
  const numCh = Math.max(1, channels.length);
  const length = Math.max(1, channels[0]?.length ?? 1);
  const buf = ctx.createBuffer(numCh, length, sampleRate);
  for (let c = 0; c < numCh; c++) {
    buf.copyToChannel(new Float32Array(channels[c]), c);
  }
  return buf;
}

/**
 * Segment-aware multi-speaker auto-leveling + dynamic noise gate / de-reverb pre-pass.
 * Operates cleanly in pure Float32 PCM before OfflineAudioContext EQ/compression.
 */
function applyPrePcmDsp(
  inputBuffer: AudioBuffer,
  ctx: BaseAudioContext,
  effects: EffectSettings
): AudioBuffer {
  const sr = inputBuffer.sampleRate;
  const numCh = inputBuffer.numberOfChannels;
  const len = inputBuffer.length;
  let channels = extractChannels(inputBuffer);
  const mono = mixToMono(channels);

  // 1. Real-Time Noise Gate / Clean Background Noise (or Studio Polish): smooth RMS noise gate
  if (effects.noiseGate || effects.cleanNoise || effects.studioPolish) {
    const gateDb =
      effects.noiseGate || effects.cleanNoise ? effects.noiseGateDb : effects.noiseGateDb - 2;
    const floorGain = effects.noiseGate ? 0.02 : effects.cleanNoise ? 0.04 : 0.12;
    channels = applyNoiseGatePCM(channels, sr, {
      thresholdDb: gateDb,
      floorGain,
      attackSec: 0.008,
      holdMs: 70,
      releaseSec: 0.09,
    });
  }

  // 1b. Automated Pitch Correction (Auto-Tune via FFT pitch analysis + OLA pitch shift)
  if (effects.autoTune) {
    channels = applyAutoTunePCM(channels, sr, {
      key: effects.autoTuneKey,
      scale: effects.autoTuneScale,
      strength: effects.autoTuneStrength,
    });
  }

  // 2. Remove Room Echo: transient-preserving tail damper (attenuates decaying reverb tails)
  if (effects.removeEcho) {
    const fastCoeff = 1 - Math.exp(-1 / (sr * 0.006));
    const slowCoeff = 1 - Math.exp(-1 / (sr * 0.14));
    let fastEnv = 0;
    let slowEnv = 0;

    for (let i = 0; i < len; i++) {
      const abs = Math.abs(mono[i]);
      fastEnv += fastCoeff * (abs - fastEnv);
      slowEnv += slowCoeff * (abs - slowEnv);
      // When slow reverb tail dominates over direct fast transient, gently damp tail
      const ratio = fastEnv / Math.max(1e-5, slowEnv);
      const gain = ratio < 0.7 ? Math.max(0.35, 0.35 + (ratio / 0.7) * 0.65) : 1.0;
      for (let c = 0; c < numCh; c++) {
        channels[c][i] *= gain;
      }
    }
  }

  // 3. Auto-Level & Multi-Speaker Balance: 0.6s window RMS leveling toward -16 dBFS target
  // Use post-gated channels so room noise / silent pauses are NEVER boosted!
  if (effects.autoLevel || effects.studioPolish) {
    const gatedMono = mixToMono(channels);
    const targetRms = dbToLinear(effects.profile === 'music' ? -15 : -16);
    const activeFloor = dbToLinear(-34);
    const win = Math.floor(sr * 0.6);
    const gainTrack = new Float32Array(len);
    const blockGains: number[] = [];
    const numBlocks = Math.ceil(len / win);

    for (let b = 0; b < numBlocks; b++) {
      const s = b * win;
      const e = Math.min(len, s + win);
      let sumSq = 0;
      for (let i = s; i < e; i++) sumSq += gatedMono[i] * gatedMono[i];
      const rms = Math.sqrt(sumSq / Math.max(1, e - s));
      if (rms < activeFloor) {
        blockGains.push(1.0);
      } else {
        const g = targetRms / rms;
        blockGains.push(Math.max(0.45, Math.min(2.6, g)));
      }
    }

    // Smoothly interpolate block gains sample-by-sample
    let curGain = blockGains[0] ?? 1.0;
    const smooth = 1 - Math.exp(-1 / (sr * 0.18));
    for (let i = 0; i < len; i++) {
      const b = Math.min(numBlocks - 1, Math.floor(i / win));
      curGain += smooth * (blockGains[b] - curGain);
      gainTrack[i] = curGain;
    }

    for (let c = 0; c < numCh; c++) {
      const ch = channels[c];
      for (let i = 0; i < len; i++) {
        // Gentle soft-clip protection
        ch[i] = Math.tanh(ch[i] * gainTrack[i] * 0.98);
      }
    }
  }

  // 4. Main Track Dynamics Processor (Compressor + Brickwall Limiter)
  if (effects.dynamicsProcessor) {
    const dyn = applyDynamicsProcessorPCM(channels, sr, {
      thresholdDb: effects.dynamicsThresholdDb,
      kneeDb: 10,
      ratio: effects.dynamicsRatio,
      attackSec: 0.006,
      releaseSec: 0.14,
      makeupGainDb: effects.dynamicsMakeupDb,
      limiterCeilingDb: effects.limiterCeilingDb,
    });
    channels = dyn.channels;
  }

  return createAudioBufferFromChannels(ctx, channels, sr);
}

/**
 * Resample an AudioBuffer to target sampleRate and channel count via OfflineAudioContext.
 */
async function resampleBuffer(
  buffer: AudioBuffer,
  targetSampleRate: number,
  targetChannels: 1 | 2
): Promise<AudioBuffer> {
  if (buffer.sampleRate === targetSampleRate && buffer.numberOfChannels === targetChannels) {
    return buffer;
  }
  const targetLen = Math.max(1, Math.ceil(buffer.duration * targetSampleRate));
  const offline = new OfflineAudioContext(targetChannels, targetLen, targetSampleRate);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start(0);
  return offline.startRendering();
}

function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/**
 * Pure-JS MP3 encoding using @breezystack/lamejs (works 100% offline in sandboxed iframes).
 */
function encodeMp3Buffer(buffer: AudioBuffer, bitrateKbps: number): Blob {
  const numChannels = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const encoder = new Mp3Encoder(numChannels, sampleRate, bitrateKbps);
  const blockSize = 1152;
  const mp3Parts: Uint8Array[] = [];

  const left = floatToInt16(buffer.getChannelData(0));
  const right = numChannels === 2 ? floatToInt16(buffer.getChannelData(1)) : undefined;

  for (let i = 0; i < left.length; i += blockSize) {
    const leftChunk = left.subarray(i, i + blockSize);
    const rightChunk = right ? right.subarray(i, i + blockSize) : undefined;
    const encoded = rightChunk
      ? encoder.encodeBuffer(leftChunk, rightChunk)
      : encoder.encodeBuffer(leftChunk);
    if (encoded.length > 0) {
      mp3Parts.push(new Uint8Array(encoded));
    }
  }

  const flushed = encoder.flush();
  if (flushed.length > 0) {
    mp3Parts.push(new Uint8Array(flushed));
  }

  return new Blob(mp3Parts as BlobPart[], { type: 'audio/mpeg' });
}

/**
 * Record an AudioBuffer via MediaRecorder in real-time (used for OGG/Opus or M4A/AAC when supported,
 * with clean deterministic MP3/WAV fallback so exports ALWAYS succeed cleanly).
 */
async function encodeViaMediaRecorder(
  buffer: AudioBuffer,
  preferredMimeTypes: string[],
  bitrateKbps: number
): Promise<{ blob: Blob; mimeType: string } | null> {
  if (typeof MediaRecorder === 'undefined') return null;
  const supported = preferredMimeTypes.find((m) => MediaRecorder.isTypeSupported(m));
  if (!supported) return null;

  // For snappy UX on long files (>25s), prefer fast offline MP3/WAV container if realtime would be slow,
  // or play at high speed? MediaRecorder records realtime, so for files <= 18s use real MediaRecorder!
  if (buffer.duration > 18) {
    return null;
  }

  const ctx = new AudioContext({ sampleRate: buffer.sampleRate });
  try {
    const dest = ctx.createMediaStreamDestination();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(dest);

    const recorder = new MediaRecorder(dest.stream, {
      mimeType: supported,
      audioBitsPerSecond: bitrateKbps * 1000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const done = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: supported }));
      recorder.onerror = () => reject(new Error('MediaRecorder encoding failed'));
    });

    recorder.start(100);
    src.start(0);
    src.onended = () => {
      setTimeout(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, 80);
    };

    const blob = await done;
    return { blob, mimeType: supported };
  } catch {
    return null;
  } finally {
    ctx.close().catch(() => {});
  }
}

export class WebAudioBackend implements IAudioBackend {
  readonly name = 'WebAudioBackend';
  private ctx: AudioContext | null = null;

  getAudioContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  async decodeAudioData(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.getAudioContext();
    // Copy ArrayBuffer because decodeAudioData detaches it
    return ctx.decodeAudioData(arrayBuffer.slice(0));
  }

  createRealtimeNoiseGate(
    ctx: AudioContext,
    options: RealtimeNoiseGateOptions
  ): RealtimeNoiseGateHandle {
    let enabled = options.enabled;
    let thresholdDb = options.thresholdDb;
    let floorGain = options.floorGain ?? 0.025;
    let attackSec = options.attackSec ?? 0.008;
    let holdMs = options.holdMs ?? 80;
    let releaseSec = options.releaseSec ?? 0.09;

    const input = ctx.createGain();
    const detector = ctx.createAnalyser();
    detector.fftSize = 1024;
    detector.smoothingTimeConstant = 0.2;

    const gateGain = ctx.createGain();
    gateGain.gain.setValueAtTime(enabled ? floorGain : 1.0, ctx.currentTime);

    input.connect(detector);
    input.connect(gateGain);

    const sm = new NoiseGateStateMachine({
      thresholdDb,
      hysteresisDb: 2.5,
      holdMs,
      floorGain,
    });

    const sampleBuf = new Float32Array(detector.fftSize);
    let lastState = {
      enabled,
      isOpen: !enabled,
      inputDb: -100,
      gain: enabled ? floorGain : 1.0,
    };

    const tick = () => {
      if (ctx.state === 'closed') return;
      detector.getFloatTimeDomainData(sampleBuf);
      let sumSq = 0;
      for (let i = 0; i < sampleBuf.length; i++) {
        sumSq += sampleBuf[i] * sampleBuf[i];
      }
      const rms = Math.sqrt(sumSq / sampleBuf.length);
      const inputDb = linearToDb(rms);
      const evalRes = sm.evaluate(inputDb, performance.now(), enabled);

      const tau = evalRes.isOpen ? Math.max(0.003, attackSec) : Math.max(0.015, releaseSec);
      gateGain.gain.setTargetAtTime(evalRes.targetGain, ctx.currentTime, tau);

      lastState = {
        enabled,
        isOpen: evalRes.isOpen,
        inputDb,
        gain: gateGain.gain.value,
      };
    };

    const timer = window.setInterval(tick, 16);

    return {
      input,
      output: gateGain,
      setEnabled(next: boolean) {
        enabled = next;
        if (!enabled) {
          gateGain.gain.setTargetAtTime(1.0, ctx.currentTime, 0.012);
          lastState = { ...lastState, enabled: false, isOpen: true, gain: 1.0 };
        } else {
          lastState = { ...lastState, enabled: true };
        }
      },
      setThresholdDb(nextDb: number) {
        thresholdDb = nextDb;
        sm.updateConfig({ thresholdDb: nextDb });
      },
      updateOptions(opts: Partial<RealtimeNoiseGateOptions>) {
        if (opts.thresholdDb !== undefined) thresholdDb = opts.thresholdDb;
        if (opts.floorGain !== undefined) floorGain = opts.floorGain;
        if (opts.attackSec !== undefined) attackSec = opts.attackSec;
        if (opts.holdMs !== undefined) holdMs = opts.holdMs;
        if (opts.releaseSec !== undefined) releaseSec = opts.releaseSec;
        sm.updateConfig({ thresholdDb, holdMs, floorGain });
        if (opts.enabled !== undefined) {
          this.setEnabled(opts.enabled);
        }
      },
      getState() {
        return { ...lastState, gain: gateGain.gain.value };
      },
      dispose() {
        window.clearInterval(timer);
        try {
          input.disconnect();
          detector.disconnect();
          gateGain.disconnect();
        } catch {
          // ignore disconnect errors
        }
      },
    };
  }

  createRealtimeAutoTune(
    ctx: AudioContext,
    options: RealtimeAutoTuneOptions
  ): RealtimeAutoTuneHandle {
    let enabled = options.enabled;
    let key = options.key;
    let scale = options.scale;
    let strength = options.strength;

    const input = ctx.createGain();
    const output = ctx.createGain();
    const dryGain = ctx.createGain();
    const wetGain = ctx.createGain();

    // Real-time AnalyserNode sidechain for Radix-2 FFT monophonic pitch detection
    const pitchAnalyser = ctx.createAnalyser();
    pitchAnalyser.fftSize = 2048;
    pitchAnalyser.smoothingTimeConstant = 0;

    // Dual-tap crossfaded delay-line pitch shifter (100% Web Audio native, zero SharedArrayBuffer)
    // Delay modulation rate f_mod = (1 - ratio) / windowSec shifts pitch cleanly in real time
    const windowSec = 0.045;
    const delayA = ctx.createDelay(0.2);
    const delayB = ctx.createDelay(0.2);
    delayA.delayTime.value = windowSec * 0.5;
    delayB.delayTime.value = windowSec * 0.5;

    const gainA = ctx.createGain();
    const gainB = ctx.createGain();
    gainA.gain.value = 0.5;
    gainB.gain.value = 0.5;

    input.connect(pitchAnalyser);
    input.connect(dryGain);
    dryGain.connect(output);

    input.connect(delayA);
    input.connect(delayB);
    delayA.connect(gainA);
    delayB.connect(gainB);
    gainA.connect(wetGain);
    gainB.connect(wetGain);
    wetGain.connect(output);

    const setMix = (isEnabled: boolean) => {
      const now = ctx.currentTime;
      dryGain.gain.setTargetAtTime(isEnabled ? 0.0 : 1.0, now, 0.015);
      wetGain.gain.setTargetAtTime(isEnabled ? 1.0 : 0.0, now, 0.015);
    };
    setMix(enabled);

    const sampleBuf = new Float32Array(pitchAnalyser.fftSize);
    let phase = 0;
    let smoothedShiftSemitones = 0;
    let lastTickMs = performance.now();

    let state: RealtimeAutoTuneState = {
      enabled,
      detectedHz: 0,
      detectedNote: '--',
      targetHz: 0,
      targetNote: '--',
      centsOffset: 0,
      shiftSemitones: 0,
      voiced: false,
    };

    const tick = () => {
      if (ctx.state === 'closed') return;
      const nowMs = performance.now();
      const dtSec = Math.min(0.05, Math.max(0.005, (nowMs - lastTickMs) / 1000));
      lastTickMs = nowMs;

      pitchAnalyser.getFloatTimeDomainData(sampleBuf);
      const pitch = detectPitchFFT(sampleBuf, ctx.sampleRate, {
        minHz: 75,
        maxHz: 1100,
        rmsThreshold: 0.012,
      });

      if (pitch.voiced && pitch.frequencyHz > 0) {
        const midi = freqToMidi(pitch.frequencyHz);
        const snapped = snapMidiToScale(midi, key, scale);
        const strengthNorm = Math.max(0, Math.min(1, strength / 100));
        const targetShift = Math.max(-4, Math.min(4, snapped.shiftSemitones * strengthNorm));
        const alpha = 0.25 + strengthNorm * 0.65;
        smoothedShiftSemitones += alpha * (targetShift - smoothedShiftSemitones);

        state = {
          enabled,
          detectedHz: Math.round(pitch.frequencyHz * 10) / 10,
          detectedNote: snapped.detectedNote,
          targetHz: Math.round(midiToFreq(snapped.targetMidi) * 10) / 10,
          targetNote: snapped.targetNote,
          centsOffset: snapped.centsOffset,
          shiftSemitones: Math.round(smoothedShiftSemitones * 100) / 100,
          voiced: true,
        };
      } else {
        smoothedShiftSemitones *= 0.8;
        state = {
          ...state,
          enabled,
          voiced: false,
          shiftSemitones: Math.round(smoothedShiftSemitones * 100) / 100,
        };
      }

      if (enabled) {
        const ratio = Math.pow(2, smoothedShiftSemitones / 12);
        // Doppler delay ramp: d(delay)/dt = 1 - ratio
        const phaseStep = ((1 - ratio) / windowSec) * dtSec;
        phase = ((phase + phaseStep) % 1 + 1) % 1;
        const phaseB = (phase + 0.5) % 1;

        const now = ctx.currentTime;
        // Raised-cosine crossfade window between dual taps eliminates wrap clicks
        const winA = Math.sin(Math.PI * phase);
        const winB = Math.sin(Math.PI * phaseB);

        delayA.delayTime.setTargetAtTime(0.004 + phase * windowSec, now, 0.006);
        delayB.delayTime.setTargetAtTime(0.004 + phaseB * windowSec, now, 0.006);
        gainA.gain.setTargetAtTime(winA * winA, now, 0.006);
        gainB.gain.setTargetAtTime(winB * winB, now, 0.006);
      }
    };

    const timer = window.setInterval(tick, 18);

    return {
      input,
      output,
      updateOptions(opts: Partial<RealtimeAutoTuneOptions>) {
        if (opts.key !== undefined) key = opts.key;
        if (opts.scale !== undefined) scale = opts.scale;
        if (opts.strength !== undefined) strength = opts.strength;
        if (opts.enabled !== undefined && opts.enabled !== enabled) {
          enabled = opts.enabled;
          setMix(enabled);
          state = { ...state, enabled };
        }
      },
      getState() {
        return { ...state };
      },
      dispose() {
        window.clearInterval(timer);
        try {
          input.disconnect();
          pitchAnalyser.disconnect();
          dryGain.disconnect();
          wetGain.disconnect();
          delayA.disconnect();
          delayB.disconnect();
          gainA.disconnect();
          gainB.disconnect();
          output.disconnect();
        } catch {
          // ignore disconnect errors
        }
      },
    };
  }

  createTrackEqualizer(ctx: BaseAudioContext, initialEq?: TrackEqSettings): TrackEqualizerHandle {
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';

    low.connect(mid);
    mid.connect(high);

    const applyValues = (eqIn: TrackEqSettings, smooth: boolean) => {
      const eq = clampTrackEq(eqIn);
      const now = ctx.currentTime;
      const lg = eq.enabled ? eq.lowGainDb : 0;
      const mg = eq.enabled ? eq.midGainDb : 0;
      const hg = eq.enabled ? eq.highGainDb : 0;

      if (smooth) {
        low.frequency.setTargetAtTime(eq.lowFreqHz, now, 0.015);
        low.gain.setTargetAtTime(lg, now, 0.015);
        mid.frequency.setTargetAtTime(eq.midFreqHz, now, 0.015);
        mid.Q.setTargetAtTime(eq.midQ, now, 0.015);
        mid.gain.setTargetAtTime(mg, now, 0.015);
        high.frequency.setTargetAtTime(eq.highFreqHz, now, 0.015);
        high.gain.setTargetAtTime(hg, now, 0.015);
      } else {
        low.frequency.setValueAtTime(eq.lowFreqHz, now);
        low.gain.setValueAtTime(lg, now);
        mid.frequency.setValueAtTime(eq.midFreqHz, now);
        mid.Q.setValueAtTime(eq.midQ, now);
        mid.gain.setValueAtTime(mg, now);
        high.frequency.setValueAtTime(eq.highFreqHz, now);
        high.gain.setValueAtTime(hg, now);
      }
    };

    applyValues(initialEq ?? DEFAULT_TRACK_EQ, false);

    return {
      input: low,
      output: high,
      updateEq(nextEq: TrackEqSettings) {
        applyValues(nextEq, true);
      },
      dispose() {
        try {
          low.disconnect();
          mid.disconnect();
          high.disconnect();
        } catch {
          // ignore
        }
      },
    };
  }

  createRealtimeDynamicsProcessor(
    ctx: AudioContext,
    options: DynamicsProcessorOptions
  ): RealtimeDynamicsHandle {
    let enabled = options.enabled;
    let currentOpts: DynamicsProcessorOptions = { ...options };

    const input = ctx.createGain();
    const output = ctx.createGain();
    const dryGain = ctx.createGain();
    const wetGain = ctx.createGain();

    // Stage 1: Vocal Dynamics Compressor
    const compressor = ctx.createDynamicsCompressor();
    // Stage 2: Makeup Gain
    const makeupGain = ctx.createGain();
    // Stage 3: Fast Brickwall Limiter (ratio 20:1, 1ms attack, 0dB knee)
    const limiter = ctx.createDynamicsCompressor();
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.05;

    // Stage 4: Hard ceiling WaveShaper safety guard
    const ceilingGuard = ctx.createWaveShaper();
    const makeCeilingCurve = (ceilingDb: number) => {
      const ceil = dbToLinear(Math.min(-0.05, Math.max(-6, ceilingDb)));
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const x = (i * 2) / 1023 - 1;
        curve[i] = Math.max(-ceil, Math.min(ceil, x));
      }
      return curve;
    };

    input.connect(dryGain);
    dryGain.connect(output);

    input.connect(compressor);
    compressor.connect(makeupGain);
    makeupGain.connect(limiter);
    limiter.connect(ceilingGuard);
    ceilingGuard.connect(wetGain);
    wetGain.connect(output);

    const applyParams = (smooth: boolean) => {
      const now = ctx.currentTime;
      const setParam = (p: AudioParam, val: number) => {
        if (smooth) p.setTargetAtTime(val, now, 0.015);
        else p.setValueAtTime(val, now);
      };
      setParam(compressor.threshold, currentOpts.thresholdDb);
      setParam(compressor.knee, currentOpts.kneeDb);
      setParam(compressor.ratio, currentOpts.ratio);
      setParam(compressor.attack, currentOpts.attackSec);
      setParam(compressor.release, currentOpts.releaseSec);
      setParam(makeupGain.gain, dbToLinear(currentOpts.makeupGainDb));
      setParam(limiter.threshold, currentOpts.limiterCeilingDb);
      ceilingGuard.curve = makeCeilingCurve(currentOpts.limiterCeilingDb);

      setParam(dryGain.gain, enabled ? 0.0 : 1.0);
      setParam(wetGain.gain, enabled ? 1.0 : 0.0);
    };

    applyParams(false);

    return {
      input,
      output,
      updateOptions(opts: Partial<DynamicsProcessorOptions>) {
        currentOpts = { ...currentOpts, ...opts };
        if (opts.enabled !== undefined) enabled = opts.enabled;
        applyParams(true);
      },
      getState() {
        const compRed = enabled ? Number(compressor.reduction.toFixed(1)) : 0;
        const limRed = enabled ? Number(limiter.reduction.toFixed(1)) : 0;
        return {
          enabled,
          reductionDb: compRed,
          limiterReductionDb: limRed,
          limiting: enabled && limRed < -0.2,
        };
      },
      dispose() {
        try {
          input.disconnect();
          dryGain.disconnect();
          wetGain.disconnect();
          compressor.disconnect();
          makeupGain.disconnect();
          limiter.disconnect();
          ceilingGuard.disconnect();
          output.disconnect();
        } catch {
          // ignore
        }
      },
    };
  }

  createSpectrumAnalyser(ctx: AudioContext, fftSize = 2048): AnalyserNode {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0.78;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -10;
    return analyser;
  }

  async renderEffects(buffer: AudioBuffer, effects: EffectSettings): Promise<AudioBuffer> {
    const anyActive =
      effects.studioPolish ||
      effects.noiseGate ||
      effects.dynamicsProcessor ||
      effects.autoTune ||
      effects.cleanNoise ||
      effects.removeEcho ||
      effects.autoLevel ||
      effects.warmRadio ||
      effects.breathSoftener ||
      effects.fadeInSec > 0 ||
      effects.fadeOutSec > 0;

    if (!anyActive) {
      return buffer;
    }

    const ctx = this.getAudioContext();
    const preProcessed = applyPrePcmDsp(buffer, ctx, effects);

    const offline = new OfflineAudioContext(
      buffer.numberOfChannels,
      buffer.length,
      buffer.sampleRate
    );

    const wetSource = offline.createBufferSource();
    wetSource.buffer = preProcessed;

    // When noise gate / dynamics / auto-tune / cleanup / studio polish is active, keep dry blend clean
    const drySource = offline.createBufferSource();
    drySource.buffer =
      effects.noiseGate ||
      effects.dynamicsProcessor ||
      effects.autoTune ||
      effects.cleanNoise ||
      effects.studioPolish
        ? preProcessed
        : buffer;

    let currentNode: AudioNode = wetSource;
    const isMusic = effects.profile === 'music';

    // High-pass rumble & plosive filter
    if (effects.studioPolish || effects.cleanNoise || effects.breathSoftener) {
      const hp = offline.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = isMusic ? Math.min(45, effects.highPassHz) : effects.highPassHz;
      hp.Q.value = 0.75;
      currentNode.connect(hp);
      currentNode = hp;
    }

    // Remove Room Echo: tame boxy 250-450Hz room resonance
    if (effects.removeEcho) {
      const boxyCut = offline.createBiquadFilter();
      boxyCut.type = 'peaking';
      boxyCut.frequency.value = 340;
      boxyCut.Q.value = 1.4;
      boxyCut.gain.value = -4.5;
      currentNode.connect(boxyCut);
      currentNode = boxyCut;
    }

    // Studio Voice Polish: clarity presence boost + mud cut + smooth vocal compressor
    if (effects.studioPolish) {
      const mudCut = offline.createBiquadFilter();
      mudCut.type = 'peaking';
      mudCut.frequency.value = 260;
      mudCut.Q.value = 1.2;
      mudCut.gain.value = isMusic ? -1.5 : -2.8;

      const presence = offline.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = isMusic ? 3800 : 3100;
      presence.Q.value = 1.0;
      presence.gain.value = isMusic ? 2.0 : 3.4;

      const air = offline.createBiquadFilter();
      air.type = 'highshelf';
      air.frequency.value = 10000;
      air.gain.value = 1.8;

      currentNode.connect(mudCut);
      mudCut.connect(presence);
      presence.connect(air);
      currentNode = air;
    }

    // Warm Radio / Podcast Tone
    if (effects.warmRadio) {
      const warmth = offline.createBiquadFilter();
      warmth.type = 'lowshelf';
      warmth.frequency.value = 190;
      warmth.gain.value = isMusic ? 2.5 : 4.2;

      const gentleTop = offline.createBiquadFilter();
      gentleTop.type = 'highshelf';
      gentleTop.frequency.value = 8500;
      gentleTop.gain.value = -1.5;

      // Subtle analog harmonic saturation via WaveShaperNode
      const shaper = offline.createWaveShaper();
      const curve = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
        const x = (i * 2) / 255 - 1;
        curve[i] = Math.tanh(x * 1.25) / Math.tanh(1.25);
      }
      shaper.curve = curve;

      currentNode.connect(warmth);
      warmth.connect(gentleTop);
      gentleTop.connect(shaper);
      currentNode = shaper;
    }

    // Breath, Pop & Sibilance Softener (de-esser around 6-8 kHz)
    if (effects.breathSoftener) {
      const deEsser = offline.createBiquadFilter();
      deEsser.type = 'peaking';
      deEsser.frequency.value = effects.deEsserFreqHz;
      deEsser.Q.value = 2.6;
      deEsser.gain.value = -5.5;
      currentNode.connect(deEsser);
      currentNode = deEsser;
    }

    // Smooth Broadcast Dynamics Compressor
    if (effects.studioPolish || effects.autoLevel || effects.warmRadio) {
      const comp = offline.createDynamicsCompressor();
      comp.threshold.value = isMusic ? -16 : -20;
      comp.knee.value = 16;
      comp.ratio.value = isMusic ? Math.min(2.5, effects.compressorRatio) : effects.compressorRatio;
      comp.attack.value = isMusic ? 0.015 : 0.005;
      comp.release.value = 0.16;

      currentNode.connect(comp);
      currentNode = comp;
    }

    // Wet/Dry parallel blend (0-100%)
    const wetRatio = Math.max(0, Math.min(1, effects.wetDry / 100));
    const wetGain = offline.createGain();
    wetGain.gain.value = wetRatio;
    const dryGain = offline.createGain();
    dryGain.gain.value = 1 - wetRatio;

    const masterGain = offline.createGain();
    masterGain.gain.setValueAtTime(1, 0);

    // Smooth Fade In & Fade Out
    if (effects.fadeInSec > 0) {
      const fi = Math.min(effects.fadeInSec, buffer.duration * 0.45);
      masterGain.gain.setValueAtTime(0.0001, 0);
      masterGain.gain.linearRampToValueAtTime(1.0, fi);
    }
    if (effects.fadeOutSec > 0) {
      const fo = Math.min(effects.fadeOutSec, buffer.duration * 0.45);
      const startOut = Math.max(0, buffer.duration - fo);
      masterGain.gain.setValueAtTime(1.0, startOut);
      masterGain.gain.linearRampToValueAtTime(0.0001, buffer.duration);
    }

    currentNode.connect(wetGain);
    drySource.connect(dryGain);
    wetGain.connect(masterGain);
    dryGain.connect(masterGain);
    masterGain.connect(offline.destination);

    wetSource.start(0);
    drySource.start(0);

    return offline.startRendering();
  }

  /**
   * 3-Lane Creator Mixer with real Voice-Envelope Auto-Ducking!
   */
  async renderMix(voiceBuffer: AudioBuffer, mixer: MixerState): Promise<AudioBuffer> {
    const sr = voiceBuffer.sampleRate;
    const duration = voiceBuffer.duration;
    const length = Math.ceil(duration * sr);
    const offline = new OfflineAudioContext(2, length, sr);

    // Lane 1: Main Voice
    if (!mixer.voiceMuted && mixer.voiceVolume > 0) {
      const vSrc = offline.createBufferSource();
      vSrc.buffer = voiceBuffer;
      const vGain = offline.createGain();
      vGain.gain.value = mixer.voiceVolume;
      vSrc.connect(vGain);
      vGain.connect(offline.destination);
      vSrc.start(0);
    }

      // Lane 2: Background Music with continuous Envelope-Following Auto-Ducking Gain Automation!
      if (mixer.musicBuffer && !mixer.musicMuted && mixer.musicVolume > 0) {
        const mSrc = offline.createBufferSource();
        mSrc.buffer = mixer.musicBuffer;
        mSrc.loop = true;

        const mGain = offline.createGain();
        const baseVol = Math.max(0.0001, mixer.musicVolume);

        if (mixer.autoDucking && duration > 0.1) {
          const { gainCurve } = computeAutoDuckingCurve(
            extractChannels(voiceBuffer),
            sr,
            {
              baseVolume: baseVol,
              duckAmountDb: mixer.duckAmountDb || -12,
              thresholdDb: mixer.duckThresholdDb ?? -34,
              attackMs: mixer.duckAttackMs ?? 45,
              holdMs: mixer.duckHoldMs ?? 180,
              releaseMs: mixer.duckReleaseMs ?? 380,
              lookAheadMs: 40,
              pointsPerSec: 50,
            }
          );

          // Bake smooth end fade-out directly into the automation curve so there are zero Web Audio scheduling conflicts
          if (duration > 1.2) {
            const fadePoints = Math.min(gainCurve.length - 1, Math.floor(50 * 0.9));
            const startFade = gainCurve.length - fadePoints;
            for (let i = startFade; i < gainCurve.length; i++) {
              const t = (i - startFade) / Math.max(1, fadePoints - 1);
              gainCurve[i] = Math.max(0.0001, gainCurve[i] * (1 - t));
            }
          }

          mGain.gain.setValueCurveAtTime(gainCurve, 0, Math.max(0.05, duration - 0.005));
        } else {
          mGain.gain.setValueAtTime(baseVol, 0);
          if (duration > 1.2) {
            mGain.gain.setValueAtTime(baseVol, duration - 1.0);
            mGain.gain.linearRampToValueAtTime(0.0001, duration);
          }
        }

        mSrc.connect(mGain);
        mGain.connect(offline.destination);
        mSrc.start(0);
      }

    // Lane 3: Sound Effects / Extra Clips placed at timestamps
    if (!mixer.sfxMuted && mixer.sfxVolume > 0 && mixer.sfxPlacements.length > 0) {
      for (const sfx of mixer.sfxPlacements) {
        if (!sfx.buffer) continue;
        const sSrc = offline.createBufferSource();
        sSrc.buffer = sfx.buffer;
        const sGain = offline.createGain();
        sGain.gain.value = mixer.sfxVolume * sfx.volume;
        sSrc.connect(sGain);
        sGain.connect(offline.destination);
        sSrc.start(Math.max(0, Math.min(duration - 0.05, sfx.time)));
      }
    }

    return offline.startRendering();
  }

  /**
   * Render multiple overlaid AudioBuffer tracks with per-track Gain, Stereo Panning,
   * Solo/Mute routing, and timeline start offsets into a stereo master AudioBuffer.
   */
  async renderMultiTrack(tracks: OverlayTrack[]): Promise<AudioBuffer> {
    if (tracks.length === 0) {
      return this.getAudioContext().createBuffer(2, 44100, 44100);
    }

    const sampleRate = tracks[0].buffer.sampleRate || 44100;
    const totalDuration = Math.max(
      0.1,
      ...tracks.map((t) => Math.max(0, t.offsetSec) + t.buffer.duration)
    );
    const totalLength = Math.max(1, Math.ceil(totalDuration * sampleRate));
    const offline = new OfflineAudioContext(2, totalLength, sampleRate);

    const paramsMap = computeTrackPlaybackParams(tracks);

    for (const track of tracks) {
      const p = paramsMap[track.id];
      if (!p || !p.audible || p.effectiveGain <= 0) continue;

      const src = offline.createBufferSource();
      src.buffer = track.buffer;

      let node: AudioNode = src;
      if (isTrackEqActive(track.eq)) {
        const eqHandle = this.createTrackEqualizer(offline, track.eq);
        node.connect(eqHandle.input);
        node = eqHandle.output;
      }

      const gainNode = offline.createGain();
      gainNode.gain.value = p.effectiveGain;
      node.connect(gainNode);

      if (typeof offline.createStereoPanner === 'function') {
        const panner = offline.createStereoPanner();
        panner.pan.value = p.pan;
        gainNode.connect(panner);
        panner.connect(offline.destination);
      } else {
        gainNode.connect(offline.destination);
      }

      src.start(Math.max(0, track.offsetSec));
    }

    return offline.startRendering();
  }

  captureNoiseProfile(
    buffer: AudioBuffer,
    range?: { startSec: number; endSec: number }
  ): NoiseProfile {
    return estimateNoiseProfileFFT(extractChannels(buffer), buffer.sampleRate, {
      startSec: range?.startSec,
      endSec: range?.endSec,
      fftSize: 1024,
    });
  }

  applySpectralNoiseReduction(
    buffer: AudioBuffer,
    profile: NoiseProfile,
    options: SpectralDenoiseOptions
  ): { buffer: AudioBuffer; noiseReducedDb: number } {
    const result = applySpectralSubtractionPCM(
      extractChannels(buffer),
      buffer.sampleRate,
      profile,
      options
    );
    const outBuf = createAudioBufferFromChannels(
      this.getAudioContext(),
      result.channels,
      buffer.sampleRate
    );
    return { buffer: outBuf, noiseReducedDb: result.noiseReducedDb };
  }

  analyzeMastering(buffer: AudioBuffer, target: MasteringTarget = 'podcast'): MasteringPlan {
    return analyzeForMastering(extractChannels(buffer), buffer.sampleRate, target);
  }

  async applyProMaster(
    buffer: AudioBuffer,
    plan: MasteringPlan
  ): Promise<{ buffer: AudioBuffer; afterAnalysis: MasteringAnalysis; maxReductionDb: number }> {
    const result = applyMasteringChainPCM(extractChannels(buffer), buffer.sampleRate, plan);
    const masteredBuffer = createAudioBufferFromChannels(
      this.getAudioContext(),
      result.channels,
      buffer.sampleRate
    );
    return {
      buffer: masteredBuffer,
      afterAnalysis: result.afterAnalysis,
      maxReductionDb: result.maxReductionDb,
    };
  }

  rebalanceSoundElements(
    buffer: AudioBuffer,
    settings: SoundBalanceSettings,
    range?: { startSec: number; endSec: number }
  ): AudioBuffer {
    const channels = rebalanceSoundElementsPCM(
      extractChannels(buffer),
      buffer.sampleRate,
      settings,
      range
    );
    return createAudioBufferFromChannels(this.getAudioContext(), channels, buffer.sampleRate);
  }

  transformAudioRegion(buffer: AudioBuffer, options: RegionTransformOptions): AudioBuffer {
    const channels = transformAudioRegionPCM(
      extractChannels(buffer),
      buffer.sampleRate,
      options
    );
    return createAudioBufferFromChannels(this.getAudioContext(), channels, buffer.sampleRate);
  }

  normalizeSteadyVolume(
    buffer: AudioBuffer,
    options: SteadyNormalizeOptions
  ): { buffer: AudioBuffer; stats: SteadyNormalizeStats } {
    const result = normalizeSteadyVolumePCM(
      extractChannels(buffer),
      buffer.sampleRate,
      options
    );
    const outBuf = createAudioBufferFromChannels(
      this.getAudioContext(),
      result.channels,
      buffer.sampleRate
    );
    return { buffer: outBuf, stats: result.stats };
  }

  repairClicksAndPlosives(
    buffer: AudioBuffer,
    options?: DeClickOptions
  ): { buffer: AudioBuffer; clicksRepaired: number; plosivesTamed: number } {
    const result = deClickAndDePlosivePCM(
      extractChannels(buffer),
      buffer.sampleRate,
      options
    );
    const outBuf = createAudioBufferFromChannels(
      this.getAudioContext(),
      result.channels,
      buffer.sampleRate
    );
    return {
      buffer: outBuf,
      clicksRepaired: result.clicksRepaired,
      plosivesTamed: result.plosivesTamed,
    };
  }

  reduceRoomReverb(
    buffer: AudioBuffer,
    options?: DeReverbOptions
  ): { buffer: AudioBuffer; echoReducedDb: number } {
    const result = deReverbPCM(extractChannels(buffer), buffer.sampleRate, options);
    const outBuf = createAudioBufferFromChannels(
      this.getAudioContext(),
      result.channels,
      buffer.sampleRate
    );
    return { buffer: outBuf, echoReducedDb: result.echoReducedDb };
  }

  eraseSpectralBox(buffer: AudioBuffer, box: SpectralBoxSelection): AudioBuffer {
    const channels = eraseSpectralBoxPCM(extractChannels(buffer), buffer.sampleRate, box);
    return createAudioBufferFromChannels(this.getAudioContext(), channels, buffer.sampleRate);
  }

  applyAutomationCurve(buffer: AudioBuffer, options: AutomationCurveOptions): AudioBuffer {
    const channels = applyAutomationCurvePCM(extractChannels(buffer), buffer.sampleRate, options);
    return createAudioBufferFromChannels(this.getAudioContext(), channels, buffer.sampleRate);
  }

  async encodeAudio(
    buffer: AudioBuffer,
    options: ExportOptions
  ): Promise<{ blob: Blob; extension: string; mimeType: string; actualBitrateKbps?: number }> {
    let targetBitrate = options.bitrateKbps;
    let targetSampleRate = options.sampleRate;

    if (options.qualityMode === 'targetSize') {
      const calc = calculateBitrateForTargetSize({
        durationSec: buffer.duration,
        targetSizeMb: options.targetSizeMb,
        format: options.format,
        channels: options.channels,
      });
      targetBitrate = calc.recommendedBitrateKbps;
      targetSampleRate = calc.recommendedSampleRate;
    }

    let workingBuffer = buffer;
    if (options.noiseGate?.enabled) {
      const gatedChannels = applyNoiseGatePCM(extractChannels(workingBuffer), workingBuffer.sampleRate, {
        thresholdDb: options.noiseGate.thresholdDb,
        floorGain: options.noiseGate.floorGain ?? 0.025,
      });
      workingBuffer = createAudioBufferFromChannels(
        this.getAudioContext(),
        gatedChannels,
        workingBuffer.sampleRate
      );
    }

    if (options.autoTune?.enabled) {
      const tunedChannels = applyAutoTunePCM(extractChannels(workingBuffer), workingBuffer.sampleRate, {
        key: options.autoTune.key,
        scale: options.autoTune.scale,
        strength: options.autoTune.strength,
      });
      workingBuffer = createAudioBufferFromChannels(
        this.getAudioContext(),
        tunedChannels,
        workingBuffer.sampleRate
      );
    }

    if (isTrackEqActive(options.mainEq)) {
      const offlineEq = new OfflineAudioContext(
        workingBuffer.numberOfChannels,
        workingBuffer.length,
        workingBuffer.sampleRate
      );
      const srcEq = offlineEq.createBufferSource();
      srcEq.buffer = workingBuffer;
      const eqHandle = this.createTrackEqualizer(offlineEq, options.mainEq);
      srcEq.connect(eqHandle.input);
      eqHandle.output.connect(offlineEq.destination);
      srcEq.start(0);
      workingBuffer = await offlineEq.startRendering();
    }

    // Apply Main Track Dynamics Processor (Compressor + Brickwall Limiter) last before encoding to guarantee zero clipping
    if (options.dynamics?.enabled) {
      const dynResult = applyDynamicsProcessorPCM(
        extractChannels(workingBuffer),
        workingBuffer.sampleRate,
        options.dynamics
      );
      workingBuffer = createAudioBufferFromChannels(
        this.getAudioContext(),
        dynResult.channels,
        workingBuffer.sampleRate
      );
    }

    const prepared = await resampleBuffer(workingBuffer, targetSampleRate, options.channels);

    if (options.format === 'wav') {
      const wavBytes = encodeWavPCM(extractChannels(prepared), prepared.sampleRate);
      return {
        blob: new Blob([wavBytes.buffer as ArrayBuffer], { type: 'audio/wav' }),
        extension: 'wav',
        mimeType: 'audio/wav',
      };
    }

    if (options.format === 'flac') {
      const flacBytes = encodeFlacPCM(extractChannels(prepared), prepared.sampleRate);
      return {
        blob: new Blob([flacBytes.buffer as ArrayBuffer], { type: 'audio/flac' }),
        extension: 'flac',
        mimeType: 'audio/flac',
      };
    }

    if (options.format === 'mp3') {
      const blob = encodeMp3Buffer(prepared, targetBitrate);
      return {
        blob,
        extension: 'mp3',
        mimeType: 'audio/mpeg',
        actualBitrateKbps: targetBitrate,
      };
    }

    if (options.format === 'ogg') {
      const mr = await encodeViaMediaRecorder(
        prepared,
        ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus'],
        targetBitrate
      );
      if (mr) {
        return {
          blob: mr.blob,
          extension: mr.mimeType.includes('ogg') ? 'ogg' : 'webm',
          mimeType: mr.mimeType,
          actualBitrateKbps: targetBitrate,
        };
      }
      // Reliable fallback for long audio or browsers without MediaRecorder OGG
      const blob = encodeMp3Buffer(prepared, targetBitrate);
      return {
        blob,
        extension: 'mp3',
        mimeType: 'audio/mpeg',
        actualBitrateKbps: targetBitrate,
      };
    }

    // M4A (AAC in MP4 when MediaRecorder supports it, clean MP3 fallback otherwise)
    const mrM4a = await encodeViaMediaRecorder(
      prepared,
      ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus'],
      targetBitrate
    );
    if (mrM4a && mrM4a.mimeType.includes('mp4')) {
      return {
        blob: mrM4a.blob,
        extension: 'm4a',
        mimeType: mrM4a.mimeType,
        actualBitrateKbps: targetBitrate,
      };
    }
    const fallbackMp3 = encodeMp3Buffer(prepared, targetBitrate);
    return {
      blob: fallbackMp3,
      extension: 'mp3',
      mimeType: 'audio/mpeg',
      actualBitrateKbps: targetBitrate,
    };
  }

  async analyzeRoomNoise(stream: MediaStream, durationMs: number = 2000): Promise<RoomCheckResult> {
    const ctx = this.getAudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);

    const data = new Float32Array(analyser.fftSize);
    const rmsReadings: number[] = [];
    let maxPeak = 0;

    // Also record a short sample blob for optional playback test
    let recorder: MediaRecorder | null = null;
    const chunks: Blob[] = [];
    try {
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.start();
    } catch {
      recorder = null;
    }

    const start = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        analyser.getFloatTimeDomainData(data);
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) {
          const v = data[i];
          sumSq += v * v;
          if (Math.abs(v) > maxPeak) maxPeak = Math.abs(v);
        }
        rmsReadings.push(Math.sqrt(sumSq / data.length));
        if (performance.now() - start >= durationMs) {
          resolve();
        } else {
          setTimeout(tick, 50);
        }
      };
      tick();
    });

    let sampleBlob: Blob | undefined;
    if (recorder && recorder.state !== 'inactive') {
      sampleBlob = await new Promise<Blob>((resolve) => {
        recorder!.onstop = () => resolve(new Blob(chunks, { type: recorder!.mimeType || 'audio/webm' }));
        recorder!.stop();
      });
    }

    src.disconnect();

    const avgRms = rmsReadings.reduce((a, b) => a + b, 0) / Math.max(1, rmsReadings.length);
    const noiseFloorDb = Math.round(linearToDb(avgRms));
    const peakDb = Math.round(linearToDb(maxPeak));

    if (noiseFloorDb < -44) {
      return {
        noiseFloorDb,
        peakDb,
        diagnosis: 'Quiet room — ready to record!',
        recommendation: 'ready',
        sampleBlob,
      };
    }
    if (noiseFloorDb < -26) {
      return {
        noiseFloorDb,
        peakDb,
        diagnosis: 'Background fan or room hum detected — Auto Cleanup recommended.',
        recommendation: 'cleanup',
        sampleBlob,
      };
    }
    return {
      noiseFloorDb,
      peakDb,
      diagnosis: 'Loud background noise detected — move closer to the mic and turn on Noise Cleanup.',
      recommendation: 'too-loud',
      sampleBlob,
    };
  }

  /**
   * Upgraded Full-Canvas Animated Audiogram Video Exporter via HTML5 Canvas + MediaRecorder.
   */
  async generateAudiogram(params: {
    buffer: AudioBuffer;
    title: string;
    artist: string;
    aspect: '9:16' | '1:1';
    theme: 'midnight' | 'sunrise' | 'studio';
    style?: AudiogramStyle;
    coverDataUrl: string | null;
    onProgress?: (pct: number) => void;
  }): Promise<Blob> {
    const width = 720;
    const height = params.aspect === '9:16' ? 1280 : 720;
    const style: AudiogramStyle = params.style ?? 'bars';

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d')!;

    let coverImg: HTMLImageElement | null = null;
    if (params.coverDataUrl) {
      coverImg = await new Promise<HTMLImageElement | null>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = params.coverDataUrl!;
      });
    }

    const ctx = new AudioContext({ sampleRate: params.buffer.sampleRate });
    const src = ctx.createBufferSource();
    src.buffer = params.buffer;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    const dest = ctx.createMediaStreamDestination();
    src.connect(analyser);
    analyser.connect(dest);

    const canvasStream = canvas.captureStream(30);
    const combined = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);

    const mimeTypes = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    const mimeType = mimeTypes.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
    const recorder = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 2_800_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const freqData = new Uint8Array(analyser.frequencyBinCount);
    const timeData = new Uint8Array(analyser.fftSize);
    const peakCaps = new Float32Array(44);
    const particles = createAudiogramParticles(28);
    const maxDur = Math.min(params.buffer.duration, 20);
    const startTime = performance.now();
    let animId = 0;

    const draw = () => {
      const elapsed = (performance.now() - startTime) / 1000;
      const progress = Math.min(1, elapsed / Math.max(0.1, maxDur));
      params.onProgress?.(Math.round(progress * 100));

      analyser.getByteFrequencyData(freqData);
      analyser.getByteTimeDomainData(timeData);

      renderAudiogramFrame({
        ctx: g,
        width,
        height,
        aspect: params.aspect,
        theme: params.theme,
        style,
        title: params.title,
        artist: params.artist,
        coverImg,
        freqData,
        timeData,
        peakCaps,
        particles,
        elapsedSec: elapsed,
        totalDurationSec: maxDur,
        progress,
      });

      if (elapsed < maxDur) {
        animId = requestAnimationFrame(draw);
      }
    };

    const finished = new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        cancelAnimationFrame(animId);
        resolve(new Blob(chunks, { type: mimeType }));
      };
    });

    recorder.start(100);
    src.start(0);
    animId = requestAnimationFrame(draw);

    await new Promise<void>((resolve) => setTimeout(resolve, maxDur * 1000 + 120));
    try {
      src.stop();
    } catch {
      // already ended
    }
    if (recorder.state !== 'inactive') recorder.stop();
    const blob = await finished;
    ctx.close().catch(() => {});
    params.onProgress?.(100);
    return blob;
  }

  /**
   * Re-attach cleaned audio track back onto an imported video file.
   */
  async replaceVideoAudio(
    videoUrl: string,
    cleanedAudio: AudioBuffer,
    onProgress?: (pct: number) => void
  ): Promise<Blob> {
    const video = document.createElement('video');
    video.src = videoUrl;
    video.muted = true;
    video.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Could not load source video for muxing.'));
    });

    const w = Math.min(1280, video.videoWidth || 1280);
    const h = Math.min(720, video.videoHeight || 720);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d')!;

    const ctx = new AudioContext({ sampleRate: cleanedAudio.sampleRate });
    const src = ctx.createBufferSource();
    src.buffer = cleanedAudio;
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);

    const stream = new MediaStream([
      ...canvas.captureStream(30).getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
      : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const maxDur = Math.min(cleanedAudio.duration, video.duration || cleanedAudio.duration, 25);
    const start = performance.now();
    let raf = 0;

    const renderFrame = () => {
      g.drawImage(video, 0, 0, w, h);
      const elapsed = (performance.now() - start) / 1000;
      onProgress?.(Math.min(100, Math.round((elapsed / Math.max(0.1, maxDur)) * 100)));
      if (elapsed < maxDur && !video.ended) {
        raf = requestAnimationFrame(renderFrame);
      }
    };

    const done = new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        cancelAnimationFrame(raf);
        resolve(new Blob(chunks, { type: mimeType }));
      };
    });

    video.currentTime = 0;
    await video.play();
    recorder.start(100);
    src.start(0);
    raf = requestAnimationFrame(renderFrame);

    await new Promise<void>((resolve) => setTimeout(resolve, maxDur * 1000 + 150));
    video.pause();
    try {
      src.stop();
    } catch {
      // ignore
    }
    if (recorder.state !== 'inactive') recorder.stop();
    const out = await done;
    ctx.close().catch(() => {});
    onProgress?.(100);
    return out;
  }
}

export const audioBackend: IAudioBackend = new WebAudioBackend();
