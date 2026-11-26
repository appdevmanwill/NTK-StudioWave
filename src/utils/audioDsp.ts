import type {
  DynamicsProcessorOptions,
  ExportFormat,
  RepetitionRegion,
  SilencePreset,
  SilenceRegion,
  TrackEqSettings,
  TranscriptSegment,
} from '../types/audio';

export const SILENCE_PRESETS: Record<
  SilencePreset,
  { thresholdDb: number; minSilenceSec: number; keepPaddingSec: number; label: string; description: string }
> = {
  gentle: {
    thresholdDb: -42,
    minSilenceSec: 0.9,
    keepPaddingSec: 0.55,
    label: 'Gentle',
    description: 'Only trims long pauses while keeping relaxed natural breathing room.',
  },
  normal: {
    thresholdDb: -36,
    minSilenceSec: 0.5,
    keepPaddingSec: 0.3,
    label: 'Normal',
    description: 'Shrinks pauses longer than 0.5s down to a natural 0.3s breath.',
  },
  tight: {
    thresholdDb: -30,
    minSilenceSec: 0.35,
    keepPaddingSec: 0.18,
    label: 'Tight',
    description: 'Fast, punchy pacing ideal for short-form clips and YouTube narration.',
  },
};

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function linearToDb(linear: number): number {
  if (linear <= 1e-8) return -100;
  return 20 * Math.log10(linear);
}

/**
 * Downmix multi-channel PCM arrays into a single mono Float32Array.
 */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const len = channels[0].length;
  const out = new Float32Array(len);
  const scale = 1 / channels.length;
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (let c = 0; c < channels.length; c++) {
      sum += channels[c][i];
    }
    out[i] = sum * scale;
  }
  return out;
}

/**
 * Scan mono PCM samples for silent pauses below thresholdDb lasting >= minSilenceSec.
 */
export function detectSilences(
  monoPcm: Float32Array,
  sampleRate: number,
  options: { thresholdDb?: number; minSilenceSec?: number; frameMs?: number } = {}
): { regions: SilenceRegion[]; totalSilenceSec: number } {
  const thresholdDb = options.thresholdDb ?? -36;
  const minSilenceSec = options.minSilenceSec ?? 0.55;
  const frameMs = options.frameMs ?? 20;

  if (monoPcm.length === 0 || sampleRate <= 0) {
    return { regions: [], totalSilenceSec: 0 };
  }

  const thresholdLin = dbToLinear(thresholdDb);
  const frameSize = Math.max(1, Math.floor((sampleRate * frameMs) / 1000));
  const totalFrames = Math.ceil(monoPcm.length / frameSize);

  const regions: SilenceRegion[] = [];
  let inSilence = false;
  let silenceStartFrame = 0;

  for (let f = 0; f < totalFrames; f++) {
    const startIdx = f * frameSize;
    const endIdx = Math.min(monoPcm.length, startIdx + frameSize);
    let sumSq = 0;
    for (let i = startIdx; i < endIdx; i++) {
      const s = monoPcm[i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, endIdx - startIdx));
    const isQuiet = rms < thresholdLin;

    if (isQuiet && !inSilence) {
      inSilence = true;
      silenceStartFrame = f;
    } else if (!isQuiet && inSilence) {
      inSilence = false;
      const startSec = (silenceStartFrame * frameSize) / sampleRate;
      const endSec = (f * frameSize) / sampleRate;
      const dur = endSec - startSec;
      if (dur >= minSilenceSec) {
        regions.push({
          id: `sil-${regions.length + 1}`,
          start: startSec,
          end: endSec,
          duration: dur,
        });
      }
    }
  }

  if (inSilence) {
    const startSec = (silenceStartFrame * frameSize) / sampleRate;
    const endSec = monoPcm.length / sampleRate;
    const dur = endSec - startSec;
    if (dur >= minSilenceSec) {
      regions.push({
        id: `sil-${regions.length + 1}`,
        start: startSec,
        end: endSec,
        duration: dur,
      });
    }
  }

  const totalSilenceSec = regions.reduce((acc, r) => acc + r.duration, 0);
  return { regions, totalSilenceSec };
}

/**
 * Calculate how many seconds will be saved by shrinking pauses down to keepPaddingSec.
 */
export function calculateTimeSaved(regions: SilenceRegion[], keepPaddingSec: number): number {
  return regions.reduce((acc, r) => acc + Math.max(0, r.duration - keepPaddingSec), 0);
}

/**
 * Remove or shrink silence regions across all channels, preserving natural breath padding
 * and applying smooth micro-crossfades (default 15ms) at splice seams so edits never pop.
 */
export function removeSilencesPCM(
  channels: Float32Array[],
  sampleRate: number,
  regions: SilenceRegion[],
  keepPaddingSec: number = 0.3,
  crossfadeMs: number = 15
): { channels: Float32Array[]; savedSec: number } {
  if (channels.length === 0 || channels[0].length === 0 || regions.length === 0) {
    return { channels: channels.map((c) => new Float32Array(c)), savedSec: 0 };
  }

  const totalSamples = channels[0].length;
  const keepSamples = Math.max(0, Math.round(keepPaddingSec * sampleRate));
  const fadeSamples = Math.max(1, Math.round((crossfadeMs / 1000) * sampleRate));

  // Build list of cut intervals [cutStart, cutEnd)
  // Compensate by +fadeSamples because overlap-add splicing shortens the seam by fadeSamples,
  // guaranteeing the resulting silent gap equals keepPaddingSec (e.g. exactly 0.30s).
  const cuts: Array<{ start: number; end: number }> = [];
  for (const r of regions) {
    const rStart = Math.max(0, Math.round(r.start * sampleRate));
    const rEnd = Math.min(totalSamples, Math.round(r.end * sampleRate));
    const rLen = rEnd - rStart;
    const retainedPreOverlap = keepSamples + fadeSamples;
    if (rLen > retainedPreOverlap + fadeSamples) {
      const halfKeep = Math.floor(retainedPreOverlap / 2);
      const cutStart = rStart + halfKeep;
      const cutEnd = rEnd - (retainedPreOverlap - halfKeep);
      if (cutEnd > cutStart) {
        cuts.push({ start: cutStart, end: cutEnd });
      }
    }
  }

  if (cuts.length === 0) {
    return { channels: channels.map((c) => new Float32Array(c)), savedSec: 0 };
  }

  // Convert cuts into kept segments
  const kept: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor) {
      kept.push({ start: cursor, end: cut.start });
    }
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < totalSamples) {
    kept.push({ start: cursor, end: totalSamples });
  }

  // Splice kept segments with equal-power/linear micro-crossfade at boundaries
  const resultChannels = channels.map((ch) => {
    const segments = kept.map((seg) => ch.subarray(seg.start, seg.end));
    return spliceSegmentsWithCrossfade(segments, fadeSamples);
  });

  const newLength = resultChannels[0].length;
  const savedSec = Math.max(0, (totalSamples - newLength) / sampleRate);
  return { channels: resultChannels, savedSec };
}

/**
 * Splice an array of PCM segments with smooth overlap-add crossfades so cuts never click.
 */
export function spliceSegmentsWithCrossfade(
  segments: Float32Array[],
  fadeSamples: number
): Float32Array {
  const nonEmpty = segments.filter((s) => s.length > 0);
  if (nonEmpty.length === 0) return new Float32Array(0);
  if (nonEmpty.length === 1) return new Float32Array(nonEmpty[0]);

  // Compute exact output length accounting for overlaps
  let outLen = nonEmpty[0].length;
  const overlaps: number[] = [];
  for (let i = 1; i < nonEmpty.length; i++) {
    const ov = Math.min(
      fadeSamples,
      Math.floor(nonEmpty[i - 1].length / 3),
      Math.floor(nonEmpty[i].length / 3)
    );
    overlaps.push(ov);
    outLen += nonEmpty[i].length - ov;
  }

  const out = new Float32Array(outLen);
  out.set(nonEmpty[0], 0);
  let writePos = nonEmpty[0].length;

  for (let i = 1; i < nonEmpty.length; i++) {
    const seg = nonEmpty[i];
    const ov = overlaps[i - 1];
    const overlapStart = writePos - ov;

    // 15ms linear crossfade overlap region to prevent audible clicks at cut points
    for (let k = 0; k < ov; k++) {
      const t = (k + 1) / (ov + 1);
      const fadeIn = t;
      const fadeOut = 1 - t;
      out[overlapStart + k] = out[overlapStart + k] * fadeOut + seg[k] * fadeIn;
    }

    // Copy remainder of segment
    if (ov < seg.length) {
      out.set(seg.subarray(ov), writePos);
    }
    writePos += seg.length - ov;
  }

  return out;
}

/**
 * Natural Pacing utility: scans PCM for gaps longer than minSilenceSec (default 0.5s)
 * and shrinks each gap down to exactly targetGapSec (default 0.3s) with a 15ms linear crossfade.
 */
export function applyNaturalPacingPCM(
  channels: Float32Array[],
  sampleRate: number,
  options: {
    thresholdDb?: number;
    minSilenceSec?: number;
    targetGapSec?: number;
    crossfadeMs?: number;
  } = {}
): { channels: Float32Array[]; regions: SilenceRegion[]; savedSec: number } {
  const thresholdDb = options.thresholdDb ?? -36;
  const minSilenceSec = options.minSilenceSec ?? 0.5;
  const targetGapSec = options.targetGapSec ?? 0.3;
  const crossfadeMs = options.crossfadeMs ?? 15;

  const mono = mixToMono(channels);
  const { regions } = detectSilences(mono, sampleRate, {
    thresholdDb,
    minSilenceSec,
  });
  const reduced = removeSilencesPCM(channels, sampleRate, regions, targetGapSec, crossfadeMs);
  return { channels: reduced.channels, regions, savedSec: reduced.savedSec };
}

/**
 * Convenience AudioBuffer wrapper for Natural Pacing (0.5s+ silence -> exact 0.3s with 15ms linear crossfade).
 */
export function applyNaturalPacingAudioBuffer(
  buffer: AudioBuffer,
  ctx: BaseAudioContext,
  options: {
    thresholdDb?: number;
    minSilenceSec?: number;
    targetGapSec?: number;
    crossfadeMs?: number;
  } = {}
): { buffer: AudioBuffer; regions: SilenceRegion[]; savedSec: number } {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(new Float32Array(buffer.getChannelData(c)));
  }
  const result = applyNaturalPacingPCM(channels, buffer.sampleRate, options);
  const outBuf = ctx.createBuffer(
    result.channels.length,
    Math.max(1, result.channels[0]?.length ?? 1),
    buffer.sampleRate
  );
  for (let c = 0; c < result.channels.length; c++) {
    outBuf.copyToChannel(new Float32Array(result.channels[c]), c);
  }
  return { buffer: outBuf, regions: result.regions, savedSec: result.savedSec };
}

/**
 * Remove an arbitrary time interval [startSec, endSec] from multi-channel PCM with crossfade.
 */
export function cutRangePCM(
  channels: Float32Array[],
  sampleRate: number,
  startSec: number,
  endSec: number,
  crossfadeMs: number = 15
): Float32Array[] {
  if (channels.length === 0) return [];
  const total = channels[0].length;
  const s = Math.max(0, Math.min(total, Math.floor(startSec * sampleRate)));
  const e = Math.max(s, Math.min(total, Math.floor(endSec * sampleRate)));
  const fadeSamples = Math.max(1, Math.floor((crossfadeMs / 1000) * sampleRate));

  return channels.map((ch) => {
    const left = ch.subarray(0, s);
    const right = ch.subarray(e);
    return spliceSegmentsWithCrossfade([left, right], fadeSamples);
  });
}

/**
 * Keep only [startSec, endSec] from multi-channel PCM with tiny edge fades.
 */
export function trimRangePCM(
  channels: Float32Array[],
  sampleRate: number,
  startSec: number,
  endSec: number
): Float32Array[] {
  if (channels.length === 0) return [];
  const total = channels[0].length;
  const s = Math.max(0, Math.min(total, Math.floor(startSec * sampleRate)));
  const e = Math.max(s, Math.min(total, Math.floor(endSec * sampleRate)));
  const edgeFade = Math.min(Math.floor(sampleRate * 0.008), Math.floor((e - s) / 4));

  return channels.map((ch) => {
    const out = new Float32Array(ch.subarray(s, e));
    for (let i = 0; i < edgeFade; i++) {
      const g = i / Math.max(1, edgeFade);
      out[i] *= g;
      out[out.length - 1 - i] *= g;
    }
    return out;
  });
}

/**
 * Magnetic Snap-to-Silence & Zero-Crossing helper.
 * Searches +/- searchWindowSec around targetSec to find the quietest zero-crossing
 * so cuts never chop the start of a word or introduce clicks.
 */
export function snapToZeroCrossing(
  monoPcm: Float32Array,
  sampleRate: number,
  targetSec: number,
  searchWindowSec: number = 0.06
): number {
  if (monoPcm.length < 2 || sampleRate <= 0) return targetSec;

  const targetIdx = Math.max(0, Math.min(monoPcm.length - 1, Math.round(targetSec * sampleRate)));
  const halfWin = Math.floor(searchWindowSec * sampleRate);
  const startIdx = Math.max(1, targetIdx - halfWin);
  const endIdx = Math.min(monoPcm.length - 1, targetIdx + halfWin);

  // First find the quietest 10ms window in range
  const energyWin = Math.max(8, Math.floor(sampleRate * 0.01));
  let bestCenter = targetIdx;
  let minEnergy = Infinity;

  for (let i = startIdx; i <= endIdx; i += Math.max(1, Math.floor(energyWin / 2))) {
    const wStart = Math.max(0, i - Math.floor(energyWin / 2));
    const wEnd = Math.min(monoPcm.length, i + Math.floor(energyWin / 2));
    let sum = 0;
    for (let k = wStart; k < wEnd; k++) {
      sum += monoPcm[k] * monoPcm[k];
    }
    const avg = sum / Math.max(1, wEnd - wStart);
    // Slight distance bias so we prefer staying close to user cursor when equally quiet
    const distBias = 1 + (Math.abs(i - targetIdx) / Math.max(1, halfWin)) * 0.15;
    if (avg * distBias < minEnergy) {
      minEnergy = avg * distBias;
      bestCenter = i;
    }
  }

  // Refine to nearest exact zero-crossing around bestCenter
  const zcWin = Math.min(256, Math.floor(sampleRate * 0.008));
  const zStart = Math.max(1, bestCenter - zcWin);
  const zEnd = Math.min(monoPcm.length - 1, bestCenter + zcWin);
  let bestZc = bestCenter;
  let bestScore = Infinity;

  for (let i = zStart; i <= zEnd; i++) {
    const prev = monoPcm[i - 1];
    const curr = monoPcm[i];
    const crosses = (prev <= 0 && curr >= 0) || (prev >= 0 && curr <= 0);
    const amp = Math.abs(curr);
    const score = (crosses ? 0 : 1) + amp * 10 + (Math.abs(i - bestCenter) / Math.max(1, zcWin)) * 0.05;
    if (score < bestScore) {
      bestScore = score;
      bestZc = i;
    }
  }

  return bestZc / sampleRate;
}

/**
 * Compute a time-normalized acoustic fingerprint (energy envelope + zero-crossing rate +
 * high-frequency spectral tilt across N bins) for phrase repetition detection.
 */
function computePhraseFingerprint(pcm: Float32Array, bins: number = 24): Float32Array {
  const fp = new Float32Array(bins * 3);
  if (pcm.length < bins) return fp;

  const binLen = pcm.length / bins;
  let maxRms = 1e-6;
  const rmsVals = new Float32Array(bins);
  const zcrVals = new Float32Array(bins);
  const diffVals = new Float32Array(bins);

  for (let b = 0; b < bins; b++) {
    const s = Math.floor(b * binLen);
    const e = Math.min(pcm.length, Math.floor((b + 1) * binLen));
    const len = Math.max(1, e - s);
    let sumSq = 0;
    let zcr = 0;
    let diffSq = 0;
    for (let i = s; i < e; i++) {
      const v = pcm[i];
      sumSq += v * v;
      if (i > s) {
        const prev = pcm[i - 1];
        if ((prev >= 0 && v < 0) || (prev < 0 && v >= 0)) zcr++;
        const d = v - prev;
        diffSq += d * d;
      }
    }
    const rms = Math.sqrt(sumSq / len);
    rmsVals[b] = rms;
    zcrVals[b] = zcr / len;
    diffVals[b] = Math.sqrt(diffSq / len) / Math.max(1e-5, rms);
    if (rms > maxRms) maxRms = rms;
  }

  for (let b = 0; b < bins; b++) {
    fp[b] = rmsVals[b] / maxRms;
    fp[bins + b] = Math.min(1, zcrVals[b] * 5);
    fp[bins * 2 + b] = Math.min(1, diffVals[b] * 0.6);
  }

  return fp;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom <= 1e-8 ? 0 : dot / denom;
}

/**
 * Split speech into phrases via Voice Activity Detection and compare adjacent/nearby
 * phrases using multi-band acoustic fingerprints to flag likely repeated takes.
 */
export function detectRepetitions(
  monoPcm: Float32Array,
  sampleRate: number,
  options: { thresholdDb?: number; minPhraseSec?: number; similarityThreshold?: number } = {}
): RepetitionRegion[] {
  const thresholdDb = options.thresholdDb ?? -34;
  const minPhraseSec = options.minPhraseSec ?? 0.45;
  const similarityThreshold = options.similarityThreshold ?? 0.90;

  if (monoPcm.length === 0 || sampleRate <= 0) return [];

  const frameMs = 25;
  const frameSize = Math.max(1, Math.floor((sampleRate * frameMs) / 1000));
  const totalFrames = Math.ceil(monoPcm.length / frameSize);
  const thresholdLin = dbToLinear(thresholdDb);
  const bridgeGapFrames = Math.ceil(0.22 / (frameMs / 1000)); // bridge short intra-word gaps

  const active = new Uint8Array(totalFrames);
  for (let f = 0; f < totalFrames; f++) {
    const s = f * frameSize;
    const e = Math.min(monoPcm.length, s + frameSize);
    let sumSq = 0;
    for (let i = s; i < e; i++) sumSq += monoPcm[i] * monoPcm[i];
    active[f] = Math.sqrt(sumSq / Math.max(1, e - s)) >= thresholdLin ? 1 : 0;
  }

  // Fill tiny silent gaps inside a phrase
  let lastActive = -1;
  for (let f = 0; f < totalFrames; f++) {
    if (active[f] === 1) {
      if (lastActive >= 0 && f - lastActive <= bridgeGapFrames) {
        for (let k = lastActive + 1; k < f; k++) active[k] = 1;
      }
      lastActive = f;
    }
  }

  // Extract phrases
  const phrases: Array<{ startSec: number; endSec: number; fp: Float32Array }> = [];
  let inPhrase = false;
  let pStart = 0;
  for (let f = 0; f <= totalFrames; f++) {
    const isAct = f < totalFrames && active[f] === 1;
    if (isAct && !inPhrase) {
      inPhrase = true;
      pStart = f;
    } else if (!isAct && inPhrase) {
      inPhrase = false;
      const startSample = pStart * frameSize;
      const endSample = Math.min(monoPcm.length, f * frameSize);
      const dur = (endSample - startSample) / sampleRate;
      if (dur >= minPhraseSec) {
        phrases.push({
          startSec: startSample / sampleRate,
          endSec: endSample / sampleRate,
          fp: computePhraseFingerprint(monoPcm.subarray(startSample, endSample), 24),
        });
      }
    }
  }

  // Compare each phrase with the next 1..2 phrases (typical retake pattern: user repeats a line)
  const repetitions: RepetitionRegion[] = [];
  const flaggedStarts = new Set<number>();

  for (let i = 0; i < phrases.length - 1; i++) {
    const p1 = phrases[i];
    const dur1 = p1.endSec - p1.startSec;

    for (let j = i + 1; j <= Math.min(phrases.length - 1, i + 2); j++) {
      const p2 = phrases[j];
      const dur2 = p2.endSec - p2.startSec;
      const durRatio = Math.min(dur1, dur2) / Math.max(dur1, dur2);
      if (durRatio < 0.65) continue;

      const sim = cosineSimilarity(p1.fp, p2.fp);
      if (sim >= similarityThreshold && !flaggedStarts.has(i)) {
        flaggedStarts.add(i);
        // Flag the EARLIER take as the retake to remove (keeping the cleaner second take!)
        repetitions.push({
          id: `rep-${repetitions.length + 1}`,
          start: p1.startSec,
          end: p1.endSec,
          matchedWithStart: p2.startSec,
          matchedWithEnd: p2.endSec,
          similarity: Number(sim.toFixed(3)),
          source: 'detected',
          label: `Repeated take (${Math.round(sim * 100)}% match)`,
        });
        break;
      }
    }
  }

  return repetitions;
}

/**
 * Compute downsampled min/max waveform peaks for high-DPI canvas rendering.
 */
export function computeWaveformPeaks(
  monoPcm: Float32Array,
  bucketCount: number
): { mins: Float32Array; maxs: Float32Array } {
  const count = Math.max(1, Math.floor(bucketCount));
  const mins = new Float32Array(count);
  const maxs = new Float32Array(count);
  if (monoPcm.length === 0) return { mins, maxs };

  const samplesPerBucket = monoPcm.length / count;
  for (let b = 0; b < count; b++) {
    const start = Math.floor(b * samplesPerBucket);
    const end = Math.min(monoPcm.length, Math.max(start + 1, Math.floor((b + 1) * samplesPerBucket)));
    let min = 1;
    let max = -1;
    for (let i = start; i < end; i++) {
      const s = monoPcm[i];
      if (s < min) min = s;
      if (s > max) max = s;
    }
    mins[b] = min > max ? 0 : min;
    maxs[b] = max < min ? 0 : max;
  }

  return { mins, maxs };
}

/**
 * Estimate exported file size in bytes given duration and format settings.
 */
export function estimateFileSizeBytes(params: {
  durationSec: number;
  format: ExportFormat;
  bitrateKbps: number;
  sampleRate: number;
  channels: 1 | 2;
}): number {
  const { durationSec, format, bitrateKbps, sampleRate, channels } = params;
  const dur = Math.max(0, durationSec);
  if (format === 'wav') {
    return Math.round(44 + dur * sampleRate * channels * 2);
  }
  if (format === 'flac') {
    // Uncompressed verbatim FLAC frames + framing overhead (~1.01x PCM 16-bit)
    return Math.round(128 + dur * sampleRate * channels * 2 * 1.01);
  }
  // Lossy formats (mp3, ogg, m4a): kbps -> bytes/sec
  return Math.round((dur * bitrateKbps * 1000) / 8 + 4096);
}

/**
 * Calculate the exact bitrate (or WAV sample rate) needed to fit audio under targetSizeMb.
 */
export function calculateBitrateForTargetSize(params: {
  durationSec: number;
  targetSizeMb: number;
  format: ExportFormat;
  channels: 1 | 2;
}): { recommendedBitrateKbps: number; recommendedSampleRate: number; fitsEasily: boolean } {
  const dur = Math.max(0.5, params.durationSec);
  // Leave 4% headroom for container headers/metadata
  const targetBytes = Math.max(16 * 1024, params.targetSizeMb * 1024 * 1024 * 0.96);

  if (params.format === 'wav' || params.format === 'flac') {
    const maxSampleRate = Math.floor(targetBytes / (dur * params.channels * 2));
    const standardRates = [48000, 44100, 32000, 22050, 16000, 11025, 8000];
    const chosen = standardRates.find((r) => r <= maxSampleRate) ?? 8000;
    return {
      recommendedBitrateKbps: Math.round((chosen * params.channels * 16) / 1000),
      recommendedSampleRate: chosen,
      fitsEasily: maxSampleRate >= 44100,
    };
  }

  const rawKbps = Math.floor((targetBytes * 8) / (dur * 1000));
  const clamped = Math.max(32, Math.min(320, rawKbps));
  const standardBitrates = [320, 256, 192, 160, 128, 96, 64, 48, 32];
  const chosen = standardBitrates.find((b) => b <= clamped) ?? 32;

  return {
    recommendedBitrateKbps: chosen,
    recommendedSampleRate: chosen <= 64 ? 22050 : 44100,
    fitsEasily: rawKbps >= 128,
  };
}

/**
 * Encode multi-channel Float32Array PCM to a standard 16-bit PCM RIFF/WAVE Uint8Array.
 */
export function encodeWavPCM(channels: Float32Array[], sampleRate: number): Uint8Array {
  const numChannels = Math.max(1, channels.length);
  const numSamples = channels[0]?.length ?? 0;
  const bitsPerSample = 16;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // AudioFormat = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]));
      const int16 = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }

  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * CRC-8 (polynomial 0x07) for FLAC frame headers.
 */
function flacCrc8(data: Uint8Array, start: number, len: number): number {
  let crc = 0;
  for (let i = start; i < start + len; i++) {
    crc ^= data[i];
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/**
 * CRC-16 (polynomial 0x8005) for FLAC frame footers.
 */
function flacCrc16(data: Uint8Array, start: number, len: number): number {
  let crc = 0;
  for (let i = start; i < start + len; i++) {
    crc ^= data[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function encodeUtf8Number(n: number): number[] {
  if (n < 0x80) return [n];
  if (n < 0x800) return [0xc0 | (n >> 6), 0x80 | (n & 0x3f)];
  if (n < 0x10000) return [0xe0 | (n >> 12), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)];
  return [
    0xf0 | (n >> 18),
    0x80 | ((n >> 12) & 0x3f),
    0x80 | ((n >> 6) & 0x3f),
    0x80 | (n & 0x3f),
  ];
}

/**
 * Pure TypeScript standards-compliant lossless FLAC encoder (RFC 9639 verbatim subframes).
 * Zero WASM or SharedArrayBuffer dependencies — always succeeds cleanly in any browser sandbox.
 */
export function encodeFlacPCM(channels: Float32Array[], sampleRate: number): Uint8Array {
  const numChannels = Math.max(1, Math.min(2, channels.length));
  const totalSamples = channels[0]?.length ?? 0;
  const blockSize = 4096;
  const bitsPerSample = 16;

  // Map standard sample rate code (or 0b1101 for custom 16-bit rate in frame header)
  const srCodeMap: Record<number, number> = {
    8000: 0b0100,
    16000: 0b0101,
    22050: 0b0110,
    24000: 0b0111,
    32000: 0b1000,
    44100: 0b1001,
    48000: 0b1010,
    96000: 0b1011,
  };
  const srCode = srCodeMap[sampleRate] ?? 0b1101;

  const chunks: Uint8Array[] = [];

  // 1. Magic "fLaC"
  chunks.push(new Uint8Array([0x66, 0x4c, 0x61, 0x43]));

  // 2. STREAMINFO metadata block (isLast = 1, type = 0, length = 34)
  const streamInfo = new Uint8Array(4 + 34);
  streamInfo[0] = 0x80; // last metadata block + STREAMINFO (0)
  streamInfo[1] = 0;
  streamInfo[2] = 0;
  streamInfo[3] = 34;

  const minBlock = Math.min(blockSize, Math.max(16, totalSamples));
  const maxBlock = blockSize;
  streamInfo[4] = (minBlock >> 8) & 0xff;
  streamInfo[5] = minBlock & 0xff;
  streamInfo[6] = (maxBlock >> 8) & 0xff;
  streamInfo[7] = maxBlock & 0xff;
  // min/max frame size = 0 (unknown)
  // 20-bit sampleRate | 3-bit (channels-1) | 5-bit (bps-1) | 36-bit totalSamples
  const sr = sampleRate & 0xfffff;
  const chBits = (numChannels - 1) & 0x7;
  const bpsBits = (bitsPerSample - 1) & 0x1f;
  streamInfo[14] = (sr >> 12) & 0xff;
  streamInfo[15] = (sr >> 4) & 0xff;
  streamInfo[16] = ((sr & 0xf) << 4) | (chBits << 1) | ((bpsBits >> 4) & 0x1);
  streamInfo[17] = ((bpsBits & 0xf) << 4) | (Math.floor(totalSamples / 0x100000000) & 0xf);
  streamInfo[18] = (totalSamples >>> 24) & 0xff;
  streamInfo[19] = (totalSamples >>> 16) & 0xff;
  streamInfo[20] = (totalSamples >>> 8) & 0xff;
  streamInfo[21] = totalSamples & 0xff;
  // MD5 signature left as 0 (allowed per FLAC spec when unset)
  chunks.push(streamInfo);

  // 3. Audio Frames (VERBATIM subframes = 100% lossless)
  let frameIndex = 0;
  for (let pos = 0; pos < totalSamples; pos += blockSize) {
    const n = Math.min(blockSize, totalSamples - pos);
    const useCustomBlock = n !== 4096;
    const bsCode = useCustomBlock ? 0b0111 : 0b1100; // 0111 = 16-bit (n-1) at end of header; 1100 = 4096

    const headerBytes: number[] = [];
    headerBytes.push(0xff, 0xf8); // sync code + fixed blocksize strategy
    headerBytes.push((bsCode << 4) | srCode);
    const chAssignment = numChannels === 1 ? 0b0000 : 0b0001; // 0=mono, 1=left/right
    const sampleSizeCode = 0b100; // 16-bit
    headerBytes.push((chAssignment << 4) | (sampleSizeCode << 1));
    headerBytes.push(...encodeUtf8Number(frameIndex));

    if (useCustomBlock) {
      const bm1 = n - 1;
      headerBytes.push((bm1 >> 8) & 0xff, bm1 & 0xff);
    }
    if (srCode === 0b1101) {
      headerBytes.push((sampleRate >> 8) & 0xff, sampleRate & 0xff);
    }

    const headerArr = new Uint8Array(headerBytes.length + 1);
    headerArr.set(headerBytes, 0);
    headerArr[headerBytes.length] = flacCrc8(headerArr, 0, headerBytes.length);

    // Frame payload: for each channel, 1-byte subframe header (0x02 = VERBATIM, 0 wasted bits) + n * 2 big-endian bytes
    const payloadLen = numChannels * (1 + n * 2);
    const frame = new Uint8Array(headerArr.length + payloadLen + 2);
    frame.set(headerArr, 0);
    let offset = headerArr.length;

    for (let c = 0; c < numChannels; c++) {
      frame[offset++] = 0x02; // 0 (pad) | 000001 (SUBFRAME_VERBATIM) | 0 (no wasted bits)
      const ch = channels[c];
      for (let i = 0; i < n; i++) {
        const s = Math.max(-1, Math.min(1, ch[pos + i]));
        const int16 = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
        frame[offset++] = (int16 >> 8) & 0xff;
        frame[offset++] = int16 & 0xff;
      }
    }

    const crc16 = flacCrc16(frame, 0, offset);
    frame[offset++] = (crc16 >> 8) & 0xff;
    frame[offset++] = crc16 & 0xff;

    chunks.push(frame);
    frameIndex++;
  }

  const totalBytes = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(totalBytes);
  let write = 0;
  for (const c of chunks) {
    out.set(c, write);
    write += c.length;
  }
  return out;
}

export function formatDuration(seconds: number, showTenths: boolean = false): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const tenths = Math.floor((safe % 1) * 10);
  const base = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return showTenths ? `${base}.${tenths}` : base;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatSrtTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.floor((safe % 1) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function formatSrtCaptions(segments: TranscriptSegment[]): string {
  return segments
    .map(
      (seg, idx) =>
        `${idx + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${seg.text.trim()}\n`
    )
    .join('\n');
}

export function formatPlainTranscript(segments: TranscriptSegment[]): string {
  return segments
    .map((seg) => `[${formatDuration(seg.start)}] ${seg.text.trim()}`)
    .join('\n');
}

export const FILLER_WORDS = ['um', 'uh', 'umm', 'uhh', 'like', 'you know', 'basically', 'actually'];

export function countFillerWords(text: string): number {
  const regex = /\b(um+|uh+|like|you know|basically|actually)\b/gi;
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

/**
 * Simple deterministic SHA-like local hash for the 4-digit Private folder PIN (zero external deps).
 */
export function hashPin(pin: string): string {
  let h1 = 0xdeadbeef ^ pin.length;
  let h2 = 0x41c6ce57 ^ pin.length;
  for (let i = 0; i < pin.length; i++) {
    const ch = pin.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export interface NoiseGateConfig {
  thresholdDb: number;
  hysteresisDb?: number;
  holdMs?: number;
  floorGain?: number;
}

/**
 * Pure, deterministic noise-gate envelope state machine used by both
 * real-time Web Audio playback gating and unit tests.
 */
export class NoiseGateStateMachine {
  private thresholdDb: number;
  private hysteresisDb: number;
  private holdMs: number;
  private floorGain: number;
  private isOpen = false;
  private lastAboveMs = -Infinity;

  constructor(config: NoiseGateConfig) {
    this.thresholdDb = config.thresholdDb;
    this.hysteresisDb = config.hysteresisDb ?? 2.5;
    this.holdMs = config.holdMs ?? 80;
    this.floorGain = config.floorGain ?? 0.025;
  }

  updateConfig(config: Partial<NoiseGateConfig>): void {
    if (config.thresholdDb !== undefined) this.thresholdDb = config.thresholdDb;
    if (config.hysteresisDb !== undefined) this.hysteresisDb = config.hysteresisDb;
    if (config.holdMs !== undefined) this.holdMs = config.holdMs;
    if (config.floorGain !== undefined) this.floorGain = config.floorGain;
  }

  reset(): void {
    this.isOpen = false;
    this.lastAboveMs = -Infinity;
  }

  evaluate(inputDb: number, nowMs: number, enabled: boolean): {
    isOpen: boolean;
    targetGain: number;
    inputDb: number;
  } {
    if (!enabled) {
      this.isOpen = true;
      return { isOpen: true, targetGain: 1.0, inputDb };
    }

    const openThreshold = this.thresholdDb;
    const closeThreshold = this.thresholdDb - this.hysteresisDb;

    if (inputDb >= openThreshold) {
      this.isOpen = true;
      this.lastAboveMs = nowMs;
    } else if (this.isOpen) {
      if (inputDb >= closeThreshold) {
        this.lastAboveMs = nowMs;
      } else if (nowMs - this.lastAboveMs >= this.holdMs) {
        this.isOpen = false;
      }
    }

    return {
      isOpen: this.isOpen,
      targetGain: this.isOpen ? 1.0 : this.floorGain,
      inputDb,
    };
  }
}

/**
 * Smooth RMS noise gate pass on PCM channel arrays for offline effect rendering and export.
 * Attenuates background noise below thresholdDb down to floorGain with smooth attack/hold/release.
 */
export function applyNoiseGatePCM(
  channels: Float32Array[],
  sampleRate: number,
  options: {
    thresholdDb?: number;
    floorGain?: number;
    attackSec?: number;
    holdMs?: number;
    releaseSec?: number;
  } = {}
): Float32Array[] {
  if (channels.length === 0 || channels[0].length === 0 || sampleRate <= 0) {
    return channels.map((c) => new Float32Array(c));
  }

  const thresholdDb = options.thresholdDb ?? -35;
  const floorGain = Math.max(0, Math.min(1, options.floorGain ?? 0.025));
  const attackSec = Math.max(0.001, options.attackSec ?? 0.008);
  const holdMs = Math.max(0, options.holdMs ?? 70);
  const releaseSec = Math.max(0.01, options.releaseSec ?? 0.085);

  const mono = mixToMono(channels);
  const len = mono.length;
  const win = Math.max(16, Math.floor(sampleRate * 0.015)); // 15ms RMS detection frame
  const env = new Float32Array(len);

  const sm = new NoiseGateStateMachine({
    thresholdDb,
    hysteresisDb: 2.5,
    holdMs,
    floorGain,
  });

  const attackCoeff = 1 - Math.exp(-1 / (sampleRate * attackSec));
  const releaseCoeff = 1 - Math.exp(-1 / (sampleRate * releaseSec));
  let smoothGain = 1.0;

  for (let i = 0; i < len; i += win) {
    const end = Math.min(len, i + win);
    let sumSq = 0;
    for (let k = i; k < end; k++) {
      sumSq += mono[k] * mono[k];
    }
    const rms = Math.sqrt(sumSq / Math.max(1, end - i));
    const db = linearToDb(rms);
    const nowMs = (i / sampleRate) * 1000;
    const { targetGain } = sm.evaluate(db, nowMs, true);

    for (let k = i; k < end; k++) {
      const coeff = targetGain > smoothGain ? attackCoeff : releaseCoeff;
      smoothGain += coeff * (targetGain - smoothGain);
      env[k] = smoothGain;
    }
  }

  return channels.map((ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      out[i] = ch[i] * env[i];
    }
    return out;
  });
}

export const DEFAULT_TRACK_EQ: TrackEqSettings = {
  enabled: true,
  lowGainDb: 0,
  lowFreqHz: 180,
  midGainDb: 0,
  midFreqHz: 1400,
  midQ: 1.1,
  highGainDb: 0,
  highFreqHz: 6500,
};

export function clampTrackEq(eq?: Partial<TrackEqSettings>): TrackEqSettings {
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  return {
    enabled: eq?.enabled ?? DEFAULT_TRACK_EQ.enabled,
    lowGainDb: clamp(eq?.lowGainDb ?? DEFAULT_TRACK_EQ.lowGainDb, -12, 12),
    lowFreqHz: clamp(eq?.lowFreqHz ?? DEFAULT_TRACK_EQ.lowFreqHz, 60, 400),
    midGainDb: clamp(eq?.midGainDb ?? DEFAULT_TRACK_EQ.midGainDb, -12, 12),
    midFreqHz: clamp(eq?.midFreqHz ?? DEFAULT_TRACK_EQ.midFreqHz, 400, 4500),
    midQ: clamp(eq?.midQ ?? DEFAULT_TRACK_EQ.midQ, 0.5, 4.0),
    highGainDb: clamp(eq?.highGainDb ?? DEFAULT_TRACK_EQ.highGainDb, -12, 12),
    highFreqHz: clamp(eq?.highFreqHz ?? DEFAULT_TRACK_EQ.highFreqHz, 3000, 14000),
  };
}

export function isTrackEqActive(eq?: TrackEqSettings): boolean {
  if (!eq || !eq.enabled) return false;
  return (
    Math.abs(eq.lowGainDb) >= 0.1 ||
    Math.abs(eq.midGainDb) >= 0.1 ||
    Math.abs(eq.highGainDb) >= 0.1
  );
}

/**
 * Pure Float32 PCM Dynamics Processor:
 * Stage 1: Soft-knee feed-forward RMS/peak compressor + makeup gain to even out vocal dynamics.
 * Stage 2: Fast lookahead-style brickwall limiter at limiterCeilingDb to strictly prevent clipping.
 */
export function applyDynamicsProcessorPCM(
  channels: Float32Array[],
  sampleRate: number,
  options: Partial<DynamicsProcessorOptions> = {}
): { channels: Float32Array[]; maxReductionDb: number; peakAfterDb: number } {
  if (channels.length === 0 || channels[0].length === 0 || sampleRate <= 0) {
    return {
      channels: channels.map((c) => new Float32Array(c)),
      maxReductionDb: 0,
      peakAfterDb: -100,
    };
  }

  const thresholdDb = options.thresholdDb ?? -18;
  const kneeDb = Math.max(0, options.kneeDb ?? 10);
  const ratio = Math.max(1, options.ratio ?? 4.0);
  const attackSec = Math.max(0.001, options.attackSec ?? 0.006);
  const releaseSec = Math.max(0.02, options.releaseSec ?? 0.14);
  const makeupGainLin = dbToLinear(options.makeupGainDb ?? 3.0);
  const ceilingDb = Math.min(-0.05, Math.max(-6, options.limiterCeilingDb ?? -0.3));
  const ceilingLin = dbToLinear(ceilingDb);

  const numCh = channels.length;
  const len = channels[0].length;
  const outChannels = channels.map(() => new Float32Array(len));

  const attackCoeff = 1 - Math.exp(-1 / (sampleRate * attackSec));
  const releaseCoeff = 1 - Math.exp(-1 / (sampleRate * releaseSec));
  const limReleaseCoeff = 1 - Math.exp(-1 / (sampleRate * 0.045));

  let compEnvDb = -96;
  let limGain = 1.0;
  let maxReductionDb = 0;
  let maxOutPeak = 0;

  for (let i = 0; i < len; i++) {
    // Stereo-linked peak detector across channels
    let peak = 0;
    for (let c = 0; c < numCh; c++) {
      const a = Math.abs(channels[c][i]);
      if (a > peak) peak = a;
    }
    const inDb = linearToDb(peak);

    // Smooth attack / release detector in dB domain
    const coeff = inDb > compEnvDb ? attackCoeff : releaseCoeff;
    compEnvDb += coeff * (inDb - compEnvDb);

    // Soft-knee gain computer
    let gainReductionDb = 0;
    const overDb = compEnvDb - thresholdDb;
    if (kneeDb > 0 && overDb > -kneeDb / 2 && overDb < kneeDb / 2) {
      const x = overDb + kneeDb / 2;
      gainReductionDb = ((1 / ratio - 1) * x * x) / (2 * kneeDb);
    } else if (overDb >= kneeDb / 2) {
      gainReductionDb = (1 / ratio - 1) * overDb;
    }

    if (gainReductionDb < maxReductionDb) {
      maxReductionDb = gainReductionDb;
    }

    const compGainLin = dbToLinear(gainReductionDb) * makeupGainLin;

    // Stage 2: Fast Brickwall Limiter (instant attack, smooth 45ms release, hard safety clamp)
    const postCompPeak = peak * compGainLin;
    const desiredLimGain = postCompPeak > ceilingLin ? ceilingLin / postCompPeak : 1.0;
    if (desiredLimGain < limGain) {
      limGain = desiredLimGain; // instant brickwall catch
    } else {
      limGain += limReleaseCoeff * (desiredLimGain - limGain);
    }

    const totalGain = compGainLin * limGain;
    for (let c = 0; c < numCh; c++) {
      let s = channels[c][i] * totalGain;
      // Strict hard ceiling safety clamp guaranteeing zero clipping
      if (s > ceilingLin) s = ceilingLin;
      else if (s < -ceilingLin) s = -ceilingLin;
      outChannels[c][i] = s;
      const absS = Math.abs(s);
      if (absS > maxOutPeak) maxOutPeak = absS;
    }
  }

  return {
    channels: outChannels,
    maxReductionDb,
    peakAfterDb: linearToDb(maxOutPeak),
  };
}


