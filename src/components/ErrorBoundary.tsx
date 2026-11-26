import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

/**
 * Catches unexpected UI errors so office workers never hit a blank screen,
 * keeping saved IndexedDB audio recordings untouched while offering safe recovery.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    errorMessage: '',
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || 'Unexpected application error.',
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('NTK StudioWave UI error caught by ErrorBoundary:', error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleResetLayoutAndReload = () => {
    try {
      localStorage.removeItem('studiowave_workspace_config_v1');
      localStorage.removeItem('ntk_reorder_suite_local_config_v1');
    } catch {
      // Ignore storage access errors
    }
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F7F8FA] dark:bg-[#0B0E14] text-slate-900 dark:text-slate-100 p-6">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-6 shadow-xl space-y-4">
          <div className="space-y-1">
            <h1 className="font-display text-lg font-bold text-slate-900 dark:text-white">
              Something went wrong on screen
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              Your saved recordings on this device are safe in local storage. Reload to continue.
            </p>
          </div>
          {this.state.errorMessage && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70 px-3 py-2 text-xs font-mono text-slate-600 dark:text-slate-300 break-words">
              {this.state.errorMessage}
            </div>
          )}
          <div className="flex flex-wrap gap-2.5 pt-1">
            <button
              type="button"
              onClick={this.handleReload}
              className="flex-1 min-h-[42px] rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
            >
              Reload Studio
            </button>
            <button
              type="button"
              onClick={this.handleResetLayoutAndReload}
              className="flex-1 min-h-[42px] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              Reset Layout &amp; Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
