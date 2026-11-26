import type { BookmarkMarker, EffectSettings, TranscriptSegment } from '../types/audio';
import { encodeWavPCM } from './audioDsp';

export interface StudioProjectFileV1 {
  format: 'studiowave-project';
  version: 1;
  savedAt: string;
  title: string;
  sampleRate: number;
  channels: number;
  durationSec: number;
  bookmarks: BookmarkMarker[];
  transcript: TranscriptSegment[];
  effects?: Partial<EffectSettings>;
  audioWavBase64: string;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Serialize the active personal studio session into a portable `.swproj` file
 * that can be saved directly to disk and reopened anytime (including in desktop PC builds).
 */
export function buildStudioProjectBlob(params: {
  title: string;
  channels: Float32Array[];
  sampleRate: number;
  bookmarks: BookmarkMarker[];
  transcript: TranscriptSegment[];
  effects?: EffectSettings;
}): Blob {
  const wavBytes = encodeWavPCM(params.channels, params.sampleRate);
  const durationSec = (params.channels[0]?.length ?? 0) / Math.max(1, params.sampleRate);
  const payload: StudioProjectFileV1 = {
    format: 'studiowave-project',
    version: 1,
    savedAt: new Date().toISOString(),
    title: params.title || 'NTK StudioWave Project',
    sampleRate: params.sampleRate,
    channels: params.channels.length,
    durationSec,
    bookmarks: params.bookmarks,
    transcript: params.transcript,
    effects: params.effects,
    audioWavBase64: uint8ToBase64(wavBytes),
  };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

export async function parseStudioProjectFile(
  fileText: string
): Promise<{
  title: string;
  wavBuffer: ArrayBuffer;
  bookmarks: BookmarkMarker[];
  transcript: TranscriptSegment[];
}> {
  const parsed = JSON.parse(fileText) as Partial<StudioProjectFileV1>;
  if (parsed.format !== 'studiowave-project' || typeof parsed.audioWavBase64 !== 'string') {
    throw new Error('This file is not a valid NTK StudioWave (.swproj) project file.');
  }
  return {
    title: parsed.title || 'Restored Project',
    wavBuffer: base64ToArrayBuffer(parsed.audioWavBase64),
    bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
    transcript: Array.isArray(parsed.transcript) ? parsed.transcript : [],
  };
}
