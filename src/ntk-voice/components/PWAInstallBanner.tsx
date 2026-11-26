import { Download, PlusSquare, Share, Smartphone, WifiOff, X } from 'lucide-react';
import { useState } from 'react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  compact?: boolean;
  className?: string;
}

export function PWAInstallButton({ compact = false, className = '' }: PWAInstallButtonProps) {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) return null;

  const handleClick = async () => {
    if (isInstallable) {
      await install();
      return;
    }
    setShowGuide(true);
  };

  return (
    <>
      <button
        type="button"
        data-testid="ntk-pwa-install-btn"
        onClick={handleClick}
        className={`inline-flex items-center gap-1.5 rounded-lg border border-blue-200 dark:border-blue-800/70 bg-blue-50/90 dark:bg-blue-950/40 px-2.5 py-1.5 text-xs font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors whitespace-nowrap ${className}`}
        title="Install NTK StudioWave as a fast desktop or mobile app"
      >
        <Download className="h-3.5 w-3.5 shrink-0" />
        <span>{compact ? 'Install' : isIOS ? 'Install on iPhone' : 'Install App'}</span>
      </button>

      {showGuide && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="ntk-pwa-guide-title"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/55 backdrop-blur-xs p-0 sm:p-4"
        >
          <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 sm:p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white shrink-0">
                  <Smartphone className="h-5 w-5" />
                </span>
                <div>
                  <h3
                    id="ntk-pwa-guide-title"
                    className="font-display text-base font-bold text-slate-900 dark:text-white"
                  >
                    Install NTK StudioWave App
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Works offline on office PCs, Android, and iPhone
                  </p>
                </div>
              </div>
              <button
                type="button"
                aria-label="Close install guide"
                onClick={() => setShowGuide(false)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {isIOS ? (
              <div className="mt-4 space-y-3">
                <div className="flex items-start gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-3.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
                    1
                  </span>
                  <div className="text-sm text-slate-700 dark:text-slate-200">
                    Tap the{' '}
                    <span className="inline-flex items-center gap-1 rounded bg-white dark:bg-slate-800 px-1.5 py-0.5 text-xs font-semibold border border-slate-200 dark:border-slate-700">
                      <Share className="h-3.5 w-3.5 text-blue-600" />
                      Share
                    </span>{' '}
                    button at the bottom of Safari.
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-3.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
                    2
                  </span>
                  <div className="text-sm text-slate-700 dark:text-slate-200">
                    Scroll down and tap{' '}
                    <span className="inline-flex items-center gap-1 rounded bg-white dark:bg-slate-800 px-1.5 py-0.5 text-xs font-semibold border border-slate-200 dark:border-slate-700">
                      <PlusSquare className="h-3.5 w-3.5 text-blue-600" />
                      Add to Home Screen
                    </span>
                    .
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-3.5 text-sm text-slate-700 dark:text-slate-200 space-y-2">
                  <p className="font-semibold text-slate-900 dark:text-white">
                    Chrome, Edge, or Android:
                  </p>
                  <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                    Click the install icon in the browser address bar (or open the browser menu and select{' '}
                    <strong>Install NTK StudioWave</strong> / <strong>Add to Home screen</strong>).
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-3.5 text-sm text-slate-700 dark:text-slate-200 space-y-1.5">
                  <p className="font-semibold text-slate-900 dark:text-white">
                    iPhone / iPad (Safari):
                  </p>
                  <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                    1. Tap <strong>Share</strong> in Safari toolbar → 2. Tap{' '}
                    <strong>Add to Home Screen</strong>.
                  </p>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="mt-5 w-full rounded-xl bg-slate-900 dark:bg-white py-2.5 text-sm font-semibold text-white dark:text-slate-900 hover:opacity-90 transition-opacity"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function OfflineIndicator() {
  const isOnline = useOnlineStatus();
  const [dismissed, setDismissed] = useState(false);

  if (isOnline || dismissed) return null;

  return (
    <div
      role="status"
      data-testid="ntk-offline-indicator"
      className="fixed top-14 md:top-16 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full border border-slate-600/40 bg-slate-800/95 dark:bg-slate-700/95 px-3.5 py-1.5 text-xs font-semibold text-white shadow-lg"
    >
      <WifiOff className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
      <span className="whitespace-nowrap">Offline Mode — Running 100% locally on this device</span>
      <button
        type="button"
        aria-label="Dismiss offline status"
        onClick={() => setDismissed(true)}
        className="ml-0.5 rounded-full p-0.5 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
