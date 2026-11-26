import type { TranscriptSegment } from '../types/audio';
import { encodeWavPCM } from '../utils/audioDsp';

export interface CloudAiStatus {
  configured: boolean;
  models: {
    transcribe: string;
    analyze: string;
  };
  capabilities: string[];
}

export type AiAnalysisMode = 'summary' | 'action_items' | 'clean_script' | 'chapters';

export interface AiAnalysisResult {
  mode: AiAnalysisMode;
  headline: string;
  items: string[];
  cleanedText: string;
  model: string;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * Downsamples an AudioBuffer to lightweight mono 16kHz 16-bit WAV so Cloud AI API
 * uploads stay small and fast even on 1GB RAM PCs and mobile cellular connections.
 */
export function encodeAudioBufferForAiApi(
  buffer: AudioBuffer,
  maxDurationSec = 180
): { audioBase64: string; mimeType: string; sentDurationSec: number } {
  const targetRate = 16000;
  const srcRate = buffer.sampleRate;
  const usableSrcFrames = Math.min(buffer.length, Math.floor(srcRate * maxDurationSec));
  const outLength = Math.max(1, Math.floor((usableSrcFrames / srcRate) * targetRate));
  const mono = new Float32Array(outLength);

  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const ratio = srcRate / targetRate;

  for (let i = 0; i < outLength; i++) {
    const idx = Math.min(usableSrcFrames - 1, Math.floor(i * ratio));
    mono[i] = ch1 ? (ch0[idx] + ch1[idx]) * 0.5 : ch0[idx];
  }

  const wavBytes = encodeWavPCM([mono], targetRate);
  const wavCopy = new Uint8Array(wavBytes.byteLength);
  wavCopy.set(wavBytes);
  return {
    audioBase64: arrayBufferToBase64(wavCopy.buffer),
    mimeType: 'audio/wav',
    sentDurationSec: usableSrcFrames / srcRate,
  };
}

export async function fetchCloudAiStatus(): Promise<CloudAiStatus> {
  const res = await fetch('/api/ai/status');
  if (!res.ok) {
    throw new Error('Could not check Cloud AI API status.');
  }
  return (await res.json()) as CloudAiStatus;
}

export async function transcribeAudioWithCloudAi(
  buffer: AudioBuffer,
  language = 'auto'
): Promise<{ text: string; segments: TranscriptSegment[]; model: string }> {
  const { audioBase64, mimeType, sentDurationSec } = encodeAudioBufferForAiApi(buffer);
  const res = await fetch('/api/ai/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audioBase64,
      mimeType,
      language,
      durationSeconds: sentDurationSec,
    }),
  });
  const data = (await res.json()) as {
    text?: string;
    segments?: TranscriptSegment[];
    model?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || 'Cloud AI transcription failed.');
  }
  return {
    text: data.text ?? '',
    segments: Array.isArray(data.segments) ? data.segments : [],
    model: data.model ?? 'gemini-2.5-flash',
  };
}

export async function analyzeTranscriptWithCloudAi(
  transcript: string,
  mode: AiAnalysisMode,
  durationSeconds: number
): Promise<AiAnalysisResult> {
  const res = await fetch('/api/ai/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, mode, durationSeconds }),
  });
  const data = (await res.json()) as Partial<AiAnalysisResult> & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || 'Cloud AI analysis failed.');
  }
  return {
    mode,
    headline: data.headline || 'AI Notes',
    items: Array.isArray(data.items) ? data.items : [],
    cleanedText: data.cleanedText || '',
    model: data.model || 'gemini-2.5-flash',
  };
}

export function isBrowserLocalSpeechSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}
