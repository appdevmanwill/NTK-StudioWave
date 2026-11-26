import { encodeWavPCM } from '../../utils/audioDsp';
import { saveBlobToDevice } from '../../utils/platformFileSave';
import {
  DEFAULT_SOUND_BALANCE,
  rebalanceSoundElementsPCM,
} from '../../utils/ruleBasedEditorDsp';
import type {
  NtkEqPresetId,
  NtkLiveConsoleSettings,
  NtkMomentFlag,
  NtkRecordingItem,
  NtkTranscriptSegment,
} from '../types';

export interface EqBandSpec {
  freqHz: number;
  shortLabel: string;
  roleLabel: string;
  filterType: BiquadFilterType;
  q: number;
}

export const NTK_7BAND_EQ_SPECS: EqBandSpec[] = [
  { freqHz: 60, shortLabel: '60 Hz', roleLabel: 'Sub-Bass / Low-Cut', filterType: 'lowshelf', q: 0.7 },
  { freqHz: 150, shortLabel: '150 Hz', roleLabel: 'Bass / Warmth', filterType: 'peaking', q: 1.1 },
  { freqHz: 400, shortLabel: '400 Hz', roleLabel: 'Low-Mid', filterType: 'peaking', q: 1.2 },
  { freqHz: 1000, shortLabel: '1 kHz', roleLabel: 'Voice Mid', filterType: 'peaking', q: 1.1 },
  { freqHz: 2500, shortLabel: '2.5 kHz', roleLabel: 'Presence / Clarity', filterType: 'peaking', q: 1.2 },
  { freqHz: 6000, shortLabel: '6 kHz', roleLabel: 'Treble / De-Esser', filterType: 'peaking', q: 1.4 },
  { freqHz: 12000, shortLabel: '12 kHz', roleLabel: 'Air / High-Cut', filterType: 'highshelf', q: 0.7 },
];

export const NTK_STUDIO_PRESETS: Record<
  NtkEqPresetId,
  {
    id: NtkEqPresetId;
    name: string;
    description: string;
    eqBandsDb: [number, number, number, number, number, number, number];
    noiseGateEnabled: boolean;
    noiseGateThresholdDb: number;
    compressorEnabled: boolean;
    compressorThresholdDb: number;
    limiterEnabled: boolean;
  }
> = {
  'clear-office': {
    id: 'clear-office',
    name: 'Clear Office Voice',
    description: 'Cuts AC hum & desk thumps while making speech crisp and easy to understand.',
    eqBandsDb: [-7, -2, -1.5, 1.5, 3.5, -1, 1],
    noiseGateEnabled: true,
    noiseGateThresholdDb: -46,
    compressorEnabled: true,
    compressorThresholdDb: -22,
    limiterEnabled: true,
  },
  'cut-rumble': {
    id: 'cut-rumble',
    name: 'Cut Room Rumble',
    description: 'Removes low-frequency traffic, fan hum, and table vibrations.',
    eqBandsDb: [-12, -6, -2, 0.5, 1.5, 0, 0],
    noiseGateEnabled: true,
    noiseGateThresholdDb: -44,
    compressorEnabled: true,
    compressorThresholdDb: -24,
    limiterEnabled: true,
  },
  'soften-music': {
    id: 'soften-music',
    name: 'Soften Music / Instruments',
    description: 'Tames loud bass and bright cymbals so spoken voices stand out clearly.',
    eqBandsDb: [-9, -5, -2.5, 2.5, 4, -3.5, -5],
    noiseGateEnabled: false,
    noiseGateThresholdDb: -52,
    compressorEnabled: true,
    compressorThresholdDb: -20,
    limiterEnabled: true,
  },
  'broadcast-radio': {
    id: 'broadcast-radio',
    name: 'Broadcast Radio',
    description: 'Warm, punchy podcast vocal tone with tight evening and smooth highs.',
    eqBandsDb: [-5, 3, -2, 1, 3.5, -1.5, 2.5],
    noiseGateEnabled: true,
    noiseGateThresholdDb: -48,
    compressorEnabled: true,
    compressorThresholdDb: -26,
    limiterEnabled: true,
  },
  'flat-raw': {
    id: 'flat-raw',
    name: 'Flat / Raw',
    description: 'Neutral untouched microphone response with zero EQ coloring.',
    eqBandsDb: [0, 0, 0, 0, 0, 0, 0],
    noiseGateEnabled: false,
    noiseGateThresholdDb: -50,
    compressorEnabled: false,
    compressorThresholdDb: -20,
    limiterEnabled: true,
  },
};

export const DEFAULT_NTK_LIVE_CONSOLE: NtkLiveConsoleSettings = {
  presetId: 'clear-office',
  eqBandsDb: [...NTK_STUDIO_PRESETS['clear-office'].eqBandsDb] as [
    number,
    number,
    number,
    number,
    number,
    number,
    number
  ],
  noiseGateEnabled: true,
  noiseGateThresholdDb: -46,
  compressorEnabled: true,
  compressorThresholdDb: -22,
  limiterEnabled: true,
  inputGainDb: 0,
  liveMonitorEnabled: false,
  bakeEqLive: false, // Keep Raw Master + non-destructive playback/export by default for safety
};

export function applyPresetToConsole(
  current: NtkLiveConsoleSettings,
  presetId: NtkEqPresetId
): NtkLiveConsoleSettings {
  const p = NTK_STUDIO_PRESETS[presetId];
  return {
    ...current,
    presetId,
    eqBandsDb: [...p.eqBandsDb] as [number, number, number, number, number, number, number],
    noiseGateEnabled: p.noiseGateEnabled,
    noiseGateThresholdDb: p.noiseGateThresholdDb,
    compressorEnabled: p.compressorEnabled,
    compressorThresholdDb: p.compressorThresholdDb,
    limiterEnabled: p.limiterEnabled,
  };
}

export function formatClock(sec: number, showTenths = false): string {
  const safe = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const tenths = Math.floor((safe % 1) * 10);
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  const base = hrs > 0 ? `${hrs}:${mm}:${ss}` : `${mm}:${ss}`;
  return showTenths ? `${base}.${tenths}` : base;
}

export interface PlannedAudioChunk {
  chunkIndex: number;
  startSample: number;
  endSample: number;
  offsetSeconds: number;
  durationSeconds: number;
  estimatedBytes: number;
}

/**
 * Automatic Audio Chunker Planner:
 * Free STT APIs typically enforce a 25 MB upload limit (and JSON base64 expands size ~33%).
 * When downsampled to 16 kHz mono 16-bit PCM (32 KB/sec), a 12 MB WAV chunk holds ~375s (~6.2 min),
 * staying strictly below 15 MB binary / 20 MB base64.
 */
export function planAudioChunksForApi(
  totalSamples: number,
  sampleRate: number,
  maxChunkBytes = 12 * 1024 * 1024
): PlannedAudioChunk[] {
  const safeRate = Math.max(8000, sampleRate);
  const safeSamples = Math.max(1, Math.floor(totalSamples));
  const bytesPerSample = 2; // 16-bit mono PCM
  const headerBytes = 44;
  const maxSamplesPerChunk = Math.max(
    safeRate * 10,
    Math.floor((maxChunkBytes - headerBytes) / bytesPerSample)
  );

  const chunks: PlannedAudioChunk[] = [];
  let cursor = 0;
  let idx = 0;
  while (cursor < safeSamples) {
    const end = Math.min(safeSamples, cursor + maxSamplesPerChunk);
    const len = end - cursor;
    chunks.push({
      chunkIndex: idx++,
      startSample: cursor,
      endSample: end,
      offsetSeconds: Number((cursor / safeRate).toFixed(2)),
      durationSeconds: Number((len / safeRate).toFixed(2)),
      estimatedBytes: len * bytesPerSample + headerBytes,
    });
    cursor = end;
  }
  return chunks;
}

export function downsampleMonoPcm(
  channels: Float32Array[],
  inputSampleRate: number,
  targetSampleRate = 16000
): Float32Array {
  const srcLen = channels[0]?.length ?? 0;
  if (srcLen === 0) return new Float32Array(0);
  const chCount = channels.length;
  const mono = new Float32Array(srcLen);
  for (let i = 0; i < srcLen; i++) {
    let sum = 0;
    for (let c = 0; c < chCount; c++) sum += channels[c][i];
    mono[i] = sum / chCount;
  }

  if (inputSampleRate <= targetSampleRate) return mono;
  const ratio = inputSampleRate / targetSampleRate;
  const outLen = Math.max(1, Math.floor(srcLen / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(srcLen, Math.floor((i + 1) * ratio));
    let acc = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      acc += mono[j];
      count++;
    }
    out[i] = count > 0 ? acc / count : mono[start] ?? 0;
  }
  return out;
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * Slices any AudioBuffer into compact 16 kHz mono WAV base64 chunks under 12 MB each
 * so recordings of any size (including > 15 MB / 1+ hour) upload reliably to free STT APIs.
 */
export function buildApiAudioChunksFromBuffer(
  buffer: AudioBuffer,
  maxChunkBytes = 12 * 1024 * 1024
): Array<{
  chunkIndex: number;
  offsetSeconds: number;
  durationSeconds: number;
  audioBase64: string;
  mimeType: string;
}> {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }
  const targetRate = 16000;
  const mono16k = downsampleMonoPcm(channels, buffer.sampleRate, targetRate);
  const plan = planAudioChunksForApi(mono16k.length, targetRate, maxChunkBytes);

  return plan.map((slot) => {
    const slice = mono16k.subarray(slot.startSample, slot.endSample);
    const wavBytes = encodeWavPCM([slice], targetRate);
    return {
      chunkIndex: slot.chunkIndex,
      offsetSeconds: slot.offsetSeconds,
      durationSeconds: slot.durationSeconds,
      audioBase64: uint8ToBase64(wavBytes),
      mimeType: 'audio/wav',
    };
  });
}

/**
 * Trim + Silence Cutter pure PCM helper (non-destructive: returns new channels without mutating input)
 */
export function trimAndCutSilencesPCM(
  channels: Float32Array[],
  sampleRate: number,
  options: {
    trimStartSec?: number;
    trimEndSec?: number;
    cutSilences?: boolean;
    silenceThresholdDb?: number;
    minSilenceSec?: number;
    keepPaddingSec?: number;
  }
): { channels: Float32Array[]; durationSec: number; removedSilenceSec: number } {
  const totalLen = channels[0]?.length ?? 0;
  if (totalLen === 0) return { channels: [new Float32Array(0)], durationSec: 0, removedSilenceSec: 0 };

  const startIdx = Math.max(0, Math.min(totalLen - 1, Math.floor((options.trimStartSec ?? 0) * sampleRate)));
  const endIdx = Math.max(
    startIdx + 1,
    Math.min(totalLen, Math.floor((options.trimEndSec ?? totalLen / sampleRate) * sampleRate))
  );

  const trimmed = channels.map((ch) => ch.slice(startIdx, endIdx));
  if (!options.cutSilences) {
    return {
      channels: trimmed,
      durationSec: (endIdx - startIdx) / sampleRate,
      removedSilenceSec: 0,
    };
  }

  const len = trimmed[0].length;
  const threshLin = Math.pow(10, (options.silenceThresholdDb ?? -38) / 20);
  const winSize = Math.max(1, Math.floor(sampleRate * 0.05)); // 50ms windows
  const minSilentWindows = Math.max(2, Math.floor((options.minSilenceSec ?? 0.65) / 0.05));
  const keepPadWindows = Math.max(1, Math.floor((options.keepPaddingSec ?? 0.15) / 0.05));

  const windowCount = Math.ceil(len / winSize);
  const isSilent = new Uint8Array(windowCount);
  for (let w = 0; w < windowCount; w++) {
    const s = w * winSize;
    const e = Math.min(len, s + winSize);
    let sumSq = 0;
    for (let i = s; i < e; i++) {
      const v = trimmed[0][i];
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, e - s));
    isSilent[w] = rms < threshLin ? 1 : 0;
  }

  // Mark long silent runs for removal while leaving keepPadWindows on each edge
  const keepWin = new Uint8Array(windowCount);
  keepWin.fill(1);
  let runStart = -1;
  for (let w = 0; w <= windowCount; w++) {
    const silent = w < windowCount && isSilent[w] === 1;
    if (silent && runStart < 0) runStart = w;
    if (!silent && runStart >= 0) {
      const runLen = w - runStart;
      if (runLen >= minSilentWindows) {
        const cutFrom = runStart + keepPadWindows;
        const cutTo = w - keepPadWindows;
        for (let k = cutFrom; k < cutTo; k++) keepWin[k] = 0;
      }
      runStart = -1;
    }
  }

  let keptSamples = 0;
  for (let w = 0; w < windowCount; w++) {
    if (keepWin[w]) keptSamples += Math.min(winSize, len - w * winSize);
  }

  if (keptSamples < sampleRate * 0.2) {
    // Safety guard: never erase entire clip
    return { channels: trimmed, durationSec: len / sampleRate, removedSilenceSec: 0 };
  }

  const outChannels = trimmed.map(() => new Float32Array(keptSamples));
  let writePos = 0;
  for (let w = 0; w < windowCount; w++) {
    if (!keepWin[w]) continue;
    const s = w * winSize;
    const e = Math.min(len, s + winSize);
    const chunkLen = e - s;
    for (let c = 0; c < trimmed.length; c++) {
      outChannels[c].set(trimmed[c].subarray(s, e), writePos);
    }
    writePos += chunkLen;
  }

  return {
    channels: outChannels,
    durationSec: keptSamples / sampleRate,
    removedSilenceSec: Math.max(0, (len - keptSamples) / sampleRate),
  };
}

/**
 * Mixes a second Voice-Over layer onto a primary recording cleanly with soft peak limiting.
 */
export function mixTwoTracksPCM(
  primary: Float32Array[],
  overlay: Float32Array[],
  sampleRate: number,
  offsetSec: number,
  overlayGain = 0.9
): Float32Array[] {
  const offsetSamples = Math.max(0, Math.floor(offsetSec * sampleRate));
  const pLen = primary[0]?.length ?? 0;
  const oLen = overlay[0]?.length ?? 0;
  const outLen = Math.max(pLen, offsetSamples + oLen);
  const chCount = Math.max(primary.length, overlay.length, 1);

  const out: Float32Array[] = [];
  for (let c = 0; c < chCount; c++) {
    const buf = new Float32Array(outLen);
    const pCh = primary[Math.min(c, primary.length - 1)];
    const oCh = overlay[Math.min(c, overlay.length - 1)];
    if (pCh) buf.set(pCh, 0);
    if (oCh) {
      for (let i = 0; i < oCh.length; i++) {
        const idx = offsetSamples + i;
        if (idx < outLen) {
          const mixed = buf[idx] + oCh[i] * overlayGain;
          buf[idx] = Math.max(-0.98, Math.min(0.98, mixed));
        }
      }
    }
    out.push(buf);
  }
  return out;
}

export function extractWaveformPeaks(buffer: AudioBuffer, bars = 120): number[] {
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / bars));
  const peaks: number[] = [];
  for (let i = 0; i < bars; i++) {
    const start = i * step;
    const end = Math.min(data.length, start + step);
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks.push(Math.min(1, max));
  }
  return peaks;
}

function pad2(n: number): string {
  return String(Math.floor(n)).padStart(2, '0');
}

function pad3(n: number): string {
  return String(Math.floor(n)).padStart(3, '0');
}

function formatSubtitleTime(sec: number, sep: ',' | '.'): string {
  const safe = Math.max(0, sec);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.floor((safe % 1) * 1000);
  return `${pad2(hrs)}:${pad2(mins)}:${pad2(secs)}${sep}${pad3(ms)}`;
}

export function formatTranscriptTXT(segments: NtkTranscriptSegment[]): string {
  return segments
    .map((s) => {
      const speaker = s.speaker ? `${s.speaker}: ` : '';
      return `[${formatClock(s.start)}] ${speaker}${s.text}`;
    })
    .join('\n');
}

export function formatTranscriptSRT(segments: NtkTranscriptSegment[]): string {
  return segments
    .map((s, idx) => {
      const speaker = s.speaker ? `${s.speaker}: ` : '';
      return `${idx + 1}\n${formatSubtitleTime(s.start, ',')} --> ${formatSubtitleTime(
        s.end,
        ','
      )}\n${speaker}${s.text}\n`;
    })
    .join('\n');
}

export function formatTranscriptVTT(segments: NtkTranscriptSegment[]): string {
  const body = segments
    .map((s) => {
      const speaker = s.speaker ? `<v ${s.speaker}>` : '';
      return `${formatSubtitleTime(s.start, '.')} --> ${formatSubtitleTime(s.end, '.')}\n${speaker}${s.text}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

export function formatRecordingMarkdown(rec: NtkRecordingItem): string {
  const lines: string[] = [
    `# ${rec.title}`,
    '',
    `- **Recorded:** ${new Date(rec.createdAt).toLocaleString()}`,
    rec.speakerName ? `- **By:** ${rec.speakerName}` : '',
    `- **Duration:** ${formatClock(rec.durationSec)}`,
    '',
  ].filter(Boolean);

  if (rec.flags.length > 0) {
    lines.push('## Moment Flags', '');
    rec.flags.forEach((f: NtkMomentFlag) => {
      lines.push(`- **${formatClock(f.timeSec)}** — ${f.note || 'Flagged moment'}`);
    });
    lines.push('');
  }

  if (rec.aiNotes.length > 0) {
    lines.push('## AI Notes', '');
    rec.aiNotes.forEach((note) => {
      lines.push(`### ${note.label}`, '', note.text, '');
    });
  }

  if (rec.transcript.length > 0 || rec.transcriptText) {
    lines.push('## Transcript', '');
    if (rec.transcript.length > 0) {
      rec.transcript.forEach((s) => {
        const spk = s.speaker ? `**${s.speaker}:** ` : '';
        lines.push(`- \`${formatClock(s.start)}\` ${spk}${s.text}`);
      });
    } else {
      lines.push(rec.transcriptText);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function searchRecordingsByKeyword(
  recordings: NtkRecordingItem[],
  query: string
): NtkRecordingItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return recordings;
  return recordings.filter((rec) => {
    if (rec.title.toLowerCase().includes(q)) return true;
    if (rec.speakerName.toLowerCase().includes(q)) return true;
    if (rec.transcriptText.toLowerCase().includes(q)) return true;
    if (rec.transcript.some((s) => s.text.toLowerCase().includes(q))) return true;
    if (rec.flags.some((f) => f.note.toLowerCase().includes(q))) return true;
    if (rec.aiNotes.some((n) => n.text.toLowerCase().includes(q) || n.label.toLowerCase().includes(q))) {
      return true;
    }
    return false;
  });
}

export function triggerFileDownload(blob: Blob, filename: string): void {
  void saveBlobToDevice(blob, filename);
}

/**
 * Downsamples multi-channel audio cleanly when very long clips (>45s) are processed
 * for 4-track previewing, keeping RAM lightweight on 1 GB RAM office PCs.
 */
export function downsampleChannelsForPreview(
  channels: Float32Array[],
  srcRate: number,
  maxRate = 22050
): { channels: Float32Array[]; sampleRate: number } {
  if (channels.length === 0 || channels[0].length === 0 || srcRate <= maxRate) {
    return { channels, sampleRate: srcRate };
  }
  const ratio = srcRate / maxRate;
  const srcLen = channels[0].length;
  const outLen = Math.max(1, Math.floor(srcLen / ratio));
  const outChannels = channels.map((ch) => {
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = Math.min(srcLen - 1, Math.floor(i * ratio));
      out[i] = ch[idx];
    }
    return out;
  });
  return { channels: outChannels, sampleRate: maxRate };
}

/**
 * 100% offline rule-based 4-track stem separation using mathematical mid/side +
 * transient/harmonic envelope + spectral crossover DSP (zero internet or API keys needed).
 */
export function splitFourStemsRuleBasedPCM(
  channels: Float32Array[],
  sampleRate: number
): {
  vocals: Float32Array[];
  drums: Float32Array[];
  bass: Float32Array[];
  other: Float32Array[];
} {
  const vocals = rebalanceSoundElementsPCM(channels, sampleRate, {
    ...DEFAULT_SOUND_BALANCE,
    leadVoice: 1.0,
    backupVoice: 1.0,
    drums: 0,
    keyboard: 0,
    bass: 0,
    muted: {
      leadVoice: false,
      backupVoice: false,
      drums: true,
      keyboard: true,
      bass: true,
    },
    solo: null,
  });

  const drums = rebalanceSoundElementsPCM(channels, sampleRate, {
    ...DEFAULT_SOUND_BALANCE,
    solo: 'drums',
  });

  const bass = rebalanceSoundElementsPCM(channels, sampleRate, {
    ...DEFAULT_SOUND_BALANCE,
    solo: 'bass',
  });

  const other = rebalanceSoundElementsPCM(channels, sampleRate, {
    ...DEFAULT_SOUND_BALANCE,
    solo: 'keyboard',
  });

  return { vocals, drums, bass, other };
}
