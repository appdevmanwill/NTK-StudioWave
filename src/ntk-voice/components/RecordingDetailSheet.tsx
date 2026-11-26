import {
  Check,
  Copy,
  Download,
  FileText,
  Flag,
  Loader2,
  Mic,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Scissors,
  Share2,
  Sliders,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  NtkCustomAiButton,
  NtkLiveConsoleSettings,
  NtkRecordingItem,
  NtkSeparatedStems,
  NtkVisibilityMatrix,
} from '../types';
import {
  decodeBlobToAudioBuffer,
  encodeAudioBufferToMp3Blob,
  encodeAudioBufferToWavBlob,
  renderBufferWithConsoleEq,
} from '../services/ntkAudioEngine';
import {
  formatClock,
  formatRecordingMarkdown,
  formatTranscriptSRT,
  formatTranscriptTXT,
  formatTranscriptVTT,
  triggerFileDownload,
} from '../utils/ntkAudioUtils';
import { StemMixerPanel } from './StemMixerPanel';

interface RecordingDetailSheetProps {
  recording: NtkRecordingItem;
  aiButtons: NtkCustomAiButton[];
  visibility: NtkVisibilityMatrix;
  showAdvanced: boolean;
  stemConfigured: boolean;
  consoleSettings: NtkLiveConsoleSettings;
  busyActionId: string | null;
  onRunAiButton: (recording: NtkRecordingItem, button: NtkCustomAiButton) => Promise<void>;
  onUpdateRecording: (updated: NtkRecordingItem) => Promise<void>;
  onOpenTrimmer: () => void;
  onOpenManage: () => void;
  onClose: () => void;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
}

const SPEEDS = [1, 1.25, 1.5, 2] as const;

export function RecordingDetailSheet({
  recording,
  aiButtons,
  visibility,
  showAdvanced,
  stemConfigured,
  consoleSettings,
  busyActionId,
  onRunAiButton,
  onUpdateRecording,
  onOpenTrimmer,
  onOpenManage,
  onClose,
  onNotify,
}: RecordingDetailSheetProps) {
  const [activeTab, setActiveTab] = useState<'flags' | 'notes' | 'transcript' | 'stems'>(
    visibility.aiFeaturesEnabled ? 'notes' : 'flags'
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(recording.durationSec || 0);
  const [speed, setSpeed] = useState<number>(1);
  const [flagNoteInput, setFlagNoteInput] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [localListening, setLocalListening] = useState(false);
  const [exportingFmt, setExportingFmt] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  const enabledButtons = useMemo(
    () => aiButtons.filter((b) => b.enabled),
    [aiButtons]
  );

  useEffect(() => {
    const url = URL.createObjectURL(recording.audioBlob);
    blobUrlRef.current = url;
    if (audioRef.current) {
      audioRef.current.src = url;
      audioRef.current.playbackRate = speed;
    }
    setCurrentTime(0);
    setDuration(recording.durationSec || 0);
    setIsPlaying(false);
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, [recording.id, recording.audioBlob]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = speed;
    }
  }, [speed]);

  useEffect(() => {
    if (!visibility.aiFeaturesEnabled && activeTab === 'notes') {
      if (visibility.momentFlags) {
        setActiveTab('flags');
      } else if (recording.transcript.length > 0) {
        setActiveTab('transcript');
      } else if (showAdvanced && visibility.aiStemMixer) {
        setActiveTab('stems');
      }
    }
  }, [
    visibility.aiFeaturesEnabled,
    visibility.momentFlags,
    visibility.aiStemMixer,
    showAdvanced,
    activeTab,
    recording.transcript.length,
  ]);

  const seekTo = (sec: number) => {
    const el = audioRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(duration || recording.durationSec || 0, sec));
    el.currentTime = clamped;
    setCurrentTime(clamped);
  };

  const togglePlay = async () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      try {
        await el.play();
        setIsPlaying(true);
      } catch {
        onNotify('Tap play again to start audio playback.', 'info');
      }
    } else {
      el.pause();
      setIsPlaying(false);
    }
  };

  const handleAddFlag = async () => {
    const newFlag = {
      id: `flag-${Date.now()}`,
      timeSec: Number(currentTime.toFixed(1)),
      note: flagNoteInput.trim() || `Flag at ${formatClock(currentTime)}`,
      createdAt: Date.now(),
    };
    await onUpdateRecording({
      ...recording,
      flags: [...recording.flags, newFlag].sort((a, b) => a.timeSec - b.timeSec),
      updatedAt: Date.now(),
    });
    setFlagNoteInput('');
    onNotify(`Flag saved at ${formatClock(newFlag.timeSec)}.`, 'success');
  };

  const handleDeleteFlag = async (flagId: string) => {
    await onUpdateRecording({
      ...recording,
      flags: recording.flags.filter((f) => f.id !== flagId),
      updatedAt: Date.now(),
    });
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      onNotify('Copy blocked by browser — select text manually.', 'warning');
    }
  };

  const handleDownloadExport = async (fmt: 'wav' | 'mp3' | 'webm' | 'txt' | 'srt' | 'vtt' | 'md') => {
    const safe = (recording.title || 'ntk-recording').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 42);
    if (fmt === 'txt') {
      const content =
        recording.transcript.length > 0
          ? formatTranscriptTXT(recording.transcript)
          : recording.transcriptText;
      triggerFileDownload(new Blob([content], { type: 'text/plain;charset=utf-8' }), `${safe}.txt`);
      return;
    }
    if (fmt === 'srt') {
      triggerFileDownload(
        new Blob([formatTranscriptSRT(recording.transcript)], { type: 'text/plain;charset=utf-8' }),
        `${safe}.srt`
      );
      return;
    }
    if (fmt === 'vtt') {
      triggerFileDownload(
        new Blob([formatTranscriptVTT(recording.transcript)], { type: 'text/vtt;charset=utf-8' }),
        `${safe}.vtt`
      );
      return;
    }
    if (fmt === 'md') {
      triggerFileDownload(
        new Blob([formatRecordingMarkdown(recording)], { type: 'text/markdown;charset=utf-8' }),
        `${safe}_notes.md`
      );
      return;
    }
    if (fmt === 'webm') {
      triggerFileDownload(recording.audioBlob, `${safe}.webm`);
      return;
    }
    setExportingFmt(fmt);
    try {
      const decoded = await decodeBlobToAudioBuffer(recording.audioBlob);
      const processed = !consoleSettings.bakeEqLive
        ? await renderBufferWithConsoleEq(decoded, consoleSettings)
        : decoded;
      if (fmt === 'mp3') {
        triggerFileDownload(encodeAudioBufferToMp3Blob(processed, 160), `${safe}.mp3`);
      } else {
        triggerFileDownload(encodeAudioBufferToWavBlob(processed), `${safe}.wav`);
      }
      onNotify(`Downloaded ${safe}.${fmt}`, 'success');
    } catch {
      triggerFileDownload(recording.audioBlob, `${safe}.webm`);
      onNotify('Exported original audio container.', 'info');
    } finally {
      setExportingFmt(null);
    }
  };

  const handleShare = async () => {
    const safe = (recording.title || 'ntk-recording').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40);
    const ext = /wav/i.test(recording.mimeType) ? 'wav' : /mp3/i.test(recording.mimeType) ? 'mp3' : 'webm';
    const file = new File([recording.audioBlob], `${safe}.${ext}`, {
      type: recording.mimeType || 'audio/webm',
    });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          title: recording.title,
          text: recording.aiNotes[0]?.text?.slice(0, 200) || 'Recorded in NTK Reorder Suite',
          files: [file],
        });
        return;
      } catch {
        // user canceled share sheet
        return;
      }
    }
    triggerFileDownload(recording.audioBlob, `${safe}.${ext}`);
    onNotify('Downloaded recording directly to your device.', 'info');
  };

  const handleBrowserSpeechFallback = () => {
    const win = window as unknown as {
      SpeechRecognition?: new () => {
        continuous: boolean;
        interimResults: boolean;
        lang: string;
        onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
        onerror: (() => void) | null;
        onend: (() => void) | null;
        start: () => void;
        stop: () => void;
      };
      webkitSpeechRecognition?: new () => {
        continuous: boolean;
        interimResults: boolean;
        lang: string;
        onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
        onerror: (() => void) | null;
        onend: (() => void) | null;
        start: () => void;
        stop: () => void;
      };
    };
    const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SR) {
      onNotify('Browser local dictation is not available in this browser — use Cloud Get Text.', 'warning');
      return;
    }
    setLocalListening(true);
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = 'en-US';
    rec.onresult = async (ev) => {
      const spoken = Array.from(ev.results)
        .map((r) => r[0]?.transcript || '')
        .join(' ')
        .trim();
      if (spoken) {
        const seg = {
          id: `local-${Date.now()}`,
          start: Number(currentTime.toFixed(1)),
          end: Number((currentTime + 4).toFixed(1)),
          text: spoken,
          provider: 'browser-local',
        };
        await onUpdateRecording({
          ...recording,
          transcript: [...recording.transcript, seg],
          transcriptText: [recording.transcriptText, spoken].filter(Boolean).join(' '),
          updatedAt: Date.now(),
        });
        onNotify('Added browser local speech note.', 'success');
      }
    };
    rec.onerror = () => setLocalListening(false);
    rec.onend = () => setLocalListening(false);
    rec.start();
  };

  const handleSaveStems = async (stems: NtkSeparatedStems) => {
    await onUpdateRecording({
      ...recording,
      stems,
      updatedAt: Date.now(),
    });
  };

  return (
    <div
      data-testid="ntk-detail-sheet"
      className="fixed inset-x-0 bottom-0 md:static z-40 md:z-auto rounded-t-3xl md:rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] shadow-2xl md:shadow-none max-h-[84vh] md:max-h-none flex flex-col overflow-hidden"
    >
      {/* Mobile drag handle indicator */}
      <div className="flex md:hidden justify-center pt-2.5 pb-1">
        <span className="h-1.5 w-12 rounded-full bg-slate-300 dark:bg-slate-700" />
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 dark:border-slate-800 px-4 sm:px-5 py-3.5">
        <div className="min-w-0">
          <h3 className="font-display text-base font-bold text-slate-900 dark:text-white truncate">
            {recording.title}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {recording.speakerName ? `${recording.speakerName} · ` : ''}
            {new Date(recording.createdAt).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
            {' · '}
            {formatClock(duration || recording.durationSec)}
          </p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleShare}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
            title="Share or Download"
          >
            <Share2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Share</span>
          </button>
          {showAdvanced && visibility.waveformTrimmer && (
            <button
              type="button"
              onClick={onOpenTrimmer}
              className="inline-flex items-center gap-1 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 px-2.5 py-1.5 text-xs font-semibold text-blue-700 dark:text-blue-300"
            >
              <Scissors className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Trim &amp; Layer</span>
            </button>
          )}
          <button
            type="button"
            aria-label="Close recording details"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 pb-8 md:pb-5">
        {/* Audio Player Bar */}
        <audio
          ref={audioRef}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDuration(d);
          }}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onEnded={() => setIsPlaying(false)}
          className="hidden"
        />

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-3.5 space-y-3">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => seekTo(currentTime - 10)}
              aria-label="Skip back 10 seconds"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100"
              title="-10s"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={togglePlay}
              aria-label={isPlaying ? 'Pause playback' : 'Play recording'}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700 shadow-sm shrink-0"
            >
              {isPlaying ? <Pause className="h-4.5 w-4.5" /> : <Play className="h-4.5 w-4.5 ml-0.5" />}
            </button>
            <button
              type="button"
              onClick={() => seekTo(currentTime + 10)}
              aria-label="Skip forward 10 seconds"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100"
              title="+10s"
            >
              <RotateCw className="h-4 w-4" />
            </button>

            <div className="flex-1 min-w-0">
              <input
                type="range"
                aria-label="Seek audio position"
                min={0}
                max={Math.max(0.5, duration || recording.durationSec || 1)}
                step={0.1}
                value={currentTime}
                onChange={(e) => seekTo(Number(e.target.value))}
                className="w-full accent-blue-600 cursor-pointer"
              />
              <div className="flex justify-between font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                <span>{formatClock(currentTime)}</span>
                <span>{formatClock(duration || recording.durationSec)}</span>
              </div>
            </div>
          </div>

          {/* Speed Pills + Quick Download */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-1" role="group" aria-label="Playback speed">
              {SPEEDS.map((sp) => (
                <button
                  key={sp}
                  type="button"
                  onClick={() => setSpeed(sp)}
                  className={`rounded-lg px-2 py-1 text-xs font-semibold tabular-nums transition-colors ${
                    speed === sp
                      ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
                      : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {sp}x
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={exportingFmt !== null}
                onClick={() => handleDownloadExport('mp3')}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:text-slate-200"
              >
                <Download className="h-3.5 w-3.5 text-blue-600" />
                <span>{exportingFmt === 'mp3' ? '...' : 'MP3'}</span>
              </button>
              {visibility.multiFormatExport && (
                <>
                  <button
                    type="button"
                    disabled={exportingFmt !== null}
                    onClick={() => handleDownloadExport('wav')}
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:text-slate-200"
                  >
                    {exportingFmt === 'wav' ? '...' : 'WAV'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDownloadExport('webm')}
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:text-slate-200"
                  >
                    WebM
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Optional 1-Click AI Action Buttons (hidden when AI is OFF) */}
        {(visibility.aiFeaturesEnabled || visibility.localBrowserWhisperFallback) && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-blue-600" />
                <span>
                  {visibility.aiFeaturesEnabled ? 'Optional 1-Click AI Actions' : 'Optional Local Dictation'}
                </span>
              </span>
              {visibility.localBrowserWhisperFallback && (
                <button
                  type="button"
                  disabled={localListening}
                  onClick={handleBrowserSpeechFallback}
                  className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-blue-600"
                >
                  <Mic className="h-3.5 w-3.5" />
                  <span>{localListening ? 'Listening locally...' : 'Browser Dictation Fallback'}</span>
                </button>
              )}
            </div>
            {visibility.aiFeaturesEnabled && (
              <div className="flex flex-wrap gap-2">
                {enabledButtons.map((btn) => {
                  const busy = busyActionId === `${recording.id}:${btn.id}`;
                  return (
                    <button
                      key={btn.id}
                      type="button"
                      disabled={busyActionId !== null}
                      onClick={() => onRunAiButton(recording, btn)}
                      title={btn.description}
                      className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-60 ${
                        btn.kind === 'transcribe'
                          ? 'bg-blue-600 text-white hover:bg-blue-700'
                          : 'border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      <span>{btn.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Section Tabs */}
        <div
          role="tablist"
          className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800 overflow-x-auto"
        >
          {[
            ...(visibility.momentFlags
              ? [{ id: 'flags', label: `Flags (${recording.flags.length})` }]
              : []),
            ...(visibility.aiFeaturesEnabled || recording.aiNotes.length > 0
              ? [{ id: 'notes', label: `AI Notes (${recording.aiNotes.length})` }]
              : []),
            ...(visibility.aiFeaturesEnabled ||
            visibility.localBrowserWhisperFallback ||
            recording.transcript.length > 0
              ? [{ id: 'transcript', label: `Transcript (${recording.transcript.length})` }]
              : []),
            ...(showAdvanced && visibility.aiStemMixer
              ? [{ id: 'stems', label: '4-Track Stems' }]
              : []),
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={`px-3 py-2 text-xs font-semibold border-b-2 whitespace-nowrap transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab: AI Notes */}
        {activeTab === 'notes' && (
          <div className="space-y-3">
            {recording.aiNotes.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-5 text-center space-y-1.5">
                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                  No AI notes yet
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Tap <strong>Get Text</strong> first, then tap <strong>Short Summary</strong>,{' '}
                  <strong>Action Items</strong>, or <strong>Clean Formal Email</strong>.
                </p>
              </div>
            ) : (
              recording.aiNotes.map((note) => (
                <div
                  key={note.id}
                  className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-3.5 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <span className="text-xs font-bold text-slate-900 dark:text-white">
                        {note.label}
                      </span>
                      <span className="ml-2 text-[11px] text-slate-500 dark:text-slate-400">
                        via {note.provider}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCopy(note.id, note.text)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200"
                    >
                      {copiedId === note.id ? (
                        <Check className="h-3 w-3 text-emerald-600" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      <span>{copiedId === note.id ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <div className="text-xs leading-relaxed text-slate-700 dark:text-slate-200 whitespace-pre-wrap">
                    {note.text}
                  </div>
                </div>
              ))
            )}

            {(recording.aiNotes.length > 0 || recording.transcript.length > 0) && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => handleDownloadExport('md')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200"
                >
                  <FileText className="h-3.5 w-3.5 text-blue-600" />
                  <span>Export Formatted Notes (.MD)</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Tab: Interactive Clickable Transcript */}
        {activeTab === 'transcript' && (
          <div className="space-y-3">
            {recording.transcript.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Click any line below to jump playback directly to that moment.
                </span>
                <div className="flex items-center gap-1.5">
                  {(['txt', 'srt', 'vtt', 'md'] as const).map((ext) => (
                    <button
                      key={ext}
                      type="button"
                      onClick={() => handleDownloadExport(ext)}
                      className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-semibold uppercase text-slate-700 dark:text-slate-200 hover:bg-slate-50"
                    >
                      {ext}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {recording.transcript.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-5 text-center space-y-1.5">
                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                  No transcript yet
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Tap <strong>Get Text</strong> above to automatically slice large audio and transcribe via your free cloud API pool.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                {recording.transcript.map((seg) => {
                  const isActive = currentTime >= seg.start && currentTime <= seg.end + 0.3;
                  return (
                    <button
                      key={seg.id}
                      type="button"
                      onClick={() => {
                        seekTo(seg.start);
                        if (audioRef.current?.paused) togglePlay();
                      }}
                      className={`w-full text-left flex items-start gap-2.5 rounded-xl border px-3 py-2 text-xs transition-colors ${
                        isActive
                          ? 'border-blue-500 bg-blue-50/80 dark:bg-blue-950/40 text-slate-900 dark:text-white'
                          : 'border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/40 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                      }`}
                    >
                      <span className="font-mono text-[11px] font-semibold text-blue-600 dark:text-blue-400 shrink-0 mt-0.5 tabular-nums">
                        {formatClock(seg.start)}
                      </span>
                      <span className="flex-1 leading-relaxed">
                        {seg.speaker && (
                          <strong className="mr-1.5 text-slate-900 dark:text-white">
                            {seg.speaker}:
                          </strong>
                        )}
                        {seg.text}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Tab: Moment Flags */}
        {activeTab === 'flags' && visibility.momentFlags && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={flagNoteInput}
                onChange={(e) => setFlagNoteInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddFlag();
                }}
                placeholder={`Add note at ${formatClock(currentTime)}...`}
                className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-white"
              />
              <button
                type="button"
                onClick={handleAddFlag}
                className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-600 shrink-0"
              >
                <Flag className="h-3.5 w-3.5" />
                <span>Add Flag</span>
              </button>
            </div>

            {recording.flags.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400 py-3 text-center">
                No flags yet. Tap Flag while recording or add a timestamped note above.
              </p>
            ) : (
              <div className="space-y-1.5">
                {recording.flags.map((flag) => (
                  <div
                    key={flag.id}
                    className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 px-3 py-2"
                  >
                    <button
                      type="button"
                      onClick={() => seekTo(flag.timeSec)}
                      className="flex items-center gap-2.5 text-left min-w-0 flex-1"
                    >
                      <span className="font-mono text-xs font-bold text-amber-600 dark:text-amber-400 shrink-0">
                        {formatClock(flag.timeSec)}
                      </span>
                      <span className="text-xs text-slate-800 dark:text-slate-200 truncate">
                        {flag.note}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove flag at ${formatClock(flag.timeSec)}`}
                      onClick={() => handleDeleteFlag(flag.id)}
                      className="text-slate-400 hover:text-rose-500 p-1"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab: 4-Track AI Stem Mixer */}
        {activeTab === 'stems' && showAdvanced && visibility.aiStemMixer && (
          <StemMixerPanel
            recording={recording}
            stemConfigured={stemConfigured}
            onSaveStems={handleSaveStems}
            onOpenManage={onOpenManage}
            onNotify={onNotify}
          />
        )}
      </div>
    </div>
  );
}
