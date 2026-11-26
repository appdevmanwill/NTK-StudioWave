import type {
  AutomationCurveOptions,
  AutomationPoint,
  DeClickOptions,
  DeReverbOptions,
  SpectralBoxSelection,
} from '../types/audio';
import { dbToLinear, linearToDb, mixToMono } from './audioDsp';

/**
 * Lightweight iterative Cooley-Tukey Radix-2 FFT / IFFT (zero extra heap per butterfly).
 */
function fftRadix2InPlace(re: Float32Array, im: Float32Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((2 * Math.PI) / len) * (inverse ? 1 : -1);
    const wLenRe = Math.cos(ang);
    const wLenIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nextWRe = wRe * wLenRe - wIm * wLenIm;
        wIm = wRe * wLenIm + wIm * wLenRe;
        wRe = nextWRe;
      }
    }
  }

  if (inverse) {
    const invN = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= invN;
      im[i] *= invN;
    }
  }
}

function makeHannWindow(size: number): Float32Array {
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return win;
}

/**
 * 100% Rule-Based De-Click, De-Crackle & De-Plosive Repair.
 *
 * Stage 1 (De-Click): Detects sudden impulse clicks/pops via 2nd-order finite-difference
 * spike energy compared to a running local median/EMA baseline and smoothly interpolates
 * across the corrupted impulse samples (2..12 samples) without softening normal speech.
 *
 * Stage 2 (De-Plosive): Separates sub-140 Hz low-end bursts ("P" / "B" microphone thumps)
 * and dynamically attenuates ONLY localized sub-140 Hz bursts when low-end energy exceeds
 * mid-vocal energy by an abnormal ratio, keeping vocal warmth natural everywhere else.
 */
export function deClickAndDePlosivePCM(
  channels: Float32Array[],
  sampleRate: number,
  options: DeClickOptions = {}
): {
  channels: Float32Array[];
  clicksRepaired: number;
  plosivesTamed: number;
} {
  if (channels.length === 0 || channels[0].length === 0 || sampleRate <= 0) {
    return {
      channels: channels.map((c) => new Float32Array(c)),
      clicksRepaired: 0,
      plosivesTamed: 0,
    };
  }

  const sensitivity = Math.max(0, Math.min(100, options.sensitivity ?? 65));
  const removePlosives = options.removePlosives ?? true;
  const plosiveStrength = Math.max(0, Math.min(100, options.plosiveStrength ?? 68)) / 100;

  // Threshold multiplier: higher sensitivity -> lower spike ratio needed to trigger repair
  const spikeRatioThreshold = 9.5 - (sensitivity / 100) * 5.2; // 9.5 (gentle) down to 4.3 (strong)
  const minAbsSpike = 0.045 - (sensitivity / 100) * 0.028;

  let totalClicksRepaired = 0;
  let totalPlosivesTamed = 0;

  // 1-pole crossover coefficients for sub-140 Hz plosive isolation
  const alphaLow = 1 - Math.exp((-2 * Math.PI * 140) / sampleRate);
  const envAtt = 1 - Math.exp(-1 / (sampleRate * 0.004));
  const envRel = 1 - Math.exp(-1 / (sampleRate * 0.045));
  const gainSmooth = 1 - Math.exp(-1 / (sampleRate * 0.008));

  const outChannels = channels.map((src) => {
    const len = src.length;
    const out = new Float32Array(src);

    // Stage 1: Impulse Click & Crackle Repair via 2nd-order residual
    if (sensitivity > 0 && len > 32) {
      let localResidEma = 0.004;
      const emaCoeff = 1 - Math.exp(-1 / (sampleRate * 0.006));
      let i = 2;
      while (i < len - 3) {
        // 2nd-order derivative isolates sharp single/multi-sample clicks cleanly from smooth voice waves
        const d2 = Math.abs(out[i] - 0.5 * (out[i - 1] + out[i + 1]));
        const threshold = Math.max(minAbsSpike, localResidEma * spikeRatioThreshold);

        if (d2 > threshold) {
          // Expand burst bounds up to max 10 samples (0.25 ms @ 44.1 kHz)
          const start = Math.max(1, i - 1);
          let end = i + 1;
          const maxEnd = Math.min(len - 2, i + 10);
          while (end < maxEnd) {
            const nextD2 = Math.abs(out[end] - 0.5 * (out[end - 1] + out[end + 1]));
            if (nextD2 < threshold * 0.45) break;
            end++;
          }

          // Smooth cubic/linear bridge across [start .. end] using clean neighbor anchors
          const leftVal = out[start - 1];
          const rightVal = out[end + 1];
          const span = end - start + 2;
          for (let k = start; k <= end; k++) {
            const t = (k - (start - 1)) / span;
            out[k] = leftVal * (1 - t) + rightVal * t;
          }
          totalClicksRepaired++;
          i = end + 2;
        } else {
          localResidEma += emaCoeff * (Math.max(0.001, d2) - localResidEma);
          i++;
        }
      }
    }

    // Stage 2: Dynamic Sub-140 Hz De-Plosive ("P" / "B" Mic Pop Tamer)
    if (removePlosives && plosiveStrength > 0.01) {
      const alphaMidSidechain = 1 - Math.exp((-2 * Math.PI * 260) / sampleRate);
      let lpLow = 0;
      let lpSide = 0;
      let lowEnv = 0;
      let midEnv = 0;
      let plosiveGain = 1.0;
      let inPlosiveEvent = false;

      for (let i = 0; i < len; i++) {
        const x = out[i];
        // Clean 1-pole complementary crossover at 140 Hz for reconstruction
        lpLow += alphaLow * (x - lpLow);
        const lowBand = lpLow;
        const upperBand = x - lowBand;

        // Separate 260 Hz high-pass sidechain measures true vocal speech without low-end bleed
        lpSide += alphaMidSidechain * (x - lpSide);
        const vocalSide = x - lpSide;

        const absLow = Math.abs(lowBand);
        const absVocal = Math.abs(vocalSide);
        lowEnv += (absLow > lowEnv ? envAtt : envRel) * (absLow - lowEnv);
        midEnv += (absVocal > midEnv ? envAtt : envRel) * (absVocal - midEnv);

        // Plosive burst signature: sudden strong sub-140 Hz surge overpowering mid vocal band
        const ratio = lowEnv / (midEnv + 0.015);
        let targetLowGain = 1.0;
        if (lowEnv > 0.1 && ratio > 1.25) {
          const excess = Math.min(1, (ratio - 1.25) / 1.4);
          targetLowGain = 1 - excess * plosiveStrength * 0.9;
          if (!inPlosiveEvent) {
            inPlosiveEvent = true;
            totalPlosivesTamed++;
          }
        } else if (ratio < 0.95) {
          inPlosiveEvent = false;
        }

        plosiveGain += gainSmooth * (targetLowGain - plosiveGain);
        out[i] = upperBand + lowBand * plosiveGain;
      }
    }

    return out;
  });

  return {
    channels: outChannels,
    clicksRepaired: totalClicksRepaired,
    plosivesTamed: totalPlosivesTamed,
  };
}

/**
 * 100% Rule-Based STFT Room Echo / De-Reverb Reducer.
 * Tracks exponentially decaying late room reflections per frequency bin and smoothly
 * attenuates only the trailing echo tail while keeping direct speech attacks natural.
 */
export function deReverbPCM(
  channels: Float32Array[],
  sampleRate: number,
  options: DeReverbOptions = {}
): {
  channels: Float32Array[];
  echoReducedDb: number;
} {
  if (channels.length === 0 || channels[0].length === 0 || sampleRate <= 0) {
    return { channels: channels.map((c) => new Float32Array(c)), echoReducedDb: 0 };
  }

  const strength = Math.max(0, Math.min(100, options.strength ?? 55)) / 100;
  if (strength <= 0.01) {
    return { channels: channels.map((c) => new Float32Array(c)), echoReducedDb: 0 };
  }

  const decaySec = Math.max(0.08, Math.min(0.65, options.decaySec ?? 0.26));
  const fftSize = 1024;
  const hop = fftSize >> 2; // 75% overlap for artifact-free overlap-add
  const halfBins = (fftSize >> 1) + 1;
  const win = makeHannWindow(fftSize);
  const hopSec = hop / sampleRate;
  // Exponential room tail decay factor per STFT hop
  const tailDecay = Math.exp(-hopSec / decaySec);
  const minFloorGain = 1 - strength * 0.78; // Never fully hard-gate to 0 (avoids metallic gating)

  let energyBefore = 0;
  let energyAfter = 0;

  const outChannels = channels.map((src) => {
    const len = src.length;
    const out = new Float32Array(len);
    const norm = new Float32Array(len);
    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);
    const reverbTailMag = new Float32Array(halfBins);
    const prevGain = new Float32Array(halfBins).fill(1);

    for (let pos = 0; pos < len; pos += hop) {
      re.fill(0);
      im.fill(0);
      for (let i = 0; i < fftSize; i++) {
        const idx = pos + i;
        if (idx < len) {
          re[i] = src[idx] * win[i];
        }
      }

      fftRadix2InPlace(re, im, false);

      for (let k = 0; k < halfBins; k++) {
        const mag = Math.hypot(re[k], im[k]);
        // Estimate late reflection contribution from exponentially decaying past energy
        const lateEst = reverbTailMag[k] * tailDecay;
        const directRatio = mag > 1e-8 ? Math.max(0, mag - lateEst * strength * 0.92) / mag : 1;
        const targetGain = Math.max(minFloorGain, Math.min(1, directRatio));
        // Smooth temporal gain across hops to eliminate musical noise
        const gain = prevGain[k] * 0.35 + targetGain * 0.65;
        prevGain[k] = gain;

        // Update leaky room-tail estimator (delayed slightly so direct onsets aren't self-cancelled)
        reverbTailMag[k] = Math.max(lateEst, mag * 0.55);

        re[k] *= gain;
        im[k] *= gain;
        if (k > 0 && k < fftSize >> 1) {
          const mirror = fftSize - k;
          re[mirror] *= gain;
          im[mirror] *= gain;
        }
      }

      fftRadix2InPlace(re, im, true);

      for (let i = 0; i < fftSize; i++) {
        const idx = pos + i;
        if (idx < len) {
          out[idx] += re[i] * win[i];
          norm[idx] += win[i] * win[i];
        }
      }
    }

    for (let i = 0; i < len; i++) {
      const val = norm[i] > 1e-6 ? out[i] / norm[i] : src[i];
      out[i] = Math.max(-0.995, Math.min(0.995, val));
      energyBefore += src[i] * src[i];
      energyAfter += out[i] * out[i];
    }

    return out;
  });

  const beforeDb = linearToDb(Math.sqrt(energyBefore / Math.max(1, channels[0].length)));
  const afterDb = linearToDb(Math.sqrt(energyAfter / Math.max(1, channels[0].length)));
  const echoReducedDb = Math.max(0, Math.round((beforeDb - afterDb) * 10) / 10);

  return { channels: outChannels, echoReducedDb };
}

/**
 * Compute a lightweight normalized [0..1] Time × Frequency Spectrogram grid
 * for interactive visual inspection & spectral erasing (1GB RAM friendly).
 */
export function computeSpectrogramGrid(
  channels: Float32Array[],
  sampleRate: number,
  options: { maxCols?: number; fftSize?: number; maxHz?: number } = {}
): {
  cols: number;
  rows: number;
  maxHz: number;
  durationSec: number;
  data: Float32Array; // row-major [col * rows + row], row 0 = 0 Hz, row (rows-1) = maxHz
} {
  const fftSize = options.fftSize ?? 512;
  const maxHz = Math.min(sampleRate / 2, options.maxHz ?? 8000);
  const rows = Math.max(16, Math.min((fftSize >> 1) + 1, Math.ceil((maxHz / (sampleRate / 2)) * (fftSize >> 1))));

  if (channels.length === 0 || channels[0].length === 0 || sampleRate <= 0) {
    return { cols: 1, rows, maxHz, durationSec: 0, data: new Float32Array(rows) };
  }

  const mono = mixToMono(channels);
  const durationSec = mono.length / sampleRate;
  const cols = Math.max(24, Math.min(options.maxCols ?? 220, Math.ceil(mono.length / (fftSize >> 1))));
  const data = new Float32Array(cols * rows);
  const win = makeHannWindow(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const step = Math.max(1, (mono.length - fftSize) / Math.max(1, cols - 1));

  for (let c = 0; c < cols; c++) {
    const start = Math.max(0, Math.min(mono.length - 1, Math.floor(c * step)));
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < fftSize; i++) {
      const idx = start + i;
      if (idx < mono.length) re[i] = mono[idx] * win[i];
    }
    fftRadix2InPlace(re, im, false);

    for (let r = 0; r < rows; r++) {
      const mag = Math.hypot(re[r], im[r]) / (fftSize * 0.25);
      const db = linearToDb(mag); // typically -85..0 dB
      const norm = Math.max(0, Math.min(1, (db + 78) / 70));
      data[c * rows + r] = norm;
    }
  }

  return { cols, rows, maxHz, durationSec, data };
}

/**
 * 100% Rule-Based Surgical Spectral Box Eraser.
 * Attenuates ONLY the frequency × time box `[startSec..endSec] × [minHz..maxHz]`
 * using feathered STFT overlap-add so coughs, phone pings, squeaks, or hum tones
 * vanish cleanly while all surrounding speech and frequencies remain untouched.
 */
export function eraseSpectralBoxPCM(
  channels: Float32Array[],
  sampleRate: number,
  box: SpectralBoxSelection
): Float32Array[] {
  if (channels.length === 0 || channels[0].length === 0 || sampleRate <= 0) {
    return channels.map((c) => new Float32Array(c));
  }

  const durationSec = channels[0].length / sampleRate;
  const startSec = Math.max(0, Math.min(durationSec, Math.min(box.startSec, box.endSec)));
  const endSec = Math.max(startSec, Math.min(durationSec, Math.max(box.startSec, box.endSec)));
  const minHz = Math.max(0, Math.min(sampleRate / 2, Math.min(box.minHz, box.maxHz)));
  const maxHz = Math.max(minHz, Math.min(sampleRate / 2, Math.max(box.minHz, box.maxHz)));

  if (endSec - startSec < 0.01 || maxHz - minHz < 15) {
    return channels.map((c) => new Float32Array(c));
  }

  const reductionDb = Math.max(-60, Math.min(-3, box.reductionDb ?? -32));
  const targetAtten = dbToLinear(reductionDb);
  const fftSize = 1024;
  const hop = fftSize >> 2;
  const halfBins = (fftSize >> 1) + 1;
  const binHz = sampleRate / fftSize;
  const win = makeHannWindow(fftSize);

  // Only STFT-process the local window around the box (saves CPU & RAM on long files!)
  const padSamples = fftSize * 2;
  const procStart = Math.max(0, Math.floor(startSec * sampleRate) - padSamples);
  const procEnd = Math.min(channels[0].length, Math.ceil(endSec * sampleRate) + padSamples);
  const procLen = procEnd - procStart;

  const timeFeatherSec = Math.min(0.025, (endSec - startSec) * 0.25);
  const freqFeatherHz = Math.min(120, Math.max(binHz * 1.5, (maxHz - minHz) * 0.15));

  return channels.map((src) => {
    const out = new Float32Array(src);
    const acc = new Float32Array(procLen);
    const norm = new Float32Array(procLen);
    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);

    for (let relPos = 0; relPos < procLen; relPos += hop) {
      re.fill(0);
      im.fill(0);
      for (let i = 0; i < fftSize; i++) {
        const srcIdx = procStart + relPos + i;
        if (srcIdx < procEnd) {
          re[i] = src[srcIdx] * win[i];
        }
      }

      const frameCenterSec = (procStart + relPos + fftSize / 2) / sampleRate;
      let timeMask = 0;
      if (frameCenterSec >= startSec && frameCenterSec <= endSec) {
        const dLeft = timeFeatherSec > 0 ? Math.min(1, (frameCenterSec - startSec) / timeFeatherSec) : 1;
        const dRight = timeFeatherSec > 0 ? Math.min(1, (endSec - frameCenterSec) / timeFeatherSec) : 1;
        timeMask = Math.min(dLeft, dRight);
      }

      if (timeMask > 0.001) {
        fftRadix2InPlace(re, im, false);
        for (let k = 0; k < halfBins; k++) {
          const hz = k * binHz;
          if (hz >= minHz - freqFeatherHz && hz <= maxHz + freqFeatherHz) {
            let freqMask = 1;
            if (hz < minHz) {
              freqMask = Math.max(0, 1 - (minHz - hz) / freqFeatherHz);
            } else if (hz > maxHz) {
              freqMask = Math.max(0, 1 - (hz - maxHz) / freqFeatherHz);
            }
            const mask = timeMask * freqMask;
            const gain = 1 - mask * (1 - targetAtten);
            re[k] *= gain;
            im[k] *= gain;
            if (k > 0 && k < fftSize >> 1) {
              const mirror = fftSize - k;
              re[mirror] *= gain;
              im[mirror] *= gain;
            }
          }
        }
        fftRadix2InPlace(re, im, true);
      }

      for (let i = 0; i < fftSize; i++) {
        const localIdx = relPos + i;
        if (localIdx < procLen) {
          acc[localIdx] += re[i] * win[i];
          norm[localIdx] += win[i] * win[i];
        }
      }
    }

    // Splice smoothly back into untouched surrounding audio
    const fadeLen = Math.min(Math.floor(sampleRate * 0.012), Math.floor(procLen / 4));
    for (let i = 0; i < procLen; i++) {
      const processedSample = norm[i] > 1e-6 ? acc[i] / norm[i] : src[procStart + i];
      let blend = 1;
      if (fadeLen > 1 && i < fadeLen) blend = i / fadeLen;
      else if (fadeLen > 1 && i > procLen - fadeLen) blend = (procLen - i) / fadeLen;
      out[procStart + i] = src[procStart + i] * (1 - blend) + processedSample * blend;
    }

    return out;
  });
}

function sampleAutomationValue(sorted: AutomationPoint[], timeSec: number, defaultValue: number): number {
  if (sorted.length === 0) return defaultValue;
  if (timeSec <= sorted[0].timeSec) return sorted[0].value;
  const last = sorted[sorted.length - 1];
  if (timeSec >= last.timeSec) return last.value;

  // Binary search segment
  let lo = 0;
  let hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].timeSec <= timeSec) lo = mid;
    else hi = mid;
  }
  const a = sorted[lo];
  const b = sorted[hi];
  const span = Math.max(1e-6, b.timeSec - a.timeSec);
  const t = (timeSec - a.timeSec) / span;
  // Smoothstep easing prevents sharp derivative corners during fades
  const smoothT = t * t * (3 - 2 * t);
  return a.value + (b.value - a.value) * smoothT;
}

/**
 * 100% Rule-Based Hand-Drawn Volume & Stereo Pan Automation Processor.
 * Smoothly applies user-drawn keyframes over time with equal-power panning and soft ceiling safety.
 */
export function applyAutomationCurvePCM(
  channels: Float32Array[],
  sampleRate: number,
  options: AutomationCurveOptions
): Float32Array[] {
  if (channels.length === 0 || channels[0].length === 0 || sampleRate <= 0) {
    return channels.map((c) => new Float32Array(c));
  }

  const volSorted = [...(options.volumePoints ?? [])].sort((a, b) => a.timeSec - b.timeSec);
  const panSorted = [...(options.panPoints ?? [])].sort((a, b) => a.timeSec - b.timeSec);
  const hasPan = panSorted.some((p) => Math.abs(p.value) > 0.01);
  const hasVol = volSorted.some((p) => Math.abs(p.value) > 0.05);

  if (!hasVol && !hasPan) {
    return channels.map((c) => new Float32Array(c));
  }

  const len = channels[0].length;
  // Promote mono to stereo automatically when user draws Pan automation
  const outL = new Float32Array(len);
  const outR = channels.length >= 2 || hasPan ? new Float32Array(len) : null;
  const srcL = channels[0];
  const srcR = channels[1] ?? channels[0];

  // Evaluate automation on a fast 2ms control block grid & linearly interpolate between samples
  const blockSize = Math.max(16, Math.floor(sampleRate * 0.002));
  let prevGain = dbToLinear(Math.max(-48, Math.min(12, sampleAutomationValue(volSorted, 0, 0))));
  let prevPan = Math.max(-1, Math.min(1, sampleAutomationValue(panSorted, 0, 0)));

  for (let start = 0; start < len; start += blockSize) {
    const end = Math.min(len, start + blockSize);
    const nextTime = end / sampleRate;
    const nextGain = dbToLinear(Math.max(-48, Math.min(12, sampleAutomationValue(volSorted, nextTime, 0))));
    const nextPan = Math.max(-1, Math.min(1, sampleAutomationValue(panSorted, nextTime, 0)));
    const invSpan = 1 / Math.max(1, end - start);

    for (let i = start; i < end; i++) {
      const frac = (i - start) * invSpan;
      const g = prevGain + (nextGain - prevGain) * frac;
      const pan = prevPan + (nextPan - prevPan) * frac;

      if (outR) {
        // Equal-power stereo panning
        const angle = ((pan + 1) * 0.25) * Math.PI;
        const panL = hasPan ? Math.cos(angle) * Math.SQRT2 : 1;
        const panR = hasPan ? Math.sin(angle) * Math.SQRT2 : 1;
        outL[i] = Math.max(-0.995, Math.min(0.995, srcL[i] * g * Math.min(1.414, panL)));
        outR[i] = Math.max(-0.995, Math.min(0.995, srcR[i] * g * Math.min(1.414, panR)));
      } else {
        outL[i] = Math.max(-0.995, Math.min(0.995, srcL[i] * g));
      }
    }

    prevGain = nextGain;
    prevPan = nextPan;
  }

  return outR ? [outL, outR] : [outL];
}
