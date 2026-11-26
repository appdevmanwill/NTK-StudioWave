import { Download, FolderOpen, Layers, Mic, Radio, Sliders, SlidersHorizontal } from 'lucide-react';
import type { AppStep } from '../types/audio';
import {
  getVisibleSteps,
  isRecorderOnlyConfig,
  type WorkspaceConfig,
} from '../utils/workspaceConfig';

interface MobileNavBarProps {
  activeStep: AppStep;
  onSelectStep: (step: AppStep) => void;
  workspaceConfig: WorkspaceConfig;
  onOpenCustomizer: () => void;
  libraryCount: number;
}

const STEP_META: Record<AppStep, { label: string; icon: typeof Mic }> = {
  record: { label: 'Record', icon: Mic },
  edit: { label: 'Edit', icon: Sliders },
  export: { label: 'Save', icon: Download },
  library: { label: 'Files', icon: FolderOpen },
  batch: { label: 'Batch', icon: Layers },
  'ntk-suite': { label: 'NTK Suite', icon: Radio },
};

export function MobileNavBar({
  activeStep,
  onSelectStep,
  workspaceConfig,
  onOpenCustomizer,
  libraryCount,
}: MobileNavBarProps) {
  // Yield bottom dock to NTK Reorder Suite's native mobile recorder dock, or hide in pure Recorder-Only mode
  if (activeStep === 'ntk-suite' || isRecorderOnlyConfig(workspaceConfig)) {
    return null;
  }

  const visibleSteps = getVisibleSteps(workspaceConfig).slice(0, 4);
  const totalSlots = visibleSteps.length + 1; // +1 for Customize button

  return (
    <nav
      aria-label="Mobile app navigation"
      data-testid="mobile-bottom-nav"
      className="grid md:hidden fixed bottom-0 left-0 right-0 z-40 min-h-16 border-t border-slate-200/90 dark:border-slate-800/90 bg-white/95 dark:bg-[#0E131D]/95 backdrop-blur-md pb-[env(safe-area-inset-bottom)]"
      style={{
        gridTemplateColumns: `repeat(${totalSlots}, minmax(0, 1fr))`,
      }}
    >
      {visibleSteps.map((stepId) => {
        const meta = STEP_META[stepId];
        const Icon = meta.icon;
        const active = activeStep === stepId;
        return (
          <button
            key={stepId}
            type="button"
            data-testid={`mobile-tab-${stepId}`}
            onClick={() => onSelectStep(stepId)}
            className={`flex flex-col items-center justify-center min-h-[44px] gap-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${
              active
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <span className="relative flex items-center justify-center">
              <Icon className={`h-5 w-5 ${active ? 'stroke-[2.4]' : 'stroke-[1.9]'}`} />
              {stepId === 'library' && libraryCount > 0 && (
                <span className="absolute -top-1.5 -right-2.5 text-[10px] font-bold tabular-nums text-blue-600 dark:text-blue-400">
                  {libraryCount}
                </span>
              )}
            </span>
            <span className={`text-[11px] leading-none tracking-tight ${active ? 'font-bold' : 'font-medium'}`}>
              {meta.label}
            </span>
          </button>
        );
      })}

      <button
        type="button"
        data-testid="mobile-tab-customize"
        onClick={onOpenCustomizer}
        className="flex flex-col items-center justify-center min-h-[44px] gap-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
      >
        <SlidersHorizontal className="h-5 w-5 stroke-[1.9]" />
        <span className="text-[11px] leading-none font-medium tracking-tight">Customize</span>
      </button>
    </nav>
  );
}
