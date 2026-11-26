import {
  Check,
  Cloud,
  Copy,
  Download,
  FileText,
  ListChecks,
  Loader2,
  Mic,
  Plus,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { TranscriptSegment } from '../types/audio';
import { isAndroidNative } from '../utils/platformFileSave';
import {
  analyzeTranscriptWithCloudAi,
  fetchCloudAiStatus,
  isBrowserLocalSpeechSupported,
  transcribeAudioWithCloudAi,
  type AiAnalysisMode,
  type AiAnalysisResult,
  type CloudAiStatus,
} from '../services/aiApiClient';
import {
  countFillerWords,
  formatDuration,
  formatPlainTranscript,
  formatSrtCaptions,
} from '../utils/audioDsp';

interface AiTranscriptPanelProps {
  buffer: AudioBuffer;
  duration: number;
  currentTime: number;
  transcript: TranscriptSegment[];
  onChangeTranscript: (next: TranscriptSegment[]) => void;
  onJumpAndPlay: (timeSec: number) => void;
  onDownloadTextFile: (content: string, ext: 'txt' | 'srt') => void;
  enableCloudAiApi: boolean;
  showLocalSpeechOption: boolean;
  showNoviceHints: boolean;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
}

interface MinimalSpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}

interface MinimalSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: MinimalSpeechRecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

export function AiTranscriptPanel({
  buffer,
  duration,
  currentTime,
  transcript,
  onChangeTranscript,
  onJumpAndPlay,
  onDownloadTextFile,
  enableCloudAiApi,
  showLocalSpeechOption,
  showNoviceHints,
  onNotify,
}: AiTranscriptPanelProps) {
  const [aiStatus, setAiStatus] = useState<CloudAiStatus | null>(null);
  const [serverOffline, setServerOffline] = useState(false);
  const [language, setLanguage] = useState('auto');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState<AiAnalysisMode | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AiAnalysisResult | null>(null);
  const [copiedResult, setCopiedResult] = useState(false);

  // Optional browser local dictation state (runs locally in browser if supported)
  const [localListening, setLocalListening] = useState(false);
  const speechRecRef = useRef<MinimalSpeechRecognition | null>(null);
  const localSpeechAvailable = isBrowserLocalSpeechSupported();

  useEffect(() => {
    if (!enableCloudAiApi || isAndroidNative()) {
      setServerOffline(false);
      return;
    }
    fetchCloudAiStatus()
      .then((status) => {
        setAiStatus(status);
        setServerOffline(false);
      })
      .catch(() => {
        setAiStatus(null);
        setServerOffline(true);
      });
  }, [enableCloudAiApi]);

  useEffect(() => {
    return () => {
      try {
        speechRecRef.current?.stop();
      } catch {
        // ignore cleanup error
      }
    };
  }, []);

  const totalFillerWords = transcript.reduce((sum, s) => sum + countFillerWords(s.text), 0);

  const handleCloudTranscribe = async () => {
    setIsTranscribing(true);
    try {
      const res = await transcribeAudioWithCloudAi(buffer, language);
      if (res.segments.length === 0) {
        onNotify('No spoken words were detected in this clip.', 'warning');
      } else {
        onChangeTranscript(res.segments);
        onNotify(
          `Transcribed ${res.segments.length} caption line(s) via Cloud AI API!`,
          'success'
        );
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Cloud AI transcription failed.', 'error');
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleCloudAnalyze = async (mode: AiAnalysisMode) => {
    const fullText = formatPlainTranscript(transcript).trim();
    if (!fullText) {
      onNotify('Transcribe your audio or add transcript lines first.', 'warning');
      return;
    }
    setIsAnalyzing(mode);
    try {
      const result = await analyzeTranscriptWithCloudAi(fullText, mode, duration);
      setAnalysisResult(result);
      onNotify(`Generated ${result.headline} using Cloud AI API.`, 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Cloud AI analysis failed.', 'error');
    } finally {
      setIsAnalyzing(null);
    }
  };

  const handleToggleLocalSpeech = () => {
    if (localListening) {
      try {
        speechRecRef.current?.stop();
      } catch {
        // ignore
      }
      setLocalListening(false);
      return;
    }
    const w = window as unknown as {
      SpeechRecognition?: new () => MinimalSpeechRecognition;
      webkitSpeechRecognition?: new () => MinimalSpeechRecognition;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      onNotify(
        'Local browser speech dictation is not supported in this browser — use Cloud AI API instead.',
        'warning'
      );
      return;
    }

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = language === 'auto' ? 'en-US' : language;
    rec.onresult = (event) => {
      const added: TranscriptSegment[] = [];
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          const phrase = res[0].transcript.trim();
          if (phrase) {
            added.push({
              id: `local-${Date.now()}-${i}`,
              start: Number(currentTime.toFixed(2)),
              end: Number(Math.min(duration, currentTime + 3.5).toFixed(2)),
              text: phrase,
            });
          }
        }
      }
      if (added.length > 0) {
        onChangeTranscript([...transcript, ...added]);
      }
    };
    rec.onerror = () => {
      setLocalListening(false);
      onNotify('Local browser speech stopped. You can also use Cloud AI API.', 'warning');
    };
    rec.onend = () => setLocalListening(false);
    speechRecRef.current = rec;
    rec.start();
    setLocalListening(true);
    onNotify('Local browser dictation listening — speak or play audio near your mic.', 'info');
  };

  const handleCopyAnalysis = () => {
    if (!analysisResult) return;
    const body = analysisResult.cleanedText
      ? `${analysisResult.headline}\n\n${analysisResult.cleanedText}`
      : `${analysisResult.headline}\n\n${analysisResult.items.map((x) => `• ${x}`).join('\n')}`;
    navigator.clipboard?.writeText(body).catch(() => {});
    setCopiedResult(true);
    setTimeout(() => setCopiedResult(false), 1800);
  };

  return (
    <div className="space-y-5" data-testid="ai-transcript-panel">
      {/* Cloud AI API & Optional Local Speech Card */}
      {(enableCloudAiApi || showLocalSpeechOption) && (
        <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Cloud className="h-4.5 w-4.5 text-blue-600 dark:text-blue-400" />
                <span>AI Transcription &amp; Smart Office Notes</span>
              </h3>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Runs over lightweight Cloud AI API — works smoothly on low-RAM office PCs and phones with zero local model downloads.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-500 dark:text-slate-400 sr-only" htmlFor="ai-lang-select">
                Language
              </label>
              <select
                id="ai-lang-select"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="min-h-[44px] sm:min-h-[38px] rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-200"
              >
                <option value="auto">Auto-detect language</option>
                <option value="en-US">English</option>
                <option value="es-ES">Spanish</option>
                <option value="fr-FR">French</option>
                <option value="de-DE">German</option>
                <option value="pt-BR">Portuguese</option>
                <option value="ar-SA">Arabic</option>
              </select>
            </div>
          </div>

          {showNoviceHints && (
            <p className="text-xs text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900/60 rounded-xl px-3.5 py-2.5 border border-slate-200/70 dark:border-slate-800">
              How it works: Click <strong>Transcribe Audio (Cloud AI)</strong> to turn your recording into editable text, then click <strong>Meeting Summary</strong> or <strong>Action Items</strong> to create quick office notes.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2.5">
            {enableCloudAiApi && (
              <button
                type="button"
                data-testid="cloud-ai-transcribe-btn"
                disabled={isTranscribing}
                onClick={handleCloudTranscribe}
                className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-xs sm:text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {isTranscribing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Transcribing via Cloud API...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    <span>Transcribe Audio (Cloud AI API)</span>
                  </>
                )}
              </button>
            )}

            {showLocalSpeechOption && (
              <button
                type="button"
                data-testid="local-speech-dictate-btn"
                onClick={handleToggleLocalSpeech}
                className={`min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-xs font-semibold transition-colors ${
                  localListening
                    ? 'border-rose-500 bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300'
                    : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                {localListening ? (
                  <>
                    <Square className="h-3.5 w-3.5 fill-current" />
                    <span>Stop Local Dictation</span>
                  </>
                ) : (
                  <>
                    <Mic className="h-3.5 w-3.5" />
                    <span>
                      {localSpeechAvailable
                        ? 'Local Browser Speech (Optional)'
                        : 'Local Browser Speech (Unavailable)'}
                    </span>
                  </>
                )}
              </button>
            )}
          </div>

          {enableCloudAiApi && serverOffline && (
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Note: Optional Cloud AI server is currently offline. Local manual captions still work immediately with no server or API key.
            </p>
          )}

          {enableCloudAiApi && !serverOffline && aiStatus && !aiStatus.configured && (
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Note: Optional Cloud AI API has no server key configured yet. Local manual captions still work immediately without any API key.
            </p>
          )}

          {/* Smart AI Actions Row */}
          {enableCloudAiApi && (
            <div className="border-t border-slate-100 dark:border-slate-800 pt-4 space-y-2.5">
              <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                Smart AI Tools (works on your transcript below):
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {(
                  [
                    { mode: 'summary', label: 'Meeting Summary', icon: FileText },
                    { mode: 'action_items', label: 'Action Items', icon: ListChecks },
                    { mode: 'clean_script', label: 'Clean Script', icon: Sparkles },
                    { mode: 'chapters', label: 'Auto Chapters', icon: Plus },
                  ] as const
                ).map((item) => {
                  const Icon = item.icon;
                  const busy = isAnalyzing === item.mode;
                  return (
                    <button
                      key={item.mode}
                      type="button"
                      data-testid={`ai-analyze-${item.mode}`}
                      disabled={isAnalyzing !== null || transcript.length === 0}
                      onClick={() => handleCloudAnalyze(item.mode)}
                      className="min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/70 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-45 transition-colors"
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
                      ) : (
                        <Icon className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                      )}
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Rendered AI Analysis Result */}
          {analysisResult && (
            <div
              data-testid="ai-analysis-output"
              className="rounded-xl border border-blue-200 dark:border-blue-500/30 bg-blue-50/60 dark:bg-blue-500/10 p-4 space-y-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="font-display text-sm font-bold text-slate-900 dark:text-white">
                  {analysisResult.headline}
                </div>
                <button
                  type="button"
                  onClick={handleCopyAnalysis}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50"
                >
                  {copiedResult ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedResult ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              {analysisResult.cleanedText ? (
                <p className="text-sm text-slate-800 dark:text-slate-200 leading-relaxed whitespace-pre-wrap">
                  {analysisResult.cleanedText}
                </p>
              ) : (
                <ul className="space-y-1.5 text-sm text-slate-800 dark:text-slate-200 list-disc pl-5">
                  {analysisResult.items.map((line, i) => (
                    <li key={i} className="leading-relaxed">
                      {line}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {/* Editable Captions & Export Card */}
      <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
              Transcript &amp; Captions
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Edit lines, spot filler words ({totalFillerWords} found), and download as .TXT or .SRT.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                onChangeTranscript([
                  ...transcript,
                  {
                    id: `tr-${Date.now()}`,
                    start: Number(currentTime.toFixed(2)),
                    end: Number(Math.min(duration, currentTime + 3).toFixed(2)),
                    text: 'New caption note...',
                  },
                ])
              }
              className="min-h-[40px] inline-flex items-center gap-1 rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Line</span>
            </button>
            <button
              type="button"
              disabled={transcript.length === 0}
              onClick={() => onDownloadTextFile(formatPlainTranscript(transcript), 'txt')}
              className="min-h-[40px] inline-flex items-center gap-1 rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" />
              <span>.TXT</span>
            </button>
            <button
              type="button"
              disabled={transcript.length === 0}
              onClick={() => onDownloadTextFile(formatSrtCaptions(transcript), 'srt')}
              className="min-h-[40px] inline-flex items-center gap-1 rounded-xl bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" />
              <span>.SRT Captions</span>
            </button>
          </div>
        </div>

        {transcript.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40 p-6 text-center text-xs text-slate-500">
            {enableCloudAiApi ? (
              <>
                No transcript lines yet. Click <strong>Transcribe Audio (Cloud AI API)</strong> above or{' '}
                <strong>Add Line</strong> to type captions manually.
              </>
            ) : (
              <>
                No transcript lines yet. Click <strong>Add Line</strong> to type timestamped captions manually
                (optional Cloud AI can be turned on anytime in Customize).
              </>
            )}
          </div>
        ) : (
          <div className="space-y-2.5">
            {transcript.map((seg) => {
              const fillers = countFillerWords(seg.text);
              return (
                <div
                  key={seg.id}
                  className="flex flex-col sm:flex-row sm:items-center gap-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-3"
                >
                  <button
                    type="button"
                    onClick={() => onJumpAndPlay(seg.start)}
                    className="font-mono text-xs tabular-nums text-blue-600 dark:text-blue-400 hover:underline shrink-0 text-left min-h-[32px] flex items-center"
                  >
                    {formatDuration(seg.start, true)} – {formatDuration(seg.end, true)}
                  </button>
                  <input
                    type="text"
                    aria-label={`Transcript text at ${formatDuration(seg.start)}`}
                    value={seg.text}
                    onChange={(e) =>
                      onChangeTranscript(
                        transcript.map((t) => (t.id === seg.id ? { ...t, text: e.target.value } : t))
                      )
                    }
                    className="flex-1 min-h-[40px] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D121C] px-3 py-1.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <div className="flex items-center justify-between sm:justify-end gap-2 shrink-0">
                    {fillers > 0 && (
                      <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                        {fillers} filler{fillers === 1 ? '' : 's'}
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label="Delete transcript line"
                      onClick={() => onChangeTranscript(transcript.filter((t) => t.id !== seg.id))}
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
