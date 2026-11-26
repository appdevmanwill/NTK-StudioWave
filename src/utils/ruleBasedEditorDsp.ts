import type {
  RegionTransformOptions,
  SoundBalanceSettings,
  SoundElementKey,
  SteadyNormalizeOptions,
  SteadyNormalizeStats,
} from '../types/audio';
import { dbToLinear, linearToDb, mixToMono } from './audioDsp';

export const DEFAULT_SOUND_BALANCE: SoundBalanceSettings = {
  leadVoice: 1.0,
  backupVoice: 1.0,
  drums: 1.0,
  keyboard: 1.0,
  bass: 1.0,
  muted: {
    leadVoice: false,
    backupVoice: false,
    drums: false,
    keyboard: false,
    bass: false,
  },
  solo: null,
};

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function makeLowpass(sampleRate: number, freqHz: number, q = 0.7071): BiquadCoeffs {
  const w0 = (2 * Math.PI * Math.min(sampleRate * 0.45, Math.max(20, freqHz))) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function makeHighpass(sampleRate: number, freqHz: number, q = 0.7071): BiquadCoeffs {
  const w0 = (2 * Math.PI * Math.min(sampleRate * 0.45, Math.max(20, freqHz))) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
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

function softLimitSample(x: number, ceilingLin: number): number {
  const abs = Math.abs(x);
  if (abs <= ceilingLin * 0.92) return x;
  const kneeStart = ceilingLin * 0.92;
  const headroom = Math.max(1e-4, ceilingLin - kneeStart);
  const excess = abs - kneeStart;
  const compressed = kneeStart + headroom * Math.tanh(excess / headroom);
  return x < 0 ? -compressed : compressed;
}

/**
 * Resolve effective linear gain for each of the 5 rule-based sound elements,
 * honoring Solo and Mute buttons cleanly.
 */
export function resolveSoundElementGains(
  settings: SoundBalanceSettings
): Record<SoundElementKey, number> {
  const keys: SoundElementKey[] = ['leadVoice', 'backupVoice', 'drums', 'keyboard', 'bass'];
  const out = {} as Record<SoundElementKey, number>;
  for (const k of keys) {
    const isMuted = settings.muted[k] || (settings.solo !== null && settings.solo !== k);
    out[k] = isMuted ? 0 : Math.max(0, Math.min(2.5, settings[k]));
  }
  return out;
}

/**
 * Splice a processed region back into original channels with smooth 15ms linear crossfades
 * at the boundaries so edits never introduce clicks or pops.
 */
function spliceRegionSmoothly(
  original: Float32Array[],
  processedSlice: Float32Array[],
  startIdx: number,
  endIdx: number,
  sampleRate: number
): Float32Array[] {
  const fadeSamples = Math.min(
    Math.floor(sampleRate * 0.015),
    Math.floor(processedSlice[0].length / 4)
  );
  const prefixLen = startIdx;
  const suffixLen = original[0].length - endIdx;
  const newLen = prefixLen + processedSlice[0].length + suffixLen;

  return original.map((origCh, cIdx) => {
    const procCh = processedSlice[cIdx] ?? processedSlice[0];
    const out = new Float32Array(newLen);
    // Copy untouched prefix
    out.set(origCh.subarray(0, prefixLen), 0);
    // Copy processed region
    out.set(procCh, prefixLen);
    // Copy untouched suffix
    out.set(origCh.subarray(endIdx), prefixLen + procCh.length);

    // Smooth boundary crossfades when region length matches or differs
    if (fadeSamples > 2 && prefixLen > 0) {
      for (let i = 0; i < fadeSamples; i++) {
        const t = i / fadeSamples;
        const origSample = origCh[Math.min(origCh.length - 1, prefixLen + i)];
        out[prefixLen + i] = origSample * (1 - t) + procCh[i] * t;
      }
    }
    if (fadeSamples > 2 && suffixLen > 0) {
      const endPos = prefixLen + procCh.length;
      for (let i = 0; i < fadeSamples; i++) {
        const t = i / fadeSamples;
        const idx = endPos - fadeSamples + i;
        const origTailIdx = Math.max(0, endIdx - fadeSamples + i);
        out[idx] = procCh[procCh.length - fadeSamples + i] * (1 - t) + origCh[origTailIdx] * t;
      }
    }
    return out;
  });
}

/**
 * 100% Rule-Based, Lightweight (O(N), Zero-AI, Low-RAM) 5-Element Sound Rebalancer.
 *
 * Decomposes audio into 5 mathematically complementary acoustic layers:
 *   1. Lead Voice     — Center Mid sustained vocal core (220 Hz - 3.6 kHz)
 *   2. Backup Voices  — Wide Side vocal harmony band (280 Hz - 5.0 kHz) + upper vocal air
 *   3. Drums          — Percussive/transient energy via dual-speed envelope attack detector
 *   4. Keyboard/Keys  — Sustained melodic instrument body outside vocal core (keys, guitars, pads)
 *   5. Bass           — Sustained sub-bass & bass guitar fundamental (< 160 Hz)
 *
 * Mathematical invariant: When all 5 gains equal 1.0 (not muted/soloed), the exact sum
 * reconstructs the original audio signal bit-accurately without coloration.
 */
export function rebalanceSoundElementsPCM(
  channels: Float32Array[],
  sampleRate: number,
  settings: SoundBalanceSettings,
  range?: { startSec: number; endSec: number }
): Float32Array[] {
  if (channels.length === 0 || channels[0].length === 0 || sampleRate <= 0) {
    return channels.map((c) => new Float32Array(c));
  }

  const gains = resolveSoundElementGains(settings);
  const allUnity =
    Math.abs(gains.leadVoice - 1) < 1e-4 &&
    Math.abs(gains.backupVoice - 1) < 1e-4 &&
    Math.abs(gains.drums - 1) < 1e-4 &&
    Math.abs(gains.keyboard - 1) < 1e-4 &&
    Math.abs(gains.bass - 1) < 1e-4;

  if (allUnity) {
    return channels.map((c) => new Float32Array(c));
  }

  const totalLen = channels[0].length;
  const hasRange =
    range !== undefined &&
    Number.isFinite(range.startSec) &&
    Number.isFinite(range.endSec) &&
    range.endSec - range.startSec >= 0.05;

  const startIdx = hasRange
    ? Math.max(0, Math.min(totalLen - 1, Math.floor(range!.startSec * sampleRate)))
    : 0;
  const endIdx = hasRange
    ? Math.max(startIdx + 1, Math.min(totalLen, Math.floor(range!.endSec * sampleRate)))
    : totalLen;

  const sliceChs = channels.map((ch) => ch.subarray(startIdx, endIdx));
  const len = sliceChs[0].length;
  const isStereo = sliceChs.length >= 2;

  // Step 1: Mid / Side decomposition (zero extra memory overhead for mono)
  const mid = new Float32Array(len);
  const side = isStereo ? new Float32Array(len) : null;
  if (isStereo && side) {
    const l = sliceChs[0];
    const r = sliceChs[1];
    for (let i = 0; i < len; i++) {
      mid[i] = 0.5 * (l[i] + r[i]);
      side[i] = 0.5 * (l[i] - r[i]);
    }
  } else {
    mid.set(sliceChs[0]);
  }

  // Step 2: Lightweight dual-speed transient / percussive detector for Drums & Percussion
  // Uses 2ms look-ahead + fast-attack/smooth-release mask so sharp kick/snare leading edges are caught cleanly
  const fastAtt = 1 - Math.exp(-1 / (sampleRate * 0.0006));
  const fastRel = 1 - Math.exp(-1 / (sampleRate * 0.025));
  const slowCoeff = 1 - Math.exp(-1 / (sampleRate * 0.14));
  const maskAtt = 1 - Math.exp(-1 / (sampleRate * 0.0008));
  const maskRel = 1 - Math.exp(-1 / (sampleRate * 0.014));
  const lookAhead = Math.min(Math.floor(sampleRate * 0.002), Math.max(0, len - 1));

  const drumsM = new Float32Array(len);
  const harmM = new Float32Array(len);
  const drumsS = side ? new Float32Array(len) : null;
  const harmS = side ? new Float32Array(len) : null;

  let fastEnv = 0;
  let slowEnv = 1e-6;
  let percMask = 0;

  for (let i = 0; i < len; i++) {
    const la = i + lookAhead < len ? i + lookAhead : len - 1;
    const absSignal = side
      ? Math.max(Math.abs(mid[la]), Math.abs(side[la]))
      : Math.abs(mid[la]);
    fastEnv += (absSignal > fastEnv ? fastAtt : fastRel) * (absSignal - fastEnv);
    slowEnv += slowCoeff * (absSignal - slowEnv);

    // Ratio > 1.25 indicates sharp percussive transient (kick/snare/hi-hat click)
    const ratio = fastEnv / (slowEnv + 1e-5);
    const rawPerc = Math.max(0, Math.min(0.95, (ratio - 1.25) / 1.1));
    percMask += (rawPerc > percMask ? maskAtt : maskRel) * (rawPerc - percMask);

    drumsM[i] = mid[i] * percMask;
    harmM[i] = mid[i] - drumsM[i];
    if (side && drumsS && harmS) {
      drumsS[i] = side[i] * percMask;
      harmS[i] = side[i] - drumsS[i];
    }
  }

  // Step 3: Complementary frequency bands on sustained harmonic signals
  // Exact reconstruction invariant: bass + leadVoice + backup + keyboard === harm
  const lpBass = makeLowpass(sampleRate, 160, 0.7071);
  const hpVocalLow = makeHighpass(sampleRate, 220, 0.7071);
  const lpVocalHigh = makeLowpass(sampleRate, 3600, 0.7071);

  const bassM = runBiquad(harmM, lpBass);
  const upperM = new Float32Array(len);
  for (let i = 0; i < len; i++) upperM[i] = harmM[i] - bassM[i];

  // Lead Voice lives in the center Mid vocal formant band (220 Hz - 3.6 kHz)
  const vocalBandM = runBiquad(runBiquad(upperM, hpVocalLow), lpVocalHigh);

  // For mono recordings, split upper harmonic presence (1.8-4.5 kHz sideband harmonic layer)
  // lightly for Backup Voices while keeping exact linear sum = upperM
  let leadM = vocalBandM;
  let backupM: Float32Array;
  let keysM: Float32Array;

  if (isStereo) {
    backupM = new Float32Array(len); // Backup voices live primarily in stereo width (Side channel)
    keysM = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      // Center instruments occupy 160-220 Hz warmth + >3.6 kHz keys/guitar overtones
      keysM[i] = upperM[i] - leadM[i];
    }
  } else {
    // Mono source: separate subtle upper harmony band (>2.2 kHz inside vocal) for Backup Voice control
    const hpHarmony = makeHighpass(sampleRate, 2200, 0.7071);
    const upperHarmony = runBiquad(vocalBandM, hpHarmony);
    leadM = new Float32Array(len);
    backupM = new Float32Array(len);
    keysM = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      backupM[i] = upperHarmony[i] * 0.65;
      leadM[i] = vocalBandM[i] - backupM[i];
      keysM[i] = upperM[i] - vocalBandM[i];
    }
  }

  // Side channel (stereo width): Bass Side (<160 Hz), Backup Voices (280 Hz - 5.0 kHz), Keys/Instruments (remainder)
  let bassS: Float32Array | null = null;
  let backupS: Float32Array | null = null;
  let keysS: Float32Array | null = null;

  if (harmS) {
    bassS = runBiquad(harmS, lpBass);
    const upperS = new Float32Array(len);
    for (let i = 0; i < len; i++) upperS[i] = harmS[i] - bassS[i];

    const hpBack = makeHighpass(sampleRate, 280, 0.7071);
    const lpBack = makeLowpass(sampleRate, 5000, 0.7071);
    const wideVocalBand = runBiquad(runBiquad(upperS, hpBack), lpBack);

    backupS = new Float32Array(len);
    keysS = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      // Stereo backing vocals occupy the upper-mid panned vocal band; stereo keyboards/guitars span the rest
      backupS[i] = wideVocalBand[i] * 0.6;
      keysS[i] = upperS[i] - backupS[i];
    }
  }

  // Step 4: Recombine weighted layers & convert Mid/Side back to Left/Right with safe soft ceiling
  const ceilingLin = dbToLinear(-0.3);
  const processed: Float32Array[] = isStereo
    ? [new Float32Array(len), new Float32Array(len)]
    : [new Float32Array(len)];

  const gLead = gains.leadVoice;
  const gBack = gains.backupVoice;
  const gDrums = gains.drums;
  const gKeys = gains.keyboard;
  const gBass = gains.bass;

  for (let i = 0; i < len; i++) {
    const outM =
      leadM[i] * gLead +
      backupM[i] * gBack +
      drumsM[i] * gDrums +
      keysM[i] * gKeys +
      bassM[i] * gBass;

    if (isStereo && drumsS && bassS && backupS && keysS) {
      const outS =
        backupS[i] * gBack +
        drumsS[i] * gDrums +
        keysS[i] * gKeys +
        bassS[i] * gBass;
      processed[0][i] = softLimitSample(outM + outS, ceilingLin);
      processed[1][i] = softLimitSample(outM - outS, ceilingLin);
    } else {
      processed[0][i] = softLimitSample(outM, ceilingLin);
    }
  }

  if (hasRange) {
    return spliceRegionSmoothly(channels, processed, startIdx, endIdx, sampleRate);
  }
  return processed;
}

/**
 * Measure active speech loudness (LUFS proxy) and fluctuation range (90th - 10th percentile dB
 * across active speech windows above noiseFloorDb).
 */
function measureSpeechDynamics(
  channels: Float32Array[],
  sampleRate: number,
  noiseFloorDb: number
): { lufs: number; rangeDb: number; peakDb: number } {
  const mono = mixToMono(channels);
  const len = mono.length;
  if (len === 0) return { lufs: -60, rangeDb: 0, peakDb: -60 };

  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }

  const winSamples = Math.max(64, Math.floor(sampleRate * 0.25));
  const hopSamples = Math.max(32, Math.floor(winSamples / 2));
  const activeFrameDbs: number[] = [];
  const activeMeanSqs: number[] = [];

  for (let pos = 0; pos + winSamples <= len; pos += hopSamples) {
    let sumSq = 0;
    for (let i = pos; i < pos + winSamples; i++) {
      sumSq += mono[i] * mono[i];
    }
    const meanSq = sumSq / winSamples;
    const db = linearToDb(Math.sqrt(meanSq));
    if (db > noiseFloorDb) {
      activeFrameDbs.push(db);
      activeMeanSqs.push(meanSq);
    }
  }

  if (activeFrameDbs.length === 0) {
    let sumSq = 0;
    for (let i = 0; i < len; i++) sumSq += mono[i] * mono[i];
    const db = linearToDb(Math.sqrt(sumSq / len));
    return {
      lufs: Math.round(Math.max(-60, db - 0.6) * 10) / 10,
      rangeDb: 0,
      peakDb: Math.round(linearToDb(peak) * 10) / 10,
    };
  }

  activeFrameDbs.sort((a, b) => a - b);
  const p10 = activeFrameDbs[Math.floor(activeFrameDbs.length * 0.1)];
  const p90 = activeFrameDbs[Math.min(activeFrameDbs.length - 1, Math.floor(activeFrameDbs.length * 0.9))];
  const avgMeanSq = activeMeanSqs.reduce((a, b) => a + b, 0) / activeMeanSqs.length;
  const lufs = Math.max(-60, Math.min(-3, linearToDb(Math.sqrt(avgMeanSq)) - 0.6));

  return {
    lufs: Math.round(lufs * 10) / 10,
    rangeDb: Math.round(Math.max(0, p90 - p10) * 10) / 10,
    peakDb: Math.round(linearToDb(peak) * 10) / 10,
  };
}

/**
 * Rule-Based Steady Voice Normalizer & Anti-Fluctuation Volume Rider.
 *
 * Solves fluctuating vocal recordings where some words are very quiet and others are loud:
 *  - Mode 'steady': Computes windowed active speech RMS, rides quiet phrases UP (up to maxBoostDb)
 *    and loud phrases DOWN toward targetLufs while leaving background silence untouched via
 *    noiseFloorDb gate, then caps peaks strictly below ceilingDb.
 *  - Mode 'peak': Clean uniform peak normalization to ceilingDb.
 */
export function normalizeSteadyVolumePCM(
  channels: Float32Array[],
  sampleRate: number,
  options: SteadyNormalizeOptions
): { channels: Float32Array[]; stats: SteadyNormalizeStats } {
  if (channels.length === 0 || channels[0].length === 0 || sampleRate <= 0) {
    return {
      channels: channels.map((c) => new Float32Array(c)),
      stats: { beforeLufs: -60, afterLufs: -60, beforeRangeDb: 0, afterRangeDb: 0, peakAfterDb: -60 },
    };
  }

  const noiseFloorDb = options.noiseFloorDb ?? -44;
  const maxBoostDb = Math.max(0, Math.min(24, options.maxBoostDb ?? 18));
  const ceilingDb = Math.max(-6, Math.min(-0.1, options.ceilingDb ?? -1.0));
  const ceilingLin = dbToLinear(ceilingDb);
  const targetRmsDb = Math.max(-30, Math.min(-8, options.targetLufs + 0.6));

  const totalLen = channels[0].length;
  const hasRange =
    options.startSec !== undefined &&
    options.endSec !== undefined &&
    options.endSec - options.startSec >= 0.05;
  const startIdx = hasRange
    ? Math.max(0, Math.min(totalLen - 1, Math.floor(options.startSec! * sampleRate)))
    : 0;
  const endIdx = hasRange
    ? Math.max(startIdx + 1, Math.min(totalLen, Math.floor(options.endSec! * sampleRate)))
    : totalLen;

  const sliceChs = channels.map((ch) => ch.subarray(startIdx, endIdx));
  const len = sliceChs[0].length;
  const before = measureSpeechDynamics(sliceChs, sampleRate, noiseFloorDb);

  const processed = sliceChs.map((ch) => new Float32Array(ch.length));

  if (options.mode === 'peak') {
    let peak = 0;
    for (const ch of sliceChs) {
      for (let i = 0; i < len; i++) {
        const a = Math.abs(ch[i]);
        if (a > peak) peak = a;
      }
    }
    const gain = peak > 1e-6 ? Math.min(dbToLinear(24), ceilingLin / peak) : 1;
    for (let c = 0; c < sliceChs.length; c++) {
      for (let i = 0; i < len; i++) {
        processed[c][i] = Math.max(-ceilingLin, Math.min(ceilingLin, sliceChs[c][i] * gain));
      }
    }
  } else {
    // STEADY VOICE AUTO-LEVELER (Windowed Gain Rider + Noise-Floor Guard + Brickwall Ceiling)
    const mono = mixToMono(sliceChs);
    const frameSec = 0.05; // 50ms control grid (lightweight & responsive)
    const hop = Math.max(16, Math.floor(sampleRate * frameSec));
    const win = hop * 4; // 200ms RMS analysis window
    const numFrames = Math.max(1, Math.ceil(len / hop));
    const frameGainDb = new Float32Array(numFrames);

    // Pass 1: Compute desired gain per 50ms frame with smooth noise-floor transition
    for (let f = 0; f < numFrames; f++) {
      const center = f * hop;
      const wStart = Math.max(0, center - Math.floor(win / 2));
      const wEnd = Math.min(len, wStart + win);
      let sumSq = 0;
      for (let i = wStart; i < wEnd; i++) sumSq += mono[i] * mono[i];
      const rmsDb = linearToDb(Math.sqrt(sumSq / Math.max(1, wEnd - wStart)));

      if (rmsDb <= noiseFloorDb - 4) {
        // Pure room silence — never amplify background hiss
        frameGainDb[f] = 0;
      } else {
        // Smooth transition zone [noiseFloorDb - 4 .. noiseFloorDb + 4]
        const speechConfidence = Math.max(0, Math.min(1, (rmsDb - (noiseFloorDb - 4)) / 8));
        const rawGainDb = targetRmsDb - rmsDb;
        const clampedDb = Math.max(-18, Math.min(maxBoostDb, rawGainDb));
        frameGainDb[f] = clampedDb * speechConfidence;
      }
    }

    // Pass 2: Forward-backward smoothing so volume glides naturally with zero pumping
    const smoothForward = new Float32Array(numFrames);
    smoothForward[0] = frameGainDb[0];
    for (let f = 1; f < numFrames; f++) {
      // Faster attack when cutting sudden loud bursts, gentle release when lifting quiet speech
      const coeff = frameGainDb[f] < smoothForward[f - 1] ? 0.55 : 0.28;
      smoothForward[f] = smoothForward[f - 1] + coeff * (frameGainDb[f] - smoothForward[f - 1]);
    }
    const smoothFinal = new Float32Array(numFrames);
    smoothFinal[numFrames - 1] = smoothForward[numFrames - 1];
    for (let f = numFrames - 2; f >= 0; f--) {
      // Short look-ahead avoids overshooting on sudden loud syllables
      const coeff = smoothForward[f] < smoothFinal[f + 1] ? 0.45 : 0.25;
      smoothFinal[f] = smoothFinal[f + 1] + coeff * (smoothForward[f] - smoothFinal[f + 1]);
    }

    // Pass 3: Sample-interpolated gain application + transparent fast peak limiter at ceilingDb
    const limRelease = 1 - Math.exp(-1 / (sampleRate * 0.045));
    let limGain = 1.0;

    for (let i = 0; i < len; i++) {
      const fPos = i / hop;
      const f0 = Math.min(numFrames - 1, Math.floor(fPos));
      const f1 = Math.min(numFrames - 1, f0 + 1);
      const frac = fPos - f0;
      const gDb = smoothFinal[f0] * (1 - frac) + smoothFinal[f1] * frac;
      const riderLin = dbToLinear(gDb);

      let framePeak = 0;
      for (let c = 0; c < sliceChs.length; c++) {
        const v = Math.abs(sliceChs[c][i] * riderLin);
        if (v > framePeak) framePeak = v;
      }

      const neededLim = framePeak > ceilingLin ? ceilingLin / framePeak : 1.0;
      if (neededLim < limGain) {
        limGain = neededLim; // Instant brickwall catch
      } else {
        limGain += limRelease * (1.0 - limGain);
      }

      const totalGain = riderLin * limGain;
      for (let c = 0; c < sliceChs.length; c++) {
        const s = sliceChs[c][i] * totalGain;
        processed[c][i] = Math.max(-ceilingLin, Math.min(ceilingLin, s));
      }
    }
  }

  const after = measureSpeechDynamics(processed, sampleRate, noiseFloorDb);
  const outChannels = hasRange
    ? spliceRegionSmoothly(channels, processed, startIdx, endIdx, sampleRate)
    : processed;

  return {
    channels: outChannels,
    stats: {
      beforeLufs: before.lufs,
      afterLufs: after.lufs,
      beforeRangeDb: before.rangeDb,
      afterRangeDb: after.rangeDb,
      peakAfterDb: after.peakDb,
    },
  };
}

/**
 * Lightweight Rule-Based WSOLA (Waveform Similarity Overlap-Add) Time-Stretcher.
 * Changes duration by `timeScale` (>1 slows down / lengthens, <1 speeds up / shortens)
 * WITHOUT altering pitch, using minimal memory (single window scratch).
 */
function wsolaTimeStretchChannel(
  input: Float32Array,
  sampleRate: number,
  timeScale: number
): Float32Array {
  if (Math.abs(timeScale - 1) < 1e-4 || input.length < 256) {
    return new Float32Array(input);
  }

  const outLen = Math.max(64, Math.round(input.length * timeScale));
  const out = new Float32Array(outLen);
  const weight = new Float32Array(outLen);

  // ~32ms grain size with 50% overlap Hann window — sweet spot for voice & music on low CPU
  const winSize = Math.min(input.length, Math.max(256, Math.round(sampleRate * 0.032) & ~1));
  const synHop = Math.max(64, Math.floor(winSize / 2));
  const anaHop = synHop / timeScale;
  const searchRadius = Math.min(Math.floor(synHop / 2), Math.round(sampleRate * 0.006));

  const hann = new Float32Array(winSize);
  for (let i = 0; i < winSize; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (winSize - 1)));
  }

  let synPos = 0;
  let frameIndex = 0;

  while (synPos < outLen) {
    const nominalAna = Math.round(frameIndex * anaHop);
    let bestAna = Math.max(0, Math.min(input.length - winSize, nominalAna));

    // Lightweight phase-alignment search against already-written overlap tail (reduces phase flutter)
    if (frameIndex > 0 && searchRadius > 4 && synPos + synHop <= outLen) {
      const refLen = Math.min(128, synHop);
      let bestScore = -Infinity;
      const minCand = Math.max(0, nominalAna - searchRadius);
      const maxCand = Math.min(input.length - winSize, nominalAna + searchRadius);

      for (let cand = minCand; cand <= maxCand; cand += 4) {
        let dot = 0;
        let energy = 1e-8;
        for (let k = 0; k < refLen; k += 2) {
          const a = out[synPos + k];
          const b = input[cand + k];
          dot += a * b;
          energy += b * b;
        }
        const score = dot / Math.sqrt(energy);
        if (score > bestScore) {
          bestScore = score;
          bestAna = cand;
        }
      }
    }

    const copyLen = Math.min(winSize, input.length - bestAna, outLen - synPos);
    for (let i = 0; i < copyLen; i++) {
      const w = hann[i];
      out[synPos + i] += input[bestAna + i] * w;
      weight[synPos + i] += w;
    }

    synPos += synHop;
    frameIndex++;
  }

  for (let i = 0; i < outLen; i++) {
    if (weight[i] > 1e-4) {
      out[i] /= weight[i];
    }
  }
  return out;
}

function resampleChannelLinear(input: Float32Array, targetLen: number): Float32Array {
  if (targetLen === input.length) return new Float32Array(input);
  const out = new Float32Array(Math.max(1, targetLen));
  const ratio = (input.length - 1) / Math.max(1, out.length - 1);
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/**
 * Transform Pitch (semitones), Playback Speed/Rate, and Volume (dB) on either:
 *  - A specific highlighted region (`startSec..endSec`), OR
 *  - The entire audio buffer.
 *
 * Uses lightweight WSOLA time-stretching + linear resampling so:
 *  - Shifting pitch keeps exact duration (zero chipmunk speed-up)
 *  - Changing rate with preservePitch=true keeps natural voice pitch
 *  - Changing rate with preservePitch=false acts as classic tape speed
 *  - Region boundaries are smoothly crossfaded (15ms) with zero clicks.
 */
export function transformAudioRegionPCM(
  channels: Float32Array[],
  sampleRate: number,
  options: RegionTransformOptions
): Float32Array[] {
  if (channels.length === 0 || channels[0].length === 0 || sampleRate <= 0) {
    return channels.map((c) => new Float32Array(c));
  }

  const pitchSemitones = Math.max(-12, Math.min(12, options.pitchSemitones ?? 0));
  const speedRate = Math.max(0.5, Math.min(2.0, options.speedRate ?? 1.0));
  const preservePitch = options.preservePitch ?? true;
  const gainDb = Math.max(-24, Math.min(24, options.gainDb ?? 0));

  const isNoop =
    Math.abs(pitchSemitones) < 1e-3 &&
    Math.abs(speedRate - 1.0) < 1e-3 &&
    Math.abs(gainDb) < 1e-3;
  if (isNoop) {
    return channels.map((c) => new Float32Array(c));
  }

  const totalLen = channels[0].length;
  const hasRange =
    options.startSec !== undefined &&
    options.endSec !== undefined &&
    options.endSec - options.startSec >= 0.05;

  const startIdx = hasRange
    ? Math.max(0, Math.min(totalLen - 1, Math.floor(options.startSec! * sampleRate)))
    : 0;
  const endIdx = hasRange
    ? Math.max(startIdx + 1, Math.min(totalLen, Math.floor(options.endSec! * sampleRate)))
    : totalLen;

  const sliceChs = channels.map((ch) => ch.subarray(startIdx, endIdx));
  const sliceLen = sliceChs[0].length;
  const pitchFactor = Math.pow(2, pitchSemitones / 12);
  const gainLin = dbToLinear(gainDb);
  const ceilingLin = dbToLinear(-0.3);

  const transformedSlice = sliceChs.map((ch) => {
    let working: Float32Array = ch;

    if (preservePitch) {
      // Combine time stretch needed for both speedRate AND pitch compensation in ONE WSOLA pass!
      // Example: pitch +2st (factor 1.122) at 1.0x speed -> stretch by 1.122, then resample back to 1.0x length.
      // Example: speed 1.5x at 0st pitch -> stretch by 1/1.5 = 0.667, no resample needed.
      const combinedStretch = pitchFactor / speedRate;
      if (Math.abs(combinedStretch - 1.0) > 1e-3) {
        working = wsolaTimeStretchChannel(working, sampleRate, combinedStretch);
      }
      const targetLen = Math.max(32, Math.round(sliceLen / speedRate));
      if (Math.abs(pitchFactor - 1.0) > 1e-3 || working.length !== targetLen) {
        working = resampleChannelLinear(working, targetLen);
      }
    } else {
      // Tape speed mode: speedRate changes both tempo and pitch; pitchSemitones shifts extra pitch cleanly
      if (Math.abs(pitchFactor - 1.0) > 1e-3) {
        working = wsolaTimeStretchChannel(working, sampleRate, pitchFactor);
      }
      const targetLen = Math.max(32, Math.round(sliceLen / speedRate));
      working = resampleChannelLinear(working, targetLen);
    }

    // Apply volume gain with safe soft-clipping guard
    const out = new Float32Array(working.length);
    for (let i = 0; i < working.length; i++) {
      out[i] = softLimitSample(working[i] * gainLin, ceilingLin);
    }
    return out;
  });

  if (hasRange) {
    return spliceRegionSmoothly(channels, transformedSlice, startIdx, endIdx, sampleRate);
  }
  return transformedSlice;
}

export interface AutoDuckingConfig {
  baseVolume: number;      // e.g. 0.35
  duckAmountDb: number;    // negative dB, e.g. -12
  thresholdDb?: number;    // speech detection threshold, default -34 dBFS
  attackMs?: number;       // duck down speed, default 45 ms
  holdMs?: number;         // keep ducked between words, default 180 ms
  releaseMs?: number;      // swell back up during pauses, default 380 ms
  lookAheadMs?: number;    // dip slightly before voice onset, default 40 ms
  pointsPerSec?: number;   // automation curve resolution, default 50 Hz (20 ms grid)
}

/**
 * Compute a real continuous envelope-following gain automation curve for the 3-Lane Mixer.
 * Tracks voice speech energy with look-ahead, proportional soft-knee ducking, attack, hold,
 * and smooth musical release so Web Audio `setValueCurveAtTime` and UI visualization match 1:1.
 */
export function computeAutoDuckingCurve(
  voiceChannels: Float32Array[],
  sampleRate: number,
  config: AutoDuckingConfig
): {
  gainCurve: Float32Array;
  voiceEnvelope: Float32Array;
  pointsPerSec: number;
  maxDuckDb: number;
} {
  const pointsPerSec = Math.max(10, Math.min(100, config.pointsPerSec ?? 50));
  const baseVol = Math.max(0.0001, config.baseVolume);
  const duckAmountDb = Math.max(-30, Math.min(-1, config.duckAmountDb));
  const duckMinFactor = dbToLinear(duckAmountDb);
  const thresholdDb = config.thresholdDb ?? -34;
  const attackSec = Math.max(0.01, (config.attackMs ?? 45) / 1000);
  const holdSec = Math.max(0, (config.holdMs ?? 180) / 1000);
  const releaseSec = Math.max(0.04, (config.releaseMs ?? 380) / 1000);
  const lookAheadSec = Math.max(0, (config.lookAheadMs ?? 40) / 1000);

  if (voiceChannels.length === 0 || voiceChannels[0].length === 0 || sampleRate <= 0) {
    return {
      gainCurve: new Float32Array([baseVol, baseVol]),
      voiceEnvelope: new Float32Array([0, 0]),
      pointsPerSec,
      maxDuckDb: 0,
    };
  }

  const mono = mixToMono(voiceChannels);
  const durationSec = mono.length / sampleRate;
  const numPoints = Math.max(2, Math.ceil(durationSec * pointsPerSec));
  const dt = 1 / pointsPerSec;
  const winSamples = Math.max(16, Math.floor(sampleRate * 0.03));
  const lookAheadPoints = Math.round(lookAheadSec * pointsPerSec);
  const holdPoints = Math.round(holdSec * pointsPerSec);

  const rawRmsDb = new Float32Array(numPoints);
  const voiceEnvelope = new Float32Array(numPoints);

  for (let p = 0; p < numPoints; p++) {
    const sampleCenter = Math.min(mono.length - 1, Math.floor(p * dt * sampleRate));
    const start = Math.max(0, sampleCenter - Math.floor(winSamples / 2));
    const end = Math.min(mono.length, start + winSamples);
    let sumSq = 0;
    for (let i = start; i < end; i++) sumSq += mono[i] * mono[i];
    const rms = Math.sqrt(sumSq / Math.max(1, end - start));
    rawRmsDb[p] = linearToDb(rms);
    voiceEnvelope[p] = Math.min(1, rms * 3.5);
  }

  // Adaptive noise-floor calibration: if a real room recording has elevated room hum
  // (e.g. -28 dBFS between sentences), lift effective threshold cleanly above the quiet floor
  // so music swells back up naturally during pauses instead of staying permanently ducked.
  const sortedDb = Float32Array.from(rawRmsDb).sort();
  const quietFloorDb = sortedDb[Math.floor(sortedDb.length * 0.15)] ?? -60;
  const speechPeakDb = sortedDb[Math.floor(sortedDb.length * 0.85)] ?? -16;
  const effectiveThresholdDb =
    speechPeakDb - quietFloorDb > 6
      ? Math.max(thresholdDb, Math.min(speechPeakDb - 6, quietFloorDb + 7))
      : thresholdDb;

  // Envelope follower with look-ahead, soft-knee proportional depth, attack, hold & release
  const attackCoeff = 1 - Math.exp(-dt / attackSec);
  const releaseCoeff = 1 - Math.exp(-dt / releaseSec);
  const kneeWidthDb = 8;

  const gainCurve = new Float32Array(numPoints);
  let currentFactor = 1.0;
  let holdCounter = 0;
  let minFactorSeen = 1.0;

  for (let p = 0; p < numPoints; p++) {
    const lookIdx = Math.min(numPoints - 1, p + lookAheadPoints);
    // Use peak of current & look-ahead frame so ducking anticipates voice onset smoothly
    const sensedDb = Math.max(rawRmsDb[p], rawRmsDb[lookIdx]);

    // Continuous proportional speech activity [0..1] across soft knee around effectiveThresholdDb
    const overDb = sensedDb - (effectiveThresholdDb - kneeWidthDb / 2);
    const activity = Math.max(0, Math.min(1, overDb / kneeWidthDb));
    const targetFactor = 1.0 - activity * (1.0 - duckMinFactor);

    if (targetFactor < currentFactor) {
      // Speech active: attack downward smoothly and refresh hold timer
      currentFactor += attackCoeff * (targetFactor - currentFactor);
      if (activity > 0.25) holdCounter = holdPoints;
    } else if (holdCounter > 0) {
      // Short hold between words avoids jarring pumping
      holdCounter--;
    } else {
      // Pause detected: smooth musical release back up to base volume
      currentFactor += releaseCoeff * (targetFactor - currentFactor);
    }

    if (currentFactor < minFactorSeen) minFactorSeen = currentFactor;
    gainCurve[p] = Math.max(0.0001, baseVol * currentFactor);
  }

  return {
    gainCurve,
    voiceEnvelope,
    pointsPerSec,
    maxDuckDb: Math.round(Math.abs(linearToDb(minFactorSeen)) * 10) / 10,
  };
}

