import {
  AudioWaveform,
  Cpu,
  Download,
  FolderOpen,
  Layers,
  Mic,
  Monitor,
  Moon,
  Radio,
  Sliders,
  SlidersHorizontal,
  Sun,
} from 'lucide-react';
import { PWAInstallButton } from '../ntk-voice/components/PWAInstallBanner';
import type { AppStep, ThemeMode, ThemePreference, UserMode } from '../types/audio';
import {
  getVisibleSteps,
  isRecorderOnlyConfig,
  type WorkspaceConfig,
} from '../utils/workspaceConfig';

interface HeaderProps {
  activeStep: AppStep;
  onSelectStep: (step: AppStep) => void;
  userMode: UserMode;
  onToggleUserMode: (mode: UserMode) => void;
  workspaceConfig: WorkspaceConfig;
  onOpenCustomizer: () => void;
  ecoMode: boolean;
  onToggleEcoMode: () => void;
  estimatedRamMb: number;
  theme: ThemeMode;
  themePreference: ThemePreference;
  onChangeThemePreference: (next: ThemePreference) => void;
  hasAudioLoaded: boolean;
  libraryCount: number;
  isRecording: boolean;
}

const MOBILE_PAGE_TITLES: Record<AppStep, string> = {
  record: 'NTK StudioWave',
  edit: 'Edit Audio',
  export: 'Save Audio',
  library: 'Shared Files',
  batch: 'Batch Studio',
  'ntk-suite': 'NTK Reorder Suite',
};

export function Header({
  activeStep,
  onSelectStep,
  userMode,
  onToggleUserMode,
  workspaceConfig,
  onOpenCustomizer,
  ecoMode,
  onToggleEcoMode,
  estimatedRamMb,
  theme,
  themePreference,
  onChangeThemePreference,
  hasAudioLoaded,
  libraryCount,
  isRecording,
}: HeaderProps) {
  const nextThemePref: ThemePreference =
    themePreference === 'system' ? 'light' : themePreference === 'light' ? 'dark' : 'system';
  const themeLabel =
    themePreference === 'system'
      ? `Theme: System (${theme === 'dark' ? 'Dark' : 'Light'}) — switch to Light`
      : themePreference === 'light'
      ? 'Theme: Light — switch to Dark'
      : 'Theme: Dark — switch to System';
  const isPro = userMode === 'pro';
  const visibleSteps = getVisibleSteps(workspaceConfig);
  const recorderOnly = isRecorderOnlyConfig(workspaceConfig);

  const allPrimarySteps: Array<{
    id: AppStep;
    simpleLabel: string;
    proLabel: string;
    icon: typeof Mic;
  }> = [
    { id: 'record', simpleLabel: 'Record', proLabel: 'Record / Open', icon: Mic },
    { id: 'edit', simpleLabel: 'Edit', proLabel: 'Clean & Edit', icon: Sliders },
    { id: 'export', simpleLabel: 'Save', proLabel: 'Save & Export', icon: Download },
  ];
  const primarySteps = allPrimarySteps.filter((s) => visibleSteps.includes(s.id));

  const showLibrary = visibleSteps.includes('library');
  const showBatch = visibleSteps.includes('batch');

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/90 dark:border-slate-800/90 bg-white/95 dark:bg-[#0E131D]/95 backdrop-blur-md pt-[env(safe-area-inset-top)]">
      {/* Compact Native Mobile App Bar (52px height — respects 15% sticky cap with bottom nav) */}
      <div className="flex md:hidden items-center justify-between gap-2 px-3 h-13">
        <button
          type="button"
          onClick={() => onSelectStep('record')}
          className="flex items-center gap-2 min-h-[44px] pr-2 text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 min-w-0"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white">
            <AudioWaveform className="h-4.5 w-4.5" />
          </span>
          <span className="font-display text-base font-bold tracking-tight text-slate-900 dark:text-white truncate">
            {recorderOnly ? 'NTK StudioWave' : MOBILE_PAGE_TITLES[activeStep]}
          </span>
        </button>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            data-testid="mobile-ntk-suite-launcher"
            onClick={() => onSelectStep(activeStep === 'ntk-suite' ? 'record' : 'ntk-suite')}
            className={`inline-flex items-center gap-1 min-h-[40px] rounded-xl border px-2.5 text-xs font-semibold whitespace-nowrap transition-colors ${
              activeStep === 'ntk-suite'
                ? 'border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100'
                : 'border-rose-200 dark:border-rose-800/70 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300'
            }`}
          >
            <Radio className="h-3.5 w-3.5 shrink-0" />
            <span>{activeStep === 'ntk-suite' ? 'Host App' : 'NTK Suite'}</span>
          </button>

          {activeStep !== 'ntk-suite' && (
            <button
              type="button"
              data-testid="mobile-header-customizer-btn"
              onClick={onOpenCustomizer}
              className="inline-flex items-center gap-1.5 min-h-[40px] rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-2.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              <SlidersHorizontal className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
              <span>Customize</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => onChangeThemePreference(nextThemePref)}
            aria-label={themeLabel}
            title={themeLabel}
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300"
          >
            {themePreference === 'system' ? (
              <Monitor className="h-4 w-4" />
            ) : themePreference === 'light' ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* Desktop Top Bar */}
      <div className="hidden md:flex mx-auto max-w-[1440px] items-center justify-between gap-6 px-6 h-14">
        {/* Zone 1: Clean Brand Wordmark */}
        <button
          type="button"
          onClick={() => onSelectStep('record')}
          className="flex items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-md shrink-0 whitespace-nowrap"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white">
            <AudioWaveform className="h-4.5 w-4.5" />
          </span>
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white">
            NTK StudioWave
          </span>
        </button>

        {/* Zone 2: Dynamic Workflow Navigation (shows ONLY screens enabled in WorkspaceConfig) */}
        {!recorderOnly ? (
          <nav aria-label="Studio workflow" className="flex items-center gap-1.5">
            {primarySteps.map((step, idx) => {
              const Icon = step.icon;
              const active = activeStep === step.id;
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => onSelectStep(step.id)}
                  className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                    active
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>
                    {primarySteps.length > 1 ? `${idx + 1}. ` : ''}
                    {isPro ? step.proLabel : step.simpleLabel}
                  </span>
                </button>
              );
            })}

            {(showLibrary || showBatch) && (
              <span className="mx-1.5 h-4 w-px bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
            )}

            {showLibrary && (
              <button
                type="button"
                onClick={() => onSelectStep('library')}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  activeStep === 'library'
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                <span>Shared Files</span>
                {libraryCount > 0 && (
                  <span className="ml-0.5 text-xs tabular-nums opacity-75">({libraryCount})</span>
                )}
              </button>
            )}

            {showBatch && (
              <button
                type="button"
                onClick={() => onSelectStep('batch')}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  activeStep === 'batch'
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Layers className="h-3.5 w-3.5" />
                <span>Batch Studio</span>
              </button>
            )}

            <span className="mx-1.5 h-4 w-px bg-slate-200 dark:bg-slate-800" aria-hidden="true" />

            <button
              type="button"
              data-testid="nav-ntk-reorder-suite-btn"
              onClick={() => onSelectStep('ntk-suite')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                activeStep === 'ntk-suite'
                  ? 'bg-rose-600 text-white shadow-xs'
                  : 'border border-rose-200/80 dark:border-rose-800/60 bg-rose-50/70 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/40'
              }`}
            >
              <Radio className="h-3.5 w-3.5" />
              <span>NTK Reorder Suite</span>
            </button>
          </nav>
        ) : (
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Recorder Only Mode
            </span>
            <button
              type="button"
              data-testid="nav-ntk-reorder-suite-btn"
              onClick={() => onSelectStep(activeStep === 'ntk-suite' ? 'record' : 'ntk-suite')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 px-2.5 py-1 text-xs font-semibold text-rose-700 dark:text-rose-300"
            >
              <Radio className="h-3.5 w-3.5" />
              <span>{activeStep === 'ntk-suite' ? 'Back to Recorder' : 'NTK Reorder Suite'}</span>
            </button>
          </div>
        )}

        {/* Zone 3: Customize Screen + Simple/Pro Quick Switch + Theme */}
        <div className="flex items-center gap-2 shrink-0">
          {isPro && !recorderOnly && (
            <button
              type="button"
              data-testid="eco-mode-toggle"
              aria-pressed={ecoMode}
              title="Lite Mode optimizes NTK StudioWave for 1GB RAM and older PCs."
              onClick={onToggleEcoMode}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                ecoMode
                  ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                  : 'border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <Cpu className="h-3.5 w-3.5" />
              <span>{ecoMode ? 'Lite: On' : 'Lite Mode'}</span>
            </button>
          )}

          <PWAInstallButton compact />

          <button
            type="button"
            data-testid="open-customizer-btn"
            onClick={onOpenCustomizer}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
            <span>Customize</span>
          </button>

          {!recorderOnly && (
            <div
              role="group"
              aria-label="Workspace complexity mode"
              className="flex items-center rounded-lg border border-slate-200 dark:border-slate-700/80 bg-slate-100 dark:bg-slate-900 p-0.5"
            >
              <button
                type="button"
                data-testid="mode-simple-btn"
                onClick={() => onToggleUserMode('simple')}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                  userMode === 'simple'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                Simple
              </button>
              <button
                type="button"
                data-testid="mode-pro-btn"
                onClick={() => onToggleUserMode('pro')}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                  userMode === 'pro'
                    ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-xs'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                Pro
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => onChangeThemePreference(nextThemePref)}
            aria-label={themeLabel}
            title={themeLabel}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            {themePreference === 'system' ? (
              <Monitor className="h-4 w-4" />
            ) : themePreference === 'light' ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* Subtle studio status strip shown ONLY in Pro Mode on desktop */}
      {isPro && !recorderOnly && (
        <div className="hidden md:flex mx-auto max-w-[1440px] items-center justify-between border-t border-slate-100 dark:border-slate-800/60 px-6 py-1.5 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex items-center gap-2">
            <span>Shared Office Studio</span>
            {hasAudioLoaded && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums text-[11px] text-emerald-600 dark:text-emerald-400">
                  ~{estimatedRamMb.toFixed(1)} MB audio RAM{ecoMode ? ' (Lite Mode)' : ''}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3 text-slate-400 dark:text-slate-500">
            {isRecording ? (
              <span className="text-rose-500 font-medium">Recording active</span>
            ) : (
              <span>Shortcuts: Space Play · R Record · M Bookmark · Ctrl+Z Undo</span>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
