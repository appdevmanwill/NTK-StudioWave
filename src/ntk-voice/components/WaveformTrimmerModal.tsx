import {
  Download,
  Loader2,
  Mic,
  RotateCcw,
  Scissors,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { encodeWavPCM } from '../../utils/audioDsp';
import type { NtkLiveConsoleSettings, NtkRecordingItem } from '../types';
import {
  decodeBlobToAudioBuffer,
  encodeAudioBufferToMp3Blob,
  encodeAudioBufferToWavBlob,
  renderBufferWithConsoleEq,
} from '../services/ntkAudioEngine';
import {
  extractWaveformPeaks,
  formatClock,
  mixTwoTracksPCM,
  triggerFileDownload,
  trimAndCutSilencesPCM,
} from '../utils/ntkAudioUtils';

interface WaveformTrimmerModalProps {
  recording: NtkRecordingItem;
  consoleSettings: NtkLiveConsoleSettings;
  multiFormatExport: boolean;
  onUpdateRecording: (updated: NtkRecordingItem) => Promise<void>;
  onClose: () => void;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
}

export function WaveformTrimmerModal({
  recording,
  consoleSettings,
  multiFormatExport,
  onUpdateRecording,
  onClose,
  onNotify,
}: WaveformTrimmerModalProps) {
  const [peaks, setPeaks] = useState<number[]>([]);
  const [duration, setDuration] = useState(recording.durationSec || 1);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(recording.durationSec || 1);
  const [cutSilences, setCutSilences] = useState(false);
  const [applyEqOnRender, setApplyEqOnRender] = useState(!consoleSettings.bakeEqLive);
  const [voiceOverOffset, setVoiceOverOffset] = useState(recording.voiceOverOffsetSec ?? 0);
  const [voiceOverGain, setVoiceOverGain] = useState(recording.voiceOverGain ?? 0.9);
  const [voiceOverBlob, setVoiceOverBlob] = useState<Blob | null>(recording.voiceOverBlob ?? null);
  const [recordingVo, setRecordingVo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [voRecorderRef, setVoRecorderRef] = useState<MediaRecorder | null>(null);

  useEffect(() => {
    let active = true;
    decodeBlobToAudioBuffer(recording.audioBlob)
      .then((buf) => {
        if (!active) return;
        setPeaks(extractWaveformPeaks(buf, 110));
        setDuration(buf.duration);
        setStartSec(0);
        setEndSec(Number(buf.duration.toFixed(2)));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [recording.audioBlob]);

  const handleApplyTrimAndMix = async () => {
    setBusy(true);
    try {
      const decoded = await decodeBlobToAudioBuffer(recording.audioBlob);
      const processedBuf = applyEqOnRender
        ? await renderBufferWithConsoleEq(decoded, consoleSettings)
        : decoded;

      const chs: Float32Array[] = [];
      for (let c = 0; c < processedBuf.numberOfChannels; c++) {
        chs.push(processedBuf.getChannelData(c));
      }

      const trimmed = trimAndCutSilencesPCM(chs, processedBuf.sampleRate, {
        trimStartSec: startSec,
        trimEndSec: endSec,
        cutSilences,
      });

      let finalChannels = trimmed.channels;
      if (voiceOverBlob) {
        const voBuf = await decodeBlobToAudioBuffer(voiceOverBlob);
        const voChs: Float32Array[] = [];
        for (let c = 0; c < voBuf.numberOfChannels; c++) voChs.push(voBuf.getChannelData(c));
        finalChannels = mixTwoTracksPCM(
          finalChannels,
          voChs,
          processedBuf.sampleRate,
          voiceOverOffset,
          voiceOverGain
        );
      }

      const wavBytes = encodeWavPCM(finalChannels, processedBuf.sampleRate);
      const copy = new Uint8Array(wavBytes.length);
      copy.set(wavBytes);
      const nextBlob = new Blob([copy.buffer], { type: 'audio/wav' });
      const newDuration = Number(((finalChannels[0]?.length ?? 0) / processedBuf.sampleRate).toFixed(2));

      await onUpdateRecording({
        ...recording,
        rawMasterBlob: recording.rawMasterBlob ?? recording.audioBlob,
        audioBlob: nextBlob,
        mimeType: 'audio/wav',
        durationSec: newDuration,
        voiceOverBlob: voiceOverBlob ?? undefined,
        voiceOverOffsetSec: voiceOverOffset,
        voiceOverGain,
        updatedAt: Date.now(),
      });

      onNotify(
        trimmed.removedSilenceSec > 0.2
          ? `Saved edit! Removed ${trimmed.removedSilenceSec.toFixed(1)}s of silence (original safely preserved).`
          : 'Saved non-destructive edit! You can Restore Original anytime.',
        'success'
      );
      onClose();
    } catch {
      onNotify('Could not apply waveform edit to this audio file.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreOriginal = async () => {
    if (!recording.rawMasterBlob) return;
    setBusy(true);
    try {
      const origBuf = await decodeBlobToAudioBuffer(recording.rawMasterBlob);
      await onUpdateRecording({
        ...recording,
        audioBlob: recording.rawMasterBlob,
        durationSec: Number(origBuf.duration.toFixed(2)),
        voiceOverBlob: undefined,
        updatedAt: Date.now(),
      });
      onNotify('Restored original untouched master recording.', 'info');
      onClose();
    } catch {
      onNotify('Could not restore original audio.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleRecordVoiceOver = async () => {
    if (recordingVo && voRecorderRef) {
      voRecorderRef.stop();
      setRecordingVo(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setVoiceOverBlob(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }));
        setVoRecorderRef(null);
        onNotify('Voice-over track recorded! Click Apply & Save Edit to mix both tracks.', 'success');
      };
      mr.start();
      setVoRecorderRef(mr);
      setRecordingVo(true);
    } catch {
      onNotify('Microphone access is needed to record a second voice-over track.', 'error');
    }
  };

  const handleExportFormat = async (fmt: 'wav' | 'mp3' | 'webm') => {
    setBusy(true);
    try {
      const safe = (recording.title || 'ntk-recording').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 42);
      if (fmt === 'webm') {
        triggerFileDownload(recording.audioBlob, `${safe}.webm`);
        onNotify('Downloaded WebM file.', 'success');
        return;
      }
      const decoded = await decodeBlobToAudioBuffer(recording.audioBlob);
      const rendered = applyEqOnRender
        ? await renderBufferWithConsoleEq(decoded, consoleSettings)
        : decoded;
      if (fmt === 'mp3') {
        triggerFileDownload(encodeAudioBufferToMp3Blob(rendered, 160), `${safe}.mp3`);
      } else {
        triggerFileDownload(encodeAudioBufferToWavBlob(rendered), `${safe}.wav`);
      }
      onNotify(`Exported ${fmt.toUpperCase()} audio file.`, 'success');
    } catch {
      onNotify(`Could not export ${fmt.toUpperCase()} file.`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const startPct = duration > 0 ? (startSec / duration) * 100 : 0;
  const endPct = duration > 0 ? (endSec / duration) * 100 : 100;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ntk-trimmer-title"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/60 backdrop-blur-xs p-0 sm:p-4"
    >
      <div className="w-full sm:max-w-2xl max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 sm:p-6 shadow-2xl space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3
              id="ntk-trimmer-title"
              className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2"
            >
              <Scissors className="h-4.5 w-4.5 text-blue-600" />
              <span>Waveform Trimmer, Silence Cutter &amp; Voice-Over Layer</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Non-destructive editing — your raw master is always kept safe for 1-click Undo / Restore.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close trimmer"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Visual Waveform with Selected Trim Window */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 p-4 space-y-3">
          <div className="relative h-24 flex items-center gap-[2px] overflow-hidden rounded-lg">
            {peaks.length === 0 ? (
              <div className="w-full text-center text-xs text-slate-400">Loading waveform...</div>
            ) : (
              peaks.map((p, idx) => {
                const posPct = (idx / peaks.length) * 100;
                const inside = posPct >= startPct && posPct <= endPct;
                return (
                  <div
                    key={idx}
                    className={`flex-1 rounded-full transition-colors ${
                      inside ? 'bg-blue-400' : 'bg-slate-700/60'
                    }`}
                    style={{ height: `${Math.max(8, Math.round(p * 95))}%` }}
                  />
                );
              })
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-slate-200">
            <label className="space-y-1">
              <div className="flex justify-between">
                <span>Trim Start</span>
                <span className="font-mono">{formatClock(startSec, true)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(0.2, endSec - 0.2)}
                step={0.1}
                value={startSec}
                onChange={(e) => setStartSec(Number(e.target.value))}
                className="w-full accent-blue-500"
              />
            </label>
            <label className="space-y-1">
              <div className="flex justify-between">
                <span>Trim End</span>
                <span className="font-mono">{formatClock(endSec, true)}</span>
              </div>
              <input
                type="range"
                min={Math.min(duration, startSec + 0.2)}
                max={duration}
                step={0.1}
                value={endSec}
                onChange={(e) => setEndSec(Number(e.target.value))}
                className="w-full accent-blue-500"
              />
            </label>
          </div>
        </div>

        {/* Silence Cutter + Non-Destructive EQ Toggle */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex items-start gap-2.5 rounded-xl border border-slate-200 dark:border-slate-800 p-3 cursor-pointer">
            <input
              type="checkbox"
              checked={cutSilences}
              onChange={(e) => setCutSilences(e.target.checked)}
              className="mt-0.5 rounded accent-blue-600"
            />
            <div>
              <div className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-1">
                <Sparkles className="h-3.5 w-3.5 text-blue-600" />
                <span>Auto-Cut Long Silences</span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Tightens dead air (&gt;0.65s) while leaving natural breathing pauses.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-2.5 rounded-xl border border-slate-200 dark:border-slate-800 p-3 cursor-pointer">
            <input
              type="checkbox"
              checked={applyEqOnRender}
              onChange={(e) => setApplyEqOnRender(e.target.checked)}
              className="mt-0.5 rounded accent-blue-600"
            />
            <div>
              <div className="text-xs font-semibold text-slate-900 dark:text-white">
                Apply 7-Band EQ &amp; Dynamics
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Renders your live console preset into the edited file / export.
              </p>
            </div>
          </label>
        </div>

        {/* Two-Track Voice-Over Layering */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-3.5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-bold text-slate-900 dark:text-white">
                Two-Track Voice-Over Layer
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Add an intro, commentary, or translation voice-over mixed cleanly over Track 1.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleToggleRecordVoiceOver}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ${
                  recordingVo
                    ? 'bg-rose-600 text-white'
                    : 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
                }`}
              >
                <Mic className="h-3.5 w-3.5" />
                <span>{recordingVo ? 'Stop Voice-Over' : 'Record Track 2'}</span>
              </button>
              <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer">
                <Upload className="h-3.5 w-3.5" />
                <span>Import Track 2</span>
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setVoiceOverBlob(f);
                  }}
                />
              </label>
            </div>
          </div>

          {voiceOverBlob && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs pt-1">
              <label className="space-y-1">
                <div className="flex justify-between text-slate-700 dark:text-slate-300">
                  <span>Voice-Over Start Offset</span>
                  <span className="font-mono">{formatClock(voiceOverOffset, true)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, duration)}
                  step={0.1}
                  value={voiceOverOffset}
                  onChange={(e) => setVoiceOverOffset(Number(e.target.value))}
                  className="w-full accent-blue-600"
                />
              </label>
              <label className="space-y-1">
                <div className="flex justify-between text-slate-700 dark:text-slate-300">
                  <span>Track 2 Mix Volume</span>
                  <span className="font-mono">{Math.round(voiceOverGain * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={1.4}
                  step={0.05}
                  value={voiceOverGain}
                  onChange={(e) => setVoiceOverGain(Number(e.target.value))}
                  className="w-full accent-blue-600"
                />
              </label>
            </div>
          )}
        </div>

        {/* Multi-Format Export Row */}
        {multiFormatExport && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-slate-800 p-3">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Client-Side Export:
            </span>
            <div className="flex flex-wrap gap-2">
              {(['mp3', 'wav', 'webm'] as const).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  disabled={busy}
                  onClick={() => handleExportFormat(fmt)}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50"
                >
                  <Download className="h-3.5 w-3.5 text-blue-600" />
                  <span>{fmt.toUpperCase()}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Footer Actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div>
            {recording.rawMasterBlob && (
              <button
                type="button"
                disabled={busy}
                onClick={handleRestoreOriginal}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 dark:border-amber-700 px-3 py-2 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Undo / Restore Original</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleApplyTrimAndMix}
              className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />}
              <span>Apply &amp; Save Edit</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
