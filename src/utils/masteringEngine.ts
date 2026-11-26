import type {
  MasteringAnalysis,
  MasteringPlan,
  MasteringTarget,
  MultibandBandSettings,
} from '../types/audio';
import { applyDynamicsProcessorPCM, dbToLinear, linearToDb, mixToMono } from './audioDsp';

export const MASTERING_TARGETS: Record<
  MasteringTarget,
  { label: string; targetLufs: number; ceilingDb: number; desc: string }
> = {
  podcast: {
    label: 'Podcast & Voice (-16 LUFS)',
    targetLufs: -16,
    ceilingDb: -1.0,
    desc: 'Apple Podcasts & Spotify voice standard with clear speech presence and safe headroom.',
  },
  streaming: {
    label: 'Streaming Music (-14 LUFS)',
    targetLufs: -14,
    ceilingDb: -1.0,
    desc: 'Spotify, Apple Music, and YouTube Music loudness target with lush stereo width.',
  },
  broadcast: {
    label: 'YouTube / Broadcast (-14 LUFS)',
    targetLufs: -14,
    ceilingDb: -0.5,
    desc: 'Punchy broadcast balance optimized for video platforms and mobile speakers.',
  },
  club: {
    label: 'Warm & Loud Master (-11 LUFS)',
    targetLufs: -11,
    ceilingDb: -0.3,
    desc: 'High-impact commercial loudness with tight multiband punch and brickwall ceiling.',
  },
};

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function makeLowpassCoeffs(sampleRate: number, freqHz: number, q = 0.7071): BiquadCoeffs {
  const w0 = (2 * Math.PI * Math.min(sampleRate * 0.45, Math.max(20, freqHz))) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cos) / 2) / a0,
    b1: (1 - cos) / a0,
    b2: ((1 - cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function makeHighpassCoeffs(sampleRate: number, freqHz: number, q = 0.7071): BiquadCoeffs {
  const w0 = (2 * Math.PI * Math.min(sampleRate * 0.45, Math.max(20, freqHz))) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cos) / 2) / a0,
    b1: -(1 + cos) / a0,
    b2: ((1 + cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function runBiquad(input: Float32Array, c: BiquadCoeffs): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/**
 * Split a mono/channel signal into 3 complementary frequency bands (Low, Mid, High)
 * using 2nd-order Butterworth crossovers so band summation stays balanced and phase-clean.
 */
function splitThreeBands(
  input: Float32Array,
  sampleRate: number,
  lowCutoffHz: number,
  highCutoffHz: number
): { low: Float32Array; mid: Float32Array; high: Float32Array } {
  const lpLow = makeLowpassCoeffs(sampleRate, lowCutoffHz, 0.7071);
  const hpHigh = makeHighpassCoeffs(sampleRate, highCutoffHz, 0.7071);

  const low = runBiquad(input, lpLow);
  const high = runBiquad(input, hpHigh);

  // Complementary Mid band guarantees exact linear-sum reconstruction: low + mid + high === input
  const mid = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    mid[i] = input[i] - low[i] - high[i];
  }
  return { low, mid, high };
}

function computeRmsDb(pcm: Float32Array): number {
  if (pcm.length === 0) return -96;
  let sumSq = 0;
  for (let i = 0; i < pcm.length; i++) {
    sumSq += pcm[i] * pcm[i];
  }
  return linearToDb(Math.sqrt(sumSq / pcm.length));
}

/**
 * Analyze an audio track's loudness (active gated RMS / LUFS proxy), true peak,
 * crest factor (dynamic range), 3-band spectral energy balance, and stereo correlation.
 */
export function analyzeTrackMetrics(
  channels: Float32Array[],
  sampleRate: number
): MasteringAnalysis {
  if (channels.length === 0 || channels[0].length === 0 || sampleRate <= 0) {
    return {
      integratedLufs: -60,
      peakDb: -60,
      crestFactorDb: 0,
      lowEnergyDb: -60,
      midEnergyDb: -60,
      highEnergyDb: -60,
      stereoCorrelation: 1,
      isMonoSource: true,
    };
  }

  const mono = mixToMono(channels);
  const len = mono.length;

  // Peak across all channels
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  const peakDb = Math.round(linearToDb(peak) * 10) / 10;

  // Gated integrated loudness (400ms blocks above -50 dBFS, ITU-R BS.1770 style proxy)
  const blockSize = Math.max(1, Math.floor(sampleRate * 0.4));
  const blockEnergies: number[] = [];
  for (let pos = 0; pos < len; pos += blockSize) {
    const end = Math.min(len, pos + blockSize);
    let sumSq = 0;
    for (let i = pos; i < end; i++) sumSq += mono[i] * mono[i];
    const meanSq = sumSq / Math.max(1, end - pos);
    if (linearToDb(Math.sqrt(meanSq)) > -50) {
      blockEnergies.push(meanSq);
    }
  }
  const avgMeanSq =
    blockEnergies.length > 0
      ? blockEnergies.reduce((a, b) => a + b, 0) / blockEnergies.length
      : (() => {
          let s = 0;
          for (let i = 0; i < len; i++) s += mono[i] * mono[i];
          return s / len;
        })();
  const rmsDb = linearToDb(Math.sqrt(avgMeanSq));
  // Integrated LUFS proxy calibrated around standard speech/music RMS
  const integratedLufs = Math.round(Math.max(-60, Math.min(-3, rmsDb - 0.6)) * 10) / 10;
  const crestFactorDb = Math.round(Math.max(0, peakDb - rmsDb) * 10) / 10;

  // 3-band spectral energy balance
  const bands = splitThreeBands(mono, sampleRate, 250, 3200);
  const lowEnergyDb = Math.round(computeRmsDb(bands.low) * 10) / 10;
  const midEnergyDb = Math.round(computeRmsDb(bands.mid) * 10) / 10;
  const highEnergyDb = Math.round(computeRmsDb(bands.high) * 10) / 10;

  // Stereo correlation (-1 to +1)
  let stereoCorrelation = 1.0;
  let isMonoSource = channels.length < 2;
  if (channels.length >= 2) {
    const l = channels[0];
    const r = channels[1];
    let dot = 0;
    let sumL2 = 0;
    let sumR2 = 0;
    let diffEnergy = 0;
    const stride = Math.max(1, Math.floor(len / 50000));
    for (let i = 0; i < len; i += stride) {
      dot += l[i] * r[i];
      sumL2 += l[i] * l[i];
      sumR2 += r[i] * r[i];
      const d = l[i] - r[i];
      diffEnergy += d * d;
    }
    const denom = Math.sqrt(sumL2 * sumR2);
    stereoCorrelation = denom > 1e-8 ? Math.max(-1, Math.min(1, dot / denom)) : 1.0;
    isMonoSource = diffEnergy < (sumL2 + sumR2) * 1e-4;
  }

  return {
    integratedLufs,
    peakDb,
    crestFactorDb,
    lowEnergyDb,
    midEnergyDb,
    highEnergyDb,
    stereoCorrelation: Math.round(stereoCorrelation * 100) / 100,
    isMonoSource,
  };
}

/**
 * Automatically calculate an optimal MasteringPlan (3-Band Multiband Compressor,
 * Stereo Enhancer, and Brickwall Limiter) tailored to the track's measured acoustics
 * and the selected destination target.
 */
export function analyzeForMastering(
  channels: Float32Array[],
  sampleRate: number,
  target: MasteringTarget = 'podcast'
): MasteringPlan {
  const analysis = analyzeTrackMetrics(channels, sampleRate);
  const preset = MASTERING_TARGETS[target];
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const round1 = (v: number) => Math.round(v * 10) / 10;

  const isDynamic = analysis.crestFactorDb > 12;
  const isOverCompressed = analysis.crestFactorDb < 7;

  // Spectral tilt relative to Mid band
  const lowVsMid = analysis.lowEnergyDb - analysis.midEnergyDb;
  const highVsMid = analysis.highEnergyDb - analysis.midEnergyDb;

  // Low Band (< 250 Hz): tighten rumble/mud if bass-heavy, gently lift warmth if thin
  const lowThreshold = clamp(round1(analysis.lowEnergyDb - (lowVsMid > 2 ? 4 : 1.5)), -34, -10);
  const lowRatio = clamp(round1(lowVsMid > 2 ? 3.5 : isDynamic ? 2.6 : 2.0), 1.5, 6.0);
  const lowMakeup = clamp(round1(lowVsMid < -6 ? 2.5 : lowVsMid > 3 ? -1.5 : 0.8), -4, 6);

  // Mid Band (250 Hz - 3.2 kHz): core vocal/instrument consistency & presence
  const midThreshold = clamp(round1(analysis.midEnergyDb - (isDynamic ? 3.5 : 2.0)), -32, -10);
  const midRatio = clamp(
    round1(isDynamic ? 3.2 : isOverCompressed ? 1.6 : target === 'club' ? 3.0 : 2.4),
    1.5,
    5.5
  );
  const midMakeup = clamp(round1(isDynamic ? 2.2 : 1.2), -2, 6);

  // High Band (> 3.2 kHz): tame harsh sibilance or add gentle studio air if dull
  const highThreshold = clamp(round1(analysis.highEnergyDb - (highVsMid > -4 ? 4.0 : 1.0)), -36, -12);
  const highRatio = clamp(round1(highVsMid > -4 ? 3.4 : 2.0), 1.5, 5.5);
  const highMakeup = clamp(round1(highVsMid < -12 ? 3.0 : highVsMid > -3 ? -1.0 : 1.4), -4, 6);

  const low: MultibandBandSettings = {
    name: 'Low',
    rangeLabel: '< 250 Hz',
    thresholdDb: lowThreshold,
    ratio: lowRatio,
    attackSec: 0.018,
    releaseSec: 0.16,
    makeupGainDb: lowMakeup,
  };
  const mid: MultibandBandSettings = {
    name: 'Mid',
    rangeLabel: '250 Hz – 3.2 kHz',
    thresholdDb: midThreshold,
    ratio: midRatio,
    attackSec: 0.008,
    releaseSec: 0.12,
    makeupGainDb: midMakeup,
  };
  const high: MultibandBandSettings = {
    name: 'High',
    rangeLabel: '> 3.2 kHz',
    thresholdDb: highThreshold,
    ratio: highRatio,
    attackSec: 0.004,
    releaseSec: 0.08,
    makeupGainDb: highMakeup,
  };

  // Stereo Enhancer calculation
  let width = 1.15;
  if (target === 'podcast') {
    width = analysis.isMonoSource ? 1.12 : 1.15;
  } else if (target === 'streaming' || target === 'club') {
    width = analysis.stereoCorrelation > 0.85 ? 1.32 : 1.18;
  } else {
    width = 1.22;
  }
  const stereoEnhancer = {
    enabled: true,
    width: Math.round(width * 100) / 100,
    monoBelowHz: target === 'podcast' ? 160 : 130,
  };

  // Brickwall Limiter drive calculation: net loudness lift needed to reach target LUFS cleanly
  const neededGainDb = preset.targetLufs - analysis.integratedLufs;
  const driveDb = clamp(round1(neededGainDb), -4, 14);

  const recommendations: string[] = [];
  if (lowVsMid > 2) {
    recommendations.push(
      `Low-end energy is heavy (+${lowVsMid.toFixed(1)} dB vs mids) — Low band tightened at ${lowRatio}:1.`
    );
  } else if (lowVsMid < -6) {
    recommendations.push(
      `Low-end is light — added +${lowMakeup.toFixed(1)} dB warmth in the sub-250 Hz band.`
    );
  } else {
    recommendations.push(
      `Low-mid tonal balance is healthy — gentle ${lowRatio}:1 bass control applied.`
    );
  }

  if (highVsMid < -12) {
    recommendations.push(
      `High frequencies lack studio air — High band boosted +${highMakeup.toFixed(1)} dB above 3.2 kHz.`
    );
  } else if (highVsMid > -3) {
    recommendations.push(
      `Bright upper spectrum detected — High band de-harshed at ${highRatio}:1.`
    );
  } else {
    recommendations.push(
      `Vocal presence and top-end clarity balanced with ${midRatio}:1 mid-band glue.`
    );
  }

  recommendations.push(
    analysis.isMonoSource
      ? `Mono track detected — subtle ${Math.round(stereoEnhancer.width * 100)}% stereo air applied above ${stereoEnhancer.monoBelowHz} Hz while keeping bass mono.`
      : `Stereo width enhanced to ${Math.round(stereoEnhancer.width * 100)}% with tight mono-bass crossover below ${stereoEnhancer.monoBelowHz} Hz.`
  );

  recommendations.push(
    `Brickwall limiter calibrated at ${preset.ceilingDb.toFixed(1)} dBTP (${driveDb >= 0 ? '+' : ''}${driveDb.toFixed(1)} dB drive) toward ${preset.targetLufs} LUFS.`
  );

  return {
    target,
    targetLufs: preset.targetLufs,
    analysis,
    multiband: {
      lowCutoffHz: 250,
      highCutoffHz: 3200,
      low,
      mid,
      high,
    },
    stereoEnhancer,
    limiter: {
      ceilingDb: preset.ceilingDb,
      driveDb,
    },
    recommendations,
  };
}

/**
 * Compress a single mono/multi-channel frequency band with soft-knee feed-forward dynamics.
 */
function compressBand(
  bandChannels: Float32Array[],
  sampleRate: number,
  cfg: MultibandBandSettings
): Float32Array[] {
  const numCh = bandChannels.length;
  const len = bandChannels[0]?.length ?? 0;
  const out = bandChannels.map(() => new Float32Array(len));
  const attackCoeff = 1 - Math.exp(-1 / (sampleRate * Math.max(0.001, cfg.attackSec)));
  const releaseCoeff = 1 - Math.exp(-1 / (sampleRate * Math.max(0.02, cfg.releaseSec)));
  const makeupLin = dbToLinear(cfg.makeupGainDb);
  const kneeDb = 8;
  let envDb = -96;

  for (let i = 0; i < len; i++) {
    let peak = 0;
    for (let c = 0; c < numCh; c++) {
      const a = Math.abs(bandChannels[c][i]);
      if (a > peak) peak = a;
    }
    const inDb = linearToDb(peak);
    const coeff = inDb > envDb ? attackCoeff : releaseCoeff;
    envDb += coeff * (inDb - envDb);

    let grDb = 0;
    const over = envDb - cfg.thresholdDb;
    if (over > -kneeDb / 2 && over < kneeDb / 2) {
      const x = over + kneeDb / 2;
      grDb = ((1 / cfg.ratio - 1) * x * x) / (2 * kneeDb);
    } else if (over >= kneeDb / 2) {
      grDb = (1 / cfg.ratio - 1) * over;
    }

    const gain = dbToLinear(grDb) * makeupLin;
    for (let c = 0; c < numCh; c++) {
      out[c][i] = bandChannels[c][i] * gain;
    }
  }

  return out;
}

/**
 * Apply the complete Mastering Chain in pure Float32 PCM:
 *  1. 3-Band Multiband Compressor (Low / Mid / High)
 *  2. Mid/Side Stereo Enhancer (with mono-compatible bass below monoBelowHz)
 *  3. Brickwall Limiter with strict true-peak ceiling guarantee (zero clipping)
 */
export function applyMasteringChainPCM(
  channels: Float32Array[],
  sampleRate: number,
  plan: MasteringPlan
): { channels: Float32Array[]; afterAnalysis: MasteringAnalysis; maxReductionDb: number } {
  if (channels.length === 0 || channels[0].length === 0 || sampleRate <= 0) {
    return {
      channels: channels.map((c) => new Float32Array(c)),
      afterAnalysis: plan.analysis,
      maxReductionDb: 0,
    };
  }

  const len = channels[0].length;

  // Stage 1: Split every input channel into Low, Mid, High bands
  const lowChs: Float32Array[] = [];
  const midChs: Float32Array[] = [];
  const highChs: Float32Array[] = [];

  for (const ch of channels) {
    const split = splitThreeBands(
      ch,
      sampleRate,
      plan.multiband.lowCutoffHz,
      plan.multiband.highCutoffHz
    );
    lowChs.push(split.low);
    midChs.push(split.mid);
    highChs.push(split.high);
  }

  const compLow = compressBand(lowChs, sampleRate, plan.multiband.low);
  const compMid = compressBand(midChs, sampleRate, plan.multiband.mid);
  const compHigh = compressBand(highChs, sampleRate, plan.multiband.high);

  // Sum compressed multiband channels back together
  let working: Float32Array[] = channels.map((_, c) => {
    const sum = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      sum[i] = compLow[c][i] + compMid[c][i] + compHigh[c][i];
    }
    return sum;
  });

  // Stage 2: Stereo Enhancer (Mid/Side width expansion + mono-bass anchor below monoBelowHz)
  if (plan.stereoEnhancer.enabled && plan.stereoEnhancer.width > 1.005) {
    const width = Math.max(1.0, Math.min(1.6, plan.stereoEnhancer.width));
    const lpBass = makeLowpassCoeffs(sampleRate, plan.stereoEnhancer.monoBelowHz, 0.7071);

    if (working.length === 1) {
      // Promote mono recording into tasteful mono-compatible stereo using frequency-split Haas decorrelation
      const monoIn = working[0];
      const bass = runBiquad(monoIn, lpBass);
      const upper = new Float32Array(len);
      for (let i = 0; i < len; i++) upper[i] = monoIn[i] - bass[i];

      const left = new Float32Array(len);
      const right = new Float32Array(len);
      const delaySamples = Math.max(1, Math.round(sampleRate * 0.007)); // subtle 7ms stereo air tap
      const sideMix = Math.min(0.32, (width - 1.0) * 0.55);

      for (let i = 0; i < len; i++) {
        const delayed = i >= delaySamples ? upper[i - delaySamples] : 0;
        const side = (upper[i] - delayed) * sideMix;
        left[i] = bass[i] + upper[i] + side;
        right[i] = bass[i] + upper[i] - side;
      }
      working = [left, right];
    } else {
      // True stereo Mid/Side processing with mono sub-bass below monoBelowHz
      const l = working[0];
      const r = working[1];
      const midSig = new Float32Array(len);
      const sideSig = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        midSig[i] = 0.5 * (l[i] + r[i]);
        sideSig[i] = 0.5 * (l[i] - r[i]);
      }
      // High-pass the Side channel above monoBelowHz so bass remains tight & centered
      const hpSide = makeHighpassCoeffs(sampleRate, plan.stereoEnhancer.monoBelowHz, 0.7071);
      const cleanSide = runBiquad(sideSig, hpSide);

      const outL = new Float32Array(len);
      const outR = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const enhancedSide = cleanSide[i] * width;
        outL[i] = midSig[i] + enhancedSide;
        outR[i] = midSig[i] - enhancedSide;
      }
      working = [outL, outR];
    }
  }

  // Stage 3: Unity-match post-multiband loudness to pre-master reference so limiter.driveDb
  // predictably brings the track onto targetLufs without unexpected volume loss from compression.
  const preLimitMetrics = analyzeTrackMetrics(working, sampleRate);
  const multibandGainCompDb = Math.max(
    -6,
    Math.min(12, plan.analysis.integratedLufs - preLimitMetrics.integratedLufs)
  );
  const runBrickwallPass = (extraDb: number) => {
    const gainLin = dbToLinear(multibandGainCompDb + plan.limiter.driveDb + extraDb);
    const driven = working.map((ch) => {
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        out[i] = ch[i] * gainLin;
      }
      return out;
    });
    return applyDynamicsProcessorPCM(driven, sampleRate, {
      thresholdDb: Math.max(-12, plan.limiter.ceilingDb - 1.5),
      kneeDb: 3,
      ratio: 10.0,
      attackSec: 0.0015,
      releaseSec: 0.055,
      makeupGainDb: 0,
      limiterCeilingDb: plan.limiter.ceilingDb,
    });
  };

  let limited = runBrickwallPass(0);
  let afterAnalysis = analyzeTrackMetrics(limited.channels, sampleRate);

  // Precision loudness calibration pass: if transient spikes were heavily limited and pulled
  // integrated loudness below the intended target, compensate once cleanly into the brickwall limiter.
  const desiredLufs = Math.min(-6, plan.analysis.integratedLufs + plan.limiter.driveDb);
  if (plan.limiter.driveDb > 0 && afterAnalysis.integratedLufs < desiredLufs - 0.6) {
    const shortfallDb = Math.min(6, desiredLufs - afterAnalysis.integratedLufs);
    limited = runBrickwallPass(shortfallDb);
    afterAnalysis = analyzeTrackMetrics(limited.channels, sampleRate);
  }

  return {
    channels: limited.channels,
    afterAnalysis,
    maxReductionDb: limited.maxReductionDb,
  };
}
