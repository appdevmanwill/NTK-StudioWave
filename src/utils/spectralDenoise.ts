import type { NoiseProfile, SpectralDenoiseOptions } from '../types/audio';
import { dbToLinear, linearToDb, mixToMono } from './audioDsp';
import { fftRadix2 } from './pitchCorrection';

function ifftRadix2(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  for (let i = 0; i < n; i++) imag[i] = -imag[i];
  fftRadix2(real, imag);
  const invN = 1 / n;
  for (let i = 0; i < n; i++) {
    real[i] *= invN;
    imag[i] = -imag[i] * invN;
  }
}

function buildHannWindow(size: number): Float32Array {
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  }
  return win;
}

/**
 * Capture a spectral magnitude profile of the background noise floor (static hiss,
 * fan broadband noise, 50/60/120 Hz AC hum) using STFT analysis.
 *
 * If `range` is provided (e.g. a user-highlighted quiet section), frames are sampled
 * directly from `[startSec, endSec]`. Otherwise, the quietest 15% stationary frames
 * across the entire recording are selected automatically.
 */
export function estimateNoiseProfileFFT(
  channels: Float32Array[],
  sampleRate: number,
  options: {
    startSec?: number;
    endSec?: number;
    fftSize?: number;
  } = {}
): NoiseProfile {
  const fftSize = options.fftSize ?? 1024;
  const halfBins = fftSize / 2 + 1;
  const hop = fftSize / 4;
  const mono = mixToMono(channels);

  if (mono.length < fftSize || sampleRate <= 0) {
    return {
      fftSize,
      sampleRate: sampleRate || 44100,
      binMagnitudes: new Float32Array(halfBins),
      noiseFloorDb: -90,
      dominantHumHz: null,
      sourceLabel: 'Empty track',
      frameCount: 0,
    };
  }

  const win = buildHannWindow(fftSize);
  const hasExplicitRange =
    options.startSec !== undefined &&
    options.endSec !== undefined &&
    options.endSec - options.startSec >= fftSize / sampleRate;

  const startSample = hasExplicitRange
    ? Math.max(0, Math.floor((options.startSec ?? 0) * sampleRate))
    : 0;
  const endSample = hasExplicitRange
    ? Math.min(mono.length, Math.floor((options.endSec ?? mono.length / sampleRate) * sampleRate))
    : mono.length;

  // Gather candidate frame offsets & RMS energies
  const frames: Array<{ offset: number; rms: number }> = [];
  for (let pos = startSample; pos + fftSize <= endSample; pos += hop) {
    let sumSq = 0;
    for (let i = 0; i < fftSize; i++) {
      const s = mono[pos + i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / fftSize);
    // Ignore digital absolute-zero padded regions unless everything is silent
    frames.push({ offset: pos, rms });
  }

  if (frames.length === 0) {
    frames.push({ offset: startSample, rms: 0 });
  }

  let selectedFrames = frames;
  if (!hasExplicitRange) {
    // Filter out pure digital zeros first if non-zero frames exist
    const nonZero = frames.filter((f) => f.rms > 1e-6);
    const pool = nonZero.length >= 4 ? nonZero : frames;
    const sorted = [...pool].sort((a, b) => a.rms - b.rms);
    // Take the quietest 15% of frames (at least 4, up to 48 frames) to represent stationary room noise
    const count = Math.max(4, Math.min(48, Math.ceil(sorted.length * 0.15)));
    selectedFrames = sorted.slice(0, Math.min(sorted.length, count));
  } else if (frames.length > 64) {
    // Evenly subsample up to 64 frames inside explicit range for fast UI response
    const step = frames.length / 64;
    selectedFrames = [];
    for (let i = 0; i < 64; i++) {
      selectedFrames.push(frames[Math.floor(i * step)]);
    }
  }

  const binAccum = new Float32Array(halfBins);
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);
  let totalRms = 0;

  for (const frame of selectedFrames) {
    totalRms += frame.rms;
    for (let i = 0; i < fftSize; i++) {
      real[i] = mono[frame.offset + i] * win[i];
      imag[i] = 0;
    }
    fftRadix2(real, imag);
    for (let b = 0; b < halfBins; b++) {
      binAccum[b] += Math.hypot(real[b], imag[b]);
    }
  }

  const frameCount = Math.max(1, selectedFrames.length);
  const binMagnitudes = new Float32Array(halfBins);
  for (let b = 0; b < halfBins; b++) {
    binMagnitudes[b] = binAccum[b] / frameCount;
  }

  const avgNoiseRms = totalRms / frameCount;
  const noiseFloorDb = Math.round(linearToDb(avgNoiseRms) * 10) / 10;

  // Detect dominant AC / electrical hum tone (45 Hz - 260 Hz) if a narrow peak stands out above neighbors
  const minHumBin = Math.max(1, Math.floor((45 * fftSize) / sampleRate));
  const maxHumBin = Math.min(halfBins - 2, Math.ceil((260 * fftSize) / sampleRate));
  let peakBin = -1;
  let peakMag = 0;
  let sumHumRegion = 0;
  for (let b = minHumBin; b <= maxHumBin; b++) {
    sumHumRegion += binMagnitudes[b];
    if (binMagnitudes[b] > peakMag) {
      peakMag = binMagnitudes[b];
      peakBin = b;
    }
  }
  const avgHumRegion = sumHumRegion / Math.max(1, maxHumBin - minHumBin + 1);
  const dominantHumHz =
    peakBin > 0 && peakMag > avgHumRegion * 1.9 && avgNoiseRms > 1e-5
      ? Math.round((peakBin * sampleRate) / fftSize)
      : null;

  const sourceLabel = hasExplicitRange
    ? `Selection (${(options.startSec ?? 0).toFixed(1)}s–${(options.endSec ?? 0).toFixed(1)}s)`
    : `Auto-detected quiet floor (${frameCount} frames)`;

  return {
    fftSize,
    sampleRate,
    binMagnitudes,
    noiseFloorDb,
    dominantHumHz,
    sourceLabel,
    frameCount,
  };
}

/**
 * Surgical STFT Spectral Subtraction Noise Reduction with Wiener-smoothed gain masking
 * and vocal formant preservation.
 *
 * Removes stationary broadband static hiss and narrowband AC/electrical hum using the
 * captured `NoiseProfile` while protecting high-SNR speech formants (300–3800 Hz)
 * and suppressing "musical noise" via time-frequency gain smoothing and a spectral floor.
 */
export function applySpectralSubtractionPCM(
  channels: Float32Array[],
  sampleRate: number,
  profile: NoiseProfile,
  options: Partial<SpectralDenoiseOptions> = {}
): { channels: Float32Array[]; noiseReducedDb: number } {
  if (channels.length === 0 || channels[0].length === 0 || profile.frameCount === 0) {
    return { channels: channels.map((c) => new Float32Array(c)), noiseReducedDb: 0 };
  }

  const strength = Math.max(0, Math.min(100, options.reductionStrength ?? 75)) / 100;
  const vocalProtection = Math.max(0, Math.min(100, options.vocalProtection ?? 80)) / 100;
  const spectralFloorDb = Math.max(-36, Math.min(-6, options.spectralFloorDb ?? -24));
  const floorGain = dbToLinear(spectralFloorDb);

  if (strength <= 0.001) {
    return { channels: channels.map((c) => new Float32Array(c)), noiseReducedDb: 0 };
  }

  const fftSize = profile.fftSize;
  const halfBins = fftSize / 2 + 1;
  const hop = fftSize / 4; // 75% overlap for artifact-free Hann OLA reconstruction
  const win = buildHannWindow(fftSize);

  // Oversubtraction factor alpha: scales from 0.9 (gentle) to 3.2 (surgical)
  const baseAlpha = 0.8 + strength * 2.4;
  const vocalLowBin = Math.floor((280 * fftSize) / sampleRate);
  const vocalHighBin = Math.ceil((3900 * fftSize) / sampleRate);

  const outChannels: Float32Array[] = [];

  for (const input of channels) {
    const len = input.length;
    const output = new Float32Array(len);
    const normAcc = new Float32Array(len);

    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);
    const prevGain = new Float32Array(halfBins).fill(1.0);
    const currGain = new Float32Array(halfBins);
    const smoothGain = new Float32Array(halfBins);

    for (let pos = 0; pos < len; pos += hop) {
      for (let i = 0; i < fftSize; i++) {
        const idx = pos + i;
        real[i] = idx < len ? input[idx] * win[i] : 0;
        imag[i] = 0;
      }

      fftRadix2(real, imag);

      // Compute per-bin magnitude spectral subtraction gain with vocal clarity preservation
      for (let b = 0; b < halfBins; b++) {
        const mag = Math.hypot(real[b], imag[b]);
        const noiseMag = profile.binMagnitudes[b] ?? 0;

        if (mag <= 1e-9) {
          currGain[b] = floorGain;
          continue;
        }

        const snr = mag / Math.max(1e-9, noiseMag);

        // Protect clear vocal formant bins where speech dominates well above noise floor
        let localAlpha = baseAlpha;
        if (b >= vocalLowBin && b <= vocalHighBin && snr > 2.4) {
          // Smoothly taper subtraction toward 0 on strong speech harmonics so vocal timbre stays intact
          const protectFactor = Math.min(1, (snr - 2.4) / 4.0) * vocalProtection;
          localAlpha = baseAlpha * (1 - 0.85 * protectFactor);
        }

        // Power-domain oversubtraction (Berouti / Ephraim-Malah style)
        const cleanPower = Math.max(0, mag * mag - localAlpha * noiseMag * noiseMag);
        let gain = Math.sqrt(cleanPower) / mag;

        // Clamp to residual spectral floor to prevent harsh hollow musical noise
        if (gain < floorGain) gain = floorGain;
        if (gain > 1.0) gain = 1.0;
        currGain[b] = gain;
      }

      // 3-bin frequency smoothing + temporal attack/release smoothing to eliminate musical noise
      for (let b = 0; b < halfBins; b++) {
        const left = currGain[Math.max(0, b - 1)];
        const mid = currGain[b];
        const right = currGain[Math.min(halfBins - 1, b + 1)];
        const freqSmoothed = 0.2 * left + 0.6 * mid + 0.2 * right;

        // Fast attack (0.65) when speech opens a bin, smoother release (0.35) when closing
        const timeAlpha = freqSmoothed > prevGain[b] ? 0.68 : 0.35;
        const g = prevGain[b] + timeAlpha * (freqSmoothed - prevGain[b]);
        prevGain[b] = g;
        smoothGain[b] = g;
      }

      // Apply symmetric spectral gain mask preserving original phase
      real[0] *= smoothGain[0];
      imag[0] *= smoothGain[0];
      real[fftSize / 2] *= smoothGain[fftSize / 2];
      imag[fftSize / 2] *= smoothGain[fftSize / 2];
      for (let b = 1; b < fftSize / 2; b++) {
        const g = smoothGain[b];
        real[b] *= g;
        imag[b] *= g;
        real[fftSize - b] *= g;
        imag[fftSize - b] *= g;
      }

      ifftRadix2(real, imag);

      // Overlap-add synthesis with Hann synthesis window
      for (let i = 0; i < fftSize; i++) {
        const idx = pos + i;
        if (idx < len) {
          const w = win[i];
          output[idx] += real[i] * w;
          normAcc[idx] += w * w;
        }
      }
    }

    // Normalize OLA envelope and guard against NaN/clipping
    for (let i = 0; i < len; i++) {
      const denom = normAcc[i] > 1e-6 ? normAcc[i] : 1;
      const v = output[i] / denom;
      output[i] = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    }

    outChannels.push(output);
  }

  // Estimate quiet-floor reduction achieved (dB)
  const postProfile = estimateNoiseProfileFFT(outChannels, sampleRate, { fftSize });
  const noiseReducedDb = Math.max(
    0,
    Math.round((profile.noiseFloorDb - postProfile.noiseFloorDb) * 10) / 10
  );

  return { channels: outChannels, noiseReducedDb };
}
