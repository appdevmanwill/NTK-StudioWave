import { RotateCcw, ShieldAlert, Trash2 } from 'lucide-react';
import type { AutoSaveSession } from '../types/audio';
import { formatDuration } from '../utils/audioDsp';

interface CrashRecoveryModalProps {
  session: AutoSaveSession;
  onRestore: () => void;
  onDiscard: () => void;
  isRestoring: boolean;
}

export function CrashRecoveryModal({
  session,
  onRestore,
  onDiscard,
  isRestoring,
}: CrashRecoveryModalProps) {
  const savedTime = new Date(session.updatedAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="crash-recovery-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-6 shadow-2xl">
        <div className="flex items-start gap-3.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div>
            <h2
              id="crash-recovery-title"
              className="font-display text-lg font-bold text-slate-900 dark:text-white"
            >
              Unfinished Recording Recovered
            </h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              NTK StudioWave safely backed up your last recording every second before the browser closed.
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 px-4 py-3 text-sm">
          <div className="font-medium text-slate-900 dark:text-white">{session.title}</div>
          <div className="mt-1 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            <span>Duration: {formatDuration(session.durationSec, true)}</span>
            <span aria-hidden="true">·</span>
            <span>Saved {savedTime}</span>
            <span aria-hidden="true">·</span>
            <span>{session.chunkCount} chunks</span>
          </div>
        </div>

        <div className="mt-6 flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onDiscard}
            disabled={isRestoring}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <Trash2 className="h-4 w-4" />
            <span>Discard Backup</span>
          </button>
          <button
            type="button"
            onClick={onRestore}
            disabled={isRestoring}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors disabled:opacity-60"
          >
            <RotateCcw className="h-4 w-4" />
            <span>{isRestoring ? 'Restoring...' : 'Restore Into Editor'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
