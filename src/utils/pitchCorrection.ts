import type { MusicalKey, MusicalScale } from '../types/audio';
import { mixToMono } from './audioDsp';

export const MUSICAL_KEYS: MusicalKey[] = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
];

export const MUSICAL_SCALES: Record<
  MusicalScale,
  { label: string; intervals: number[]; description: string }
> = {
  chromatic: {
    label: 'Chromatic (All 12)',
    intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    description: 'Snaps to the nearest semitone across all 12 notes.',
  },
  major: {
    label: 'Major',
    intervals: [0, 2, 4, 5, 7, 9, 11],
    description: 'Bright, pop-friendly major scale.',
  },
  minor: {
    label: 'Natural Minor',
    intervals: [0, 2, 3, 5, 7, 8, 10],
    description: 'Emotional, modern vocal minor scale.',
  },
  pentatonicMajor: {
    label: 'Major Pentatonic',
    intervals: [0, 2, 4, 7, 9],
    description: 'Clean 5-note major scale with zero dissonance.',
  },
  pentatonicMinor: {
    label: 'Minor Pentatonic',
    intervals: [0, 3, 5, 7, 10],
    description: 'Classic hip-hop, R&B, and rock vocal scale.',
  },
  blues: {
    label: 'Blues',
    intervals: [0, 3, 5, 6, 7, 10],
    description: 'Expressive minor pentatonic with the blue note.',
  },
  dorian: {
    label: 'Dorian',
    intervals: [0, 2, 3, 5, 7, 9, 10],
    description: 'Smooth jazzy/funk minor mode.',
  },
  mixolydian: {
    label: 'Mixolydian',
    intervals: [0, 2, 4, 5, 7, 9, 10],
    description: 'Warm, upbeat rock & folk major mode.',
  },
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function freqToMidi(hz: number): number {
  if (hz <= 0) return 0;
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToNoteName(midi: number): string {
  const rounded = Math.round(midi);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
}

/**
 * Snap a continuous MIDI pitch value to the nearest semitone belonging to the selected musical key + scale.
 */
export function snapMidiToScale(
  midi: number,
  key: MusicalKey,
  scale: MusicalScale
): {
  targetMidi: number;
  centsOffset: number;
  shiftSemitones: number;
  detectedNote: string;
  targetNote: string;
} {
  const rootSemitone = MUSICAL_KEYS.indexOf(key);
  const intervals = MUSICAL_SCALES[scale]?.intervals ?? MUSICAL_SCALES.chromatic.intervals;

  const baseOctave = Math.floor(midi / 12);
  let bestMidi = Math.round(midi);
  let bestDist = Infinity;

  // Check candidate scale tones across adjacent octaves to guarantee global nearest semitone
  for (let oct = baseOctave - 1; oct <= baseOctave + 1; oct++) {
    for (const iv of intervals) {
      const candidate = oct * 12 + rootSemitone + iv;
      const dist = Math.abs(candidate - midi);
      if (dist < bestDist) {
        bestDist = dist;
        bestMidi = candidate;
      }
    }
  }

  const shiftSemitones = bestMidi - midi;
  const centsOffset = Math.round((midi - bestMidi) * 100);

  return {
    targetMidi: bestMidi,
    centsOffset,
    shiftSemitones,
    detectedNote: midiToNoteName(midi),
    targetNote: midiToNoteName(bestMidi),
  };
}

/**
 * In-place iterative Cooley-Tukey Radix-2 Fast Fourier Transform (FFT).
 * Length N must be a power of 2.
 */
export function fftRadix2(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  if (n <= 1) return;

  // Bit-reversal permutation
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
      const ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
  }

  // Butterfly stages
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wLenReal = Math.cos(angle);
    const wLenImag = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let wReal = 1.0;
      let wImag = 0.0;
      for (let k = 0; k < halfLen; k++) {
        const uReal = real[i + k];
        const uImag = imag[i + k];
        const vReal = real[i + k + halfLen] * wReal - imag[i + k + halfLen] * wImag;
        const vImag = real[i + k + halfLen] * wImag + imag[i + k + halfLen] * wReal;

        real[i + k] = uReal + vReal;
        imag[i + k] = uImag + vImag;
        real[i + k + halfLen] = uReal - vReal;
        imag[i + k + halfLen] = uImag - vImag;

        const nextWReal = wReal * wLenReal - wImag * wLenImag;
        wImag = wReal * wLenImag + wImag * wLenReal;
        wReal = nextWReal;
      }
    }
  }
}

/**
 * Compute monophonic vocal fundamental pitch (Hz) using Radix-2 FFT magnitude spectrum
 * combined with Harmonic Product Spectrum (HPS) and parabolic bin interpolation.
 */
export function detectPitchFFT(
  samples: Float32Array,
  sampleRate: number,
  options: { minHz?: number; maxHz?: number; rmsThreshold?: number } = {}
): { frequencyHz: number; confidence: number; voiced: boolean } {
  const minHz = options.minHz ?? 75;
  const maxHz = options.maxHz ?? 1100;
  const rmsThreshold = options.rmsThreshold ?? 0.012;

  // Check frame energy first
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSq += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSq / Math.max(1, samples.length));
  if (rms < rmsThreshold) {
    return { frequencyHz: 0, confidence: 0, voiced: false };
  }

  // Use power-of-2 FFT size (zero-padded 2x when <= 2048 for sharper frequency bin resolution)
  let fftSize = 1024;
  while (fftSize < samples.length) fftSize <<= 1;
  if (fftSize < 2048) fftSize = 2048;

  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);

  // Apply Hann window to suppress spectral leakage
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, n - 1)));
    real[i] = samples[i] * w;
  }

  fftRadix2(real, imag);

  const half = fftSize >> 1;
  const mag = new Float32Array(half);
  let maxMag = 0;
  for (let i = 0; i < half; i++) {
    const m = Math.hypot(real[i], imag[i]);
    mag[i] = m;
    if (m > maxMag) maxMag = m;
  }

  if (maxMag < 1e-6) {
    return { frequencyHz: 0, confidence: 0, voiced: false };
  }

  const binHz = sampleRate / fftSize;
  const minBin = Math.max(2, Math.floor(minHz / binHz));
  const maxBin = Math.min(Math.floor(half / 3) - 1, Math.ceil(maxHz / binHz));
  if (maxBin <= minBin) {
    return { frequencyHz: 0, confidence: 0, voiced: false };
  }

  // Combine fundamental magnitude + Harmonic Product Spectrum (2nd & 3rd harmonics)
  // so both pure sines and harmonic-rich vocal formants lock cleanly onto f0
  let bestBin = minBin;
  let bestScore = -1;
  let totalScore = 0;

  for (let k = minBin; k <= maxBin; k++) {
    const m1 = mag[k] / maxMag;
    const m2 = mag[Math.min(half - 1, k * 2)] / maxMag;
    const m3 = mag[Math.min(half - 1, k * 3)] / maxMag;
    // Blended score: strong fundamental + harmonic reinforcement avoids octave errors
    const score = m1 * (0.45 + 0.55 * Math.cbrt(m1 * (m2 + 0.08) * (m3 + 0.05)));
    totalScore += score;
    if (score > bestScore) {
      bestScore = score;
      bestBin = k;
    }
  }

  // Check if sub-octave (bestBin / 2) actually has strong fundamental energy (octave-error guard)
  const subBin = Math.round(bestBin / 2);
  if (subBin >= minBin && mag[subBin] > mag[bestBin] * 0.62) {
    bestBin = subBin;
  }

  // Parabolic interpolation around peak magnitude bin for sub-bin Hz accuracy
  const left = mag[Math.max(0, bestBin - 1)];
  const center = mag[bestBin];
  const right = mag[Math.min(half - 1, bestBin + 1)];
  const denom = left - 2 * center + right;
  const delta = Math.abs(denom) > 1e-8 ? Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denom)) : 0;

  const refinedFreq = (bestBin + delta) * binHz;
  const avgScore = totalScore / Math.max(1, maxBin - minBin + 1);
  const confidence = Math.min(1, bestScore / Math.max(1e-6, avgScore * 6));

  if (refinedFreq < minHz || refinedFreq > maxHz || confidence < 0.22) {
    return { frequencyHz: 0, confidence, voiced: false };
  }

  return { frequencyHz: refinedFreq, confidence, voiced: true };
}

/**
 * In-place Radix-2 Inverse FFT using conjugate symmetry around fftRadix2.
 */
export function ifftRadix2(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  for (let i = 0; i < n; i++) imag[i] = -imag[i];
  fftRadix2(real, imag);
  const invN = 1 / n;
  for (let i = 0; i < n; i++) {
    real[i] *= invN;
    imag[i] = -imag[i] * invN;
  }
}

/**
 * Offline / Export FFT-based Pitch Correction (Auto-Tune) processor on Float32 PCM channels.
 * Uses a true Radix-2 FFT Phase Vocoder:
 * 1. Analyzes monophonic vocal frames with Radix-2 FFT + Harmonic Product Spectrum to detect f0.
 * 2. Snaps detected MIDI pitch to the nearest semitone in the user-selected musical scale.
 * 3. Shifts frequency bins coherently via instantaneous-frequency phase vocoding + Radix-2 IFFT
 *    and Hann overlap-add, preserving exact track duration with crisp harmonic alignment.
 */
export function applyAutoTunePCM(
  channels: Float32Array[],
  sampleRate: number,
  options: {
    key: MusicalKey;
    scale: MusicalScale;
    strength?: number; // 0 to 100
  }
): Float32Array[] {
  if (channels.length === 0 || channels[0].length === 0 || sampleRate <= 0) {
    return channels.map((c) => new Float32Array(c));
  }

  const strengthNorm = Math.max(0, Math.min(1, (options.strength ?? 85) / 100));
  if (strengthNorm <= 0.01) {
    return channels.map((c) => new Float32Array(c));
  }

  const mono = mixToMono(channels);
  const totalLen = mono.length;

  const frameSize = sampleRate >= 40000 ? 2048 : 1024;
  const hopSize = frameSize >> 2; // 75% overlap
  const half = frameSize >> 1;
  const twoPi = 2 * Math.PI;
  const expectedPhaseStep = (twoPi * hopSize) / frameSize;

  const hann = new Float32Array(frameSize);
  for (let i = 0; i < frameSize; i++) {
    hann[i] = 0.5 * (1 - Math.cos((twoPi * i) / frameSize));
  }

  // First pass on mono: compute per-frame pitch ratio trajectory via Radix-2 FFT pitch detection
  const numFrames = Math.ceil(totalLen / hopSize);
  const frameRatios = new Float32Array(numFrames);
  const analysisFrame = new Float32Array(frameSize);
  let smoothedRatio = 1.0;
  const smoothingAlpha = 0.22 + strengthNorm * 0.74;

  for (let f = 0; f < numFrames; f++) {
    const pos = f * hopSize;
    for (let i = 0; i < frameSize; i++) {
      const idx = pos + i;
      analysisFrame[i] = idx < totalLen ? mono[idx] : 0;
    }

    const pitch = detectPitchFFT(analysisFrame, sampleRate);
    let targetRatio = 1.0;

    if (pitch.voiced && pitch.frequencyHz > 0) {
      const midi = freqToMidi(pitch.frequencyHz);
      const snapped = snapMidiToScale(midi, options.key, options.scale);
      const appliedShift = Math.max(-4, Math.min(4, snapped.shiftSemitones * strengthNorm));
      targetRatio = Math.pow(2, appliedShift / 12);
    }

    smoothedRatio += smoothingAlpha * (targetRatio - smoothedRatio);
    frameRatios[f] = smoothedRatio;
  }

  // Second pass per channel: phase-coherent FFT Phase Vocoder pitch shift
  const outputs: Float32Array[] = [];

  for (let c = 0; c < channels.length; c++) {
    const src = channels[c];
    const dst = new Float32Array(totalLen);
    const normWeights = new Float32Array(totalLen);

    const prevPhase = new Float32Array(half + 1);
    const sumPhase = new Float32Array(half + 1);
    const anaMag = new Float32Array(half + 1);
    const anaFreq = new Float32Array(half + 1);
    const synMag = new Float32Array(half + 1);
    const synFreq = new Float32Array(half + 1);

    const real = new Float32Array(frameSize);
    const imag = new Float32Array(frameSize);

    for (let f = 0; f < numFrames; f++) {
      const pos = f * hopSize;
      const ratio = frameRatios[f];

      // Window input frame
      for (let i = 0; i < frameSize; i++) {
        const idx = pos + i;
        real[i] = (idx < totalLen ? src[idx] : 0) * hann[i];
        imag[i] = 0;
      }

      fftRadix2(real, imag);

      // Analysis: magnitude + instantaneous frequency per bin
      for (let k = 0; k <= half; k++) {
        const r = real[k];
        const im = imag[k];
        anaMag[k] = Math.hypot(r, im);
        const phase = Math.atan2(im, r);

        let dPhase = phase - prevPhase[k] - k * expectedPhaseStep;
        prevPhase[k] = phase;
        // Wrap delta phase to [-pi, pi]
        dPhase -= twoPi * Math.round(dPhase / twoPi);
        anaFreq[k] = k + dPhase / expectedPhaseStep;
      }

      // Synthesis: pitch-scale spectral bins
      synMag.fill(0);
      synFreq.fill(0);

      for (let k = 0; k <= half; k++) {
        const targetBin = Math.round(k * ratio);
        if (targetBin >= 0 && targetBin <= half) {
          if (anaMag[k] > synMag[targetBin]) {
            synFreq[targetBin] = anaFreq[k] * ratio;
          }
          synMag[targetBin] += anaMag[k];
        }
      }

      // Accumulate synthesis phase and reconstruct Hermitian-symmetric spectrum
      real.fill(0);
      imag.fill(0);

      for (let k = 0; k <= half; k++) {
        sumPhase[k] += synFreq[k] * expectedPhaseStep;
        const mag = synMag[k];
        const re = mag * Math.cos(sumPhase[k]);
        const im = mag * Math.sin(sumPhase[k]);
        real[k] = re;
        imag[k] = im;
        if (k > 0 && k < half) {
          real[frameSize - k] = re;
          imag[frameSize - k] = -im;
        }
      }

      ifftRadix2(real, imag);

      // Overlap-add with synthesis Hann window
      for (let i = 0; i < frameSize; i++) {
        const outIdx = pos + i;
        if (outIdx >= totalLen) break;
        const w = hann[i];
        dst[outIdx] += real[i] * w;
        normWeights[outIdx] += w * w;
      }
    }

    for (let i = 0; i < totalLen; i++) {
      const w = normWeights[i];
      dst[i] = w > 1e-5 ? Math.max(-1, Math.min(1, dst[i] / w)) : src[i];
    }

    outputs.push(dst);
  }

  return outputs;
}

/**
 * Pure DAW track mix math helper: determines effective linear gain & pan for a track
 * taking Solo / Mute rules across all tracks into account.
 */
export function computeTrackPlaybackParams(
  tracks: Array<{ id: string; gain: number; pan: number; muted: boolean; solo: boolean }>
): Record<string, { effectiveGain: number; pan: number; audible: boolean }> {
  const anySolo = tracks.some((t) => t.solo);
  const result: Record<string, { effectiveGain: number; pan: number; audible: boolean }> = {};

  for (const t of tracks) {
    const audible = !t.muted && (!anySolo || t.solo);
    const clampedGain = Math.max(0, Math.min(1.5, t.gain));
    const clampedPan = Math.max(-1, Math.min(1, t.pan));
    result[t.id] = {
      effectiveGain: audible ? clampedGain : 0,
      pan: clampedPan,
      audible,
    };
  }

  return result;
}
