import {
  CheckCircle2,
  Download,
  FileAudio,
  Layers,
  Play,
  Trash2,
  Upload,
  AlertCircle,
} from 'lucide-react';
import { useRef, useState } from 'react';
import type { BatchJobItem, BatchRecipe, ExportFormat, SilencePreset } from '../types/audio';
import {
  DEFAULT_EFFECTS,
  audioBackend,
  createAudioBufferFromChannels,
  extractChannels,
} from '../services/audioBackend';
import {
  SILENCE_PRESETS,
  detectSilences,
  formatFileSize,
  mixToMono,
  removeSilencesPCM,
} from '../utils/audioDsp';
import { saveBlobToDevice } from '../utils/platformFileSave';

interface BatchStudioViewProps {
  onNotify: (msg: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
}

export function BatchStudioView({ onNotify }: BatchStudioViewProps) {
  const [jobs, setJobs] = useState<BatchJobItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [recipe, setRecipe] = useState<BatchRecipe>({
    studioPolish: true,
    shrinkPauses: true,
    silencePreset: 'normal',
    autoLevel: true,
    format: 'mp3',
    bitrateKbps: 128,
  });

  const addFiles = (fileList: FileList | File[]) => {
    const arr = Array.from(fileList);
    if (arr.length === 0) return;
    const next: BatchJobItem[] = arr.map((file, idx) => ({
      id: `batch-${Date.now()}-${idx}`,
      file,
      name: file.name,
      originalSize: file.size,
      status: 'queued',
      progress: 0,
    }));
    setJobs((prev) => [...prev, ...next]);
  };

  const updateJob = (id: string, patch: Partial<BatchJobItem>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  };

  const handleRunBatch = async () => {
    if (jobs.length === 0) return;
    setIsRunning(true);

    for (const job of jobs) {
      if (job.status === 'done') continue;
      updateJob(job.id, { status: 'processing', progress: 15, error: undefined });
      try {
        const arrayBuf = await job.file.arrayBuffer();
        let audioBuf = await audioBackend.decodeAudioData(arrayBuf);
        updateJob(job.id, { progress: 35 });

        let savedSeconds = 0;
        if (recipe.shrinkPauses) {
          const presetCfg = SILENCE_PRESETS[recipe.silencePreset];
          const mono = mixToMono(extractChannels(audioBuf));
          const { regions } = detectSilences(mono, audioBuf.sampleRate, {
            thresholdDb: presetCfg.thresholdDb,
            minSilenceSec: presetCfg.minSilenceSec,
          });
          if (regions.length > 0) {
            const reduced = removeSilencesPCM(
              extractChannels(audioBuf),
              audioBuf.sampleRate,
              regions,
              presetCfg.keepPaddingSec,
              15
            );
            savedSeconds = reduced.savedSec;
            audioBuf = createAudioBufferFromChannels(
              audioBackend.getAudioContext(),
              reduced.channels,
              audioBuf.sampleRate
            );
          }
        }
        updateJob(job.id, { progress: 60 });

        if (recipe.studioPolish || recipe.autoLevel) {
          audioBuf = await audioBackend.renderEffects(audioBuf, {
            ...DEFAULT_EFFECTS,
            studioPolish: recipe.studioPolish,
            cleanNoise: recipe.studioPolish,
            autoLevel: recipe.autoLevel,
          });
        }
        updateJob(job.id, { progress: 82 });

        const encoded = await audioBackend.encodeAudio(audioBuf, {
          format: recipe.format,
          qualityMode: 'bitrate',
          bitrateKbps: recipe.bitrateKbps,
          targetSizeMb: 10,
          sampleRate: audioBuf.sampleRate,
          channels: audioBuf.numberOfChannels > 1 ? 2 : 1,
          metadata: {
            title: job.name.replace(/\.[^.]+$/, ''),
            artist: '',
            album: 'NTK StudioWave Batch',
            coverDataUrl: null,
          },
        });

        const base = job.name.replace(/\.[^.]+$/, '');
        updateJob(job.id, {
          status: 'done',
          progress: 100,
          outputBlob: encoded.blob,
          outputFilename: `${base}_clean.${encoded.extension}`,
          outputSize: encoded.blob.size,
          savedSeconds,
        });
      } catch {
        updateJob(job.id, {
          status: 'error',
          progress: 0,
          error: 'Could not decode or convert file.',
        });
      }
    }

    setIsRunning(false);
    onNotify('Batch processing complete! Ready to download.', 'success');
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    void saveBlobToDevice(blob, filename);
  };

  const handleDownloadAll = () => {
    const completed = jobs.filter((j) => j.status === 'done' && j.outputBlob && j.outputFilename);
    completed.forEach((j, idx) => {
      setTimeout(() => downloadBlob(j.outputBlob!, j.outputFilename!), idx * 250);
    });
    if (completed.length > 0) {
      onNotify(`Downloading ${completed.length} processed files...`, 'info');
    }
  };

  const doneCount = jobs.filter((j) => j.status === 'done').length;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Layers className="h-5 w-5 text-blue-500" />
              <span>Batch Clean & Convert Studio</span>
            </h1>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Drop multiple audio files, pick your studio cleanup recipe, and process everything locally in one pass.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {doneCount > 0 && (
              <button
                type="button"
                onClick={handleDownloadAll}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <Download className="h-3.5 w-3.5 text-blue-500" />
                <span>Download All ({doneCount})</span>
              </button>
            )}
            <button
              type="button"
              disabled={isRunning || jobs.length === 0}
              onClick={handleRunBatch}
              className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-5 py-2 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              <span>{isRunning ? 'Processing Batch...' : `Process ${jobs.length || ''} File${jobs.length === 1 ? '' : 's'}`}</span>
            </button>
          </div>
        </div>

        {/* Batch Recipe Builder */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-4 text-xs">
          <label className="flex items-center gap-2.5 cursor-pointer font-medium text-slate-800 dark:text-slate-200">
            <input
              type="checkbox"
              checked={recipe.studioPolish}
              onChange={(e) => setRecipe({ ...recipe, studioPolish: e.target.checked })}
              className="h-4 w-4 rounded accent-blue-600"
            />
            <span>Studio Voice Polish</span>
          </label>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-800 dark:text-slate-200">
              <input
                type="checkbox"
                checked={recipe.shrinkPauses}
                onChange={(e) => setRecipe({ ...recipe, shrinkPauses: e.target.checked })}
                className="h-4 w-4 rounded accent-blue-600"
              />
              <span>Shrink Pauses</span>
            </label>
            {recipe.shrinkPauses && (
              <select
                aria-label="Batch silence preset"
                value={recipe.silencePreset}
                onChange={(e) =>
                  setRecipe({ ...recipe, silencePreset: e.target.value as SilencePreset })
                }
                className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs"
              >
                <option value="gentle">Gentle</option>
                <option value="normal">Normal</option>
                <option value="tight">Tight</option>
              </select>
            )}
          </div>

          <label className="flex items-center gap-2.5 cursor-pointer font-medium text-slate-800 dark:text-slate-200">
            <input
              type="checkbox"
              checked={recipe.autoLevel}
              onChange={(e) => setRecipe({ ...recipe, autoLevel: e.target.checked })}
              className="h-4 w-4 rounded accent-blue-600"
            />
            <span>Auto-Level Volume</span>
          </label>

          <div className="flex items-center gap-2">
            <select
              aria-label="Batch output format"
              value={recipe.format}
              onChange={(e) => setRecipe({ ...recipe, format: e.target.value as ExportFormat })}
              className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs font-semibold uppercase"
            >
              <option value="mp3">MP3</option>
              <option value="wav">WAV</option>
              <option value="ogg">OGG</option>
              <option value="m4a">M4A</option>
              <option value="flac">FLAC</option>
            </select>
            {recipe.format !== 'wav' && recipe.format !== 'flac' && (
              <select
                aria-label="Batch output bitrate"
                value={recipe.bitrateKbps}
                onChange={(e) => setRecipe({ ...recipe, bitrateKbps: Number(e.target.value) })}
                className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono text-xs"
              >
                {[64, 96, 128, 192, 256, 320].map((b) => (
                  <option key={b} value={b}>
                    {b} kbps
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Multi-file Dropzone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragOver(false);
            if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
          }}
          className={`rounded-2xl border-2 border-dashed p-7 text-center transition-colors ${
            isDragOver
              ? 'border-blue-500 bg-blue-500/10'
              : 'border-slate-300 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/30'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="audio/*,.mp3,.wav,.ogg,.m4a,.webm,.flac"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <Upload className="mx-auto h-7 w-7 text-slate-400" />
          <p className="mt-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
            Drop multiple audio files here to queue them
          </p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            MP3, WAV, OGG, M4A, WebM, FLAC — processed 100% on your device
          </p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="mt-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            Select Multiple Files
          </button>
        </div>

        {/* Queue List with Per-File Progress Bars */}
        {jobs.length > 0 && (
          <div className="divide-y divide-slate-200 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
            {jobs.map((job) => (
              <div key={job.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <FileAudio className="h-4.5 w-4.5 text-blue-500 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                      {job.name}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] font-mono tabular-nums text-slate-500">
                      <span>{formatFileSize(job.originalSize)}</span>
                      {job.outputSize && (
                        <>
                          <span>→</span>
                          <span className="text-emerald-600 dark:text-emerald-400">
                            {formatFileSize(job.outputSize)}
                          </span>
                        </>
                      )}
                      {job.savedSeconds && job.savedSeconds > 0.1 ? (
                        <span className="font-sans text-blue-600 dark:text-blue-400">
                          (-{job.savedSeconds.toFixed(1)}s pauses)
                        </span>
                      ) : null}
                      {job.error && <span className="text-rose-500 font-sans">{job.error}</span>}
                    </div>
                    {job.status === 'processing' && (
                      <div className="mt-1.5 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                        <div
                          className="h-full bg-blue-600 transition-all"
                          style={{ width: `${job.progress}%` }}
                        />
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {job.status === 'done' && job.outputBlob && job.outputFilename && (
                    <button
                      type="button"
                      onClick={() => downloadBlob(job.outputBlob!, job.outputFilename!)}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600/15 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-600/25"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>Download</span>
                    </button>
                  )}
                  {job.status === 'error' && <AlertCircle className="h-4 w-4 text-rose-500" />}
                  {!isRunning && (
                    <button
                      type="button"
                      aria-label={`Remove ${job.name} from queue`}
                      onClick={() => setJobs((prev) => prev.filter((x) => x.id !== job.id))}
                      className="text-slate-400 hover:text-rose-500 p-1"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
