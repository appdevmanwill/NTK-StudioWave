import {
  Check,
  Cloud,
  HelpCircle,
  Mic,
  Monitor,
  Moon,
  RotateCcw,
  Sliders,
  Sparkles,
  Sun,
  Wrench,
  X,
} from 'lucide-react';
import type { ThemePreference } from '../types/audio';
import {
  getPresetConfig,
  type WorkspaceConfig,
  type WorkspacePresetId,
} from '../utils/workspaceConfig';

interface WorkspaceCustomizerDrawerProps {
  open: boolean;
  config: WorkspaceConfig;
  themePreference: ThemePreference;
  onChangeThemePreference: (next: ThemePreference) => void;
  onChange: (next: WorkspaceConfig) => void;
  onClose: () => void;
}

interface ToggleRowProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onToggle: (next: boolean) => void;
}

function ToggleRow({ id, label, description, checked, onToggle }: ToggleRowProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-testid={`customizer-toggle-${id}`}
      onClick={() => onToggle(!checked)}
      className="w-full min-h-[54px] flex items-center justify-between gap-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-[#131822] px-3.5 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-900/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-900 dark:text-white leading-snug">
          {label}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          {description}
        </div>
      </div>
      <span
        aria-hidden="true"
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          checked ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-700'
        }`}
      >
        <span
          className={`inline-block h-4.5 w-4.5 rounded-full bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-5.5' : 'translate-x-1'
          }`}
        />
      </span>
    </button>
  );
}

const PRESETS: Array<{
  id: Exclude<WorkspacePresetId, 'custom'>;
  title: string;
  subtitle: string;
  icon: typeof Mic;
}> = [
  {
    id: 'recorder-only',
    title: 'Recorder Only',
    subtitle: 'Just the Record button, timer & mic — zero extra screens.',
    icon: Mic,
  },
  {
    id: 'novice-office',
    title: 'Novice Office',
    subtitle: 'Simple Record, Easy Fixes, Save & Shared Files (no AI needed).',
    icon: Sparkles,
  },
  {
    id: 'ai-office',
    title: 'Office + Optional AI',
    subtitle: 'Simple studio + optional Cloud AI Transcription & Smart Notes.',
    icon: Cloud,
  },
  {
    id: 'full-pro',
    title: 'Full Pro Studio',
    subtitle: 'All 8 audio tools, Spectrogram Eraser, Multi-Track & Batch.',
    icon: Wrench,
  },
];

export function WorkspaceCustomizerDrawer({
  open,
  config,
  themePreference,
  onChangeThemePreference,
  onChange,
  onClose,
}: WorkspaceCustomizerDrawerProps) {
  if (!open) return null;

  const updateField = <K extends keyof WorkspaceConfig>(key: K, value: WorkspaceConfig[K]) => {
    onChange({
      ...config,
      presetId: 'custom',
      [key]: value,
    });
  };

  const applyPreset = (presetId: Exclude<WorkspacePresetId, 'custom'>) => {
    onChange(getPresetConfig(presetId));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-stretch md:justify-end bg-slate-950/50 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label="Customize Workspace Screen and Features"
      data-testid="workspace-customizer-drawer"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative flex flex-col w-full md:max-w-lg max-h-[90vh] md:max-h-full rounded-t-3xl md:rounded-none md:rounded-l-2xl bg-[#F8FAFC] dark:bg-[#0D111A] border-t md:border-t-0 md:border-l border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden">
        {/* Mobile grab handle */}
        <div className="md:hidden pt-3 pb-1 flex justify-center">
          <div className="h-1.5 w-11 rounded-full bg-slate-300 dark:bg-slate-700" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white">
              <Sliders className="h-4.5 w-4.5" />
            </span>
            <div className="min-w-0">
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white truncate">
                Customize Your Screen
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Show only the tools you want — hide anything else anytime.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close customize screen"
            data-testid="close-customizer-btn"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
          {/* Quick Presets */}
          <section className="space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                0. Appearance (Theme)
              </h3>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">
                Follows device by default
              </span>
            </div>
            <div
              role="group"
              aria-label="Theme preference"
              className="grid grid-cols-3 gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-1.5"
            >
              {(
                [
                  { id: 'system', label: 'System', icon: Monitor },
                  { id: 'light', label: 'Light', icon: Sun },
                  { id: 'dark', label: 'Dark', icon: Moon },
                ] as const
              ).map((opt) => {
                const Icon = opt.icon;
                const active = themePreference === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    data-testid={`theme-pref-${opt.id}`}
                    aria-pressed={active}
                    onClick={() => onChangeThemePreference(opt.id)}
                    className={`min-h-[40px] flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                      active
                        ? 'bg-blue-600 text-white shadow-xs'
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                1. Pick a Quick Layout Preset
              </h3>
              <button
                type="button"
                onClick={() => applyPreset('novice-office')}
                className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline min-h-[36px] px-1"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Reset Default</span>
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {PRESETS.map((preset) => {
                const Icon = preset.icon;
                const active = config.presetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    data-testid={`preset-btn-${preset.id}`}
                    onClick={() => applyPreset(preset.id)}
                    className={`flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors min-h-[72px] ${
                      active
                        ? 'border-blue-600 bg-blue-50/90 dark:bg-blue-500/15'
                        : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] hover:bg-slate-50 dark:hover:bg-slate-900'
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                        active
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-sm font-bold text-slate-900 dark:text-white">
                          {preset.title}
                        </span>
                        {active && <Check className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />}
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 leading-snug">
                        {preset.subtitle}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Top Navigation Screens */}
          <section className="space-y-2.5">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              2. Screens Shown in Menu
            </h3>
            <div className="space-y-2">
              <ToggleRow
                id="showEditScreen"
                label="Edit Studio Screen"
                description="Turn off if workers only need to record and download audio."
                checked={config.showEditScreen}
                onToggle={(v) => updateField('showEditScreen', v)}
              />
              <ToggleRow
                id="showExportScreen"
                label="Save & Export Screen"
                description="Choose MP3, WAV, FLAC, or Audiogram video exports."
                checked={config.showExportScreen}
                onToggle={(v) => updateField('showExportScreen', v)}
              />
              <ToggleRow
                id="showLibraryScreen"
                label="Shared Office Files"
                description="Open shared folder for anyone on this computer — no login or locks."
                checked={config.showLibraryScreen}
                onToggle={(v) => updateField('showLibraryScreen', v)}
              />
              <ToggleRow
                id="showBatchScreen"
                label="Batch Studio"
                description="Process multiple audio files at once."
                checked={config.showBatchScreen}
                onToggle={(v) => updateField('showBatchScreen', v)}
              />
            </div>
          </section>

          {/* Recorder Controls */}
          <section className="space-y-2.5">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              3. Recorder Screen Elements
            </h3>
            <div className="space-y-2">
              <ToggleRow
                id="recorderShowTimer"
                label="Record Time Clock"
                description="Show large elapsed recording timer (00:00.0)."
                checked={config.recorderShowTimer}
                onToggle={(v) => updateField('recorderShowTimer', v)}
              />
              <ToggleRow
                id="recorderShowWaveform"
                label="Live Sound Wave Display"
                description="Visual bar showing your voice moving as you speak."
                checked={config.recorderShowWaveform}
                onToggle={(v) => updateField('recorderShowWaveform', v)}
              />
              <ToggleRow
                id="recorderShowMicPicker"
                label="Microphone Picker"
                description="Let users pick which plugged-in mic to use."
                checked={config.recorderShowMicPicker}
                onToggle={(v) => updateField('recorderShowMicPicker', v)}
              />
              <ToggleRow
                id="recorderShowOpenFile"
                label="Open Audio / Video File Box"
                description="Show the drag-and-drop box to open files from PC or phone."
                checked={config.recorderShowOpenFile}
                onToggle={(v) => updateField('recorderShowOpenFile', v)}
              />
              <ToggleRow
                id="recorderShowSampleButton"
                label="15-Second Practice Sample Button"
                description="Lets new office workers practice editing without recording first."
                checked={config.recorderShowSampleButton}
                onToggle={(v) => updateField('recorderShowSampleButton', v)}
              />
              <ToggleRow
                id="recorderShowOptionalSettings"
                label="Optional Recording Settings"
                description="3-2-1 countdown, pause on silence, and live mic volume slider."
                checked={config.recorderShowOptionalSettings}
                onToggle={(v) => updateField('recorderShowOptionalSettings', v)}
              />
              <ToggleRow
                id="recorderShowProCockpit"
                label="Pro Broadcast Recorder Controls"
                description="Teleprompter, Computer Audio capture, Live EQ, and Room Check."
                checked={config.recorderShowProCockpit}
                onToggle={(v) => updateField('recorderShowProCockpit', v)}
              />
            </div>
          </section>

          {/* Editor Tools */}
          {config.showEditScreen && (
            <section className="space-y-2.5">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                4. Editor Tools (Show or Hide Each Tab)
              </h3>
              <div className="space-y-2">
                <ToggleRow
                  id="editorShowEasyFixes"
                  label="Easy Fixes / Smart Cleanup"
                  description="1-click volume leveling, noise & echo cleanup, pause trimming."
                  checked={config.editorShowEasyFixes}
                  onToggle={(v) => updateField('editorShowEasyFixes', v)}
                />
                <ToggleRow
                  id="editorShowSoundPitch"
                  label="Sounds, Volume & Pitch"
                  description="Steady voice normalizer, voice/instrument balance, part pitch & speed."
                  checked={config.editorShowSoundPitch}
                  onToggle={(v) => updateField('editorShowSoundPitch', v)}
                />
                <ToggleRow
                  id="editorShowTranscript"
                  label="Transcript, Captions & AI Notes"
                  description="Cloud AI API transcription, meeting summaries, and .SRT/.TXT export."
                  checked={config.editorShowTranscript}
                  onToggle={(v) => updateField('editorShowTranscript', v)}
                />
                <ToggleRow
                  id="editorShowMusicMixer"
                  label="Add Music / 3-Lane Auto-Duck Mixer"
                  description="Add background music that automatically lowers when you speak."
                  checked={config.editorShowMusicMixer}
                  onToggle={(v) => updateField('editorShowMusicMixer', v)}
                />
                <ToggleRow
                  id="editorShowAudioRepair"
                  label="Audio Repair & Spectrogram Eraser"
                  description="Draw a box to erase coughs/beeps, fix clicks, and remove echo."
                  checked={config.editorShowAudioRepair}
                  onToggle={(v) => updateField('editorShowAudioRepair', v)}
                />
                <ToggleRow
                  id="editorShowTracksAutomation"
                  label="Multi-Track & Volume Automation"
                  description="Layer multiple recordings and draw smooth fade/pan lines."
                  checked={config.editorShowTracksAutomation}
                  onToggle={(v) => updateField('editorShowTracksAutomation', v)}
                />
                <ToggleRow
                  id="editorShowVoiceEffects"
                  label="Studio Voice Effects & Auto-Tune"
                  description="Noise gate, spectral denoise, pitch correction, and compressor."
                  checked={config.editorShowVoiceEffects}
                  onToggle={(v) => updateField('editorShowVoiceEffects', v)}
                />
                <ToggleRow
                  id="editorShowMastering"
                  label="Mastering Assistant"
                  description="1-click broadcast/podcast loudness mastering and limiter."
                  checked={config.editorShowMastering}
                  onToggle={(v) => updateField('editorShowMastering', v)}
                />
                <ToggleRow
                  id="editorShowSpectrum"
                  label="Live Frequency Visualizer"
                  description="Real-time frequency bars above the editor tools."
                  checked={config.editorShowSpectrum}
                  onToggle={(v) => updateField('editorShowSpectrum', v)}
                />
                <ToggleRow
                  id="editorShowSnapshots"
                  label="Version Snapshots Bar"
                  description="Save and compare multiple edit checkpoints."
                  checked={config.editorShowSnapshots}
                  onToggle={(v) => updateField('editorShowSnapshots', v)}
                />
              </div>
            </section>
          )}

          {/* AI API, Export & Novice Guidance */}
          <section className="space-y-2.5">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              5. AI API, Export &amp; Novice Guidance
            </h3>
            <div className="space-y-2">
              <ToggleRow
                id="enableCloudAiApi"
                label="Cloud AI API (Optional — Transcription &amp; Smart Notes)"
                description="Off by default. Turn on only if you configure an optional server API key for cloud notes."
                checked={config.enableCloudAiApi}
                onToggle={(v) => updateField('enableCloudAiApi', v)}
              />
              <ToggleRow
                id="showLocalSpeechOption"
                label="Show Local Browser Speech Option"
                description="Keep an optional offline/browser speech-to-text button alongside the Cloud AI API."
                checked={config.showLocalSpeechOption}
                onToggle={(v) => updateField('showLocalSpeechOption', v)}
              />
              <ToggleRow
                id="exportShowAudiogram"
                label="Shareable Audiogram Video Card"
                description="Show moving wave video creator on the Save screen."
                checked={config.exportShowAudiogram}
                onToggle={(v) => updateField('exportShowAudiogram', v)}
              />
              <ToggleRow
                id="exportShowProOptions"
                label="Pro Export Controls (Custom kbps, FLAC, ID3)"
                description="Show custom bitrate sliders, exact MB target size, and album artwork."
                checked={config.exportShowProOptions}
                onToggle={(v) => updateField('exportShowProOptions', v)}
              />
              <ToggleRow
                id="showNoviceHints"
                label="Show Self-Guided Novice Hints"
                description="Displays clear 1-line instructions so new workers know what to click without training."
                checked={config.showNoviceHints}
                onToggle={(v) => updateField('showNoviceHints', v)}
              />
            </div>
          </section>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-3.5 flex items-start gap-2.5 text-xs text-slate-600 dark:text-slate-400">
            <HelpCircle className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              Shared Office Mode is always open — no personal accounts, passwords, or private locks.
              Any worker can adjust these screen toggles anytime.
            </p>
          </div>
        </div>

        {/* Sticky Footer Action */}
        <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="w-full h-12 rounded-xl bg-blue-600 text-sm font-bold text-white hover:bg-blue-700 transition-colors"
          >
            Done — Apply to Screen
          </button>
        </div>
      </div>
    </div>
  );
}
