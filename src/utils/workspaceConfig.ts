import type { AppStep } from '../types/audio';

export type WorkspacePresetId =
  | 'recorder-only'
  | 'novice-office'
  | 'ai-office'
  | 'full-pro'
  | 'custom';

export type EditorToolTabId =
  | 'cleanup'
  | 'sound'
  | 'repair'
  | 'tracks'
  | 'effects'
  | 'mastering'
  | 'mixer'
  | 'transcript';

export interface WorkspaceConfig {
  presetId: WorkspacePresetId;

  // Top-level screens (Record is always available as the home screen)
  showEditScreen: boolean;
  showExportScreen: boolean;
  showLibraryScreen: boolean;
  showBatchScreen: boolean;

  // Recorder screen visibility controls
  recorderShowTimer: boolean;
  recorderShowWaveform: boolean;
  recorderShowMicPicker: boolean;
  recorderShowOpenFile: boolean;
  recorderShowSampleButton: boolean;
  recorderShowOptionalSettings: boolean;
  recorderShowProCockpit: boolean;

  // Editor screen granular tool visibility
  editorShowEasyFixes: boolean;
  editorShowSoundPitch: boolean;
  editorShowAudioRepair: boolean;
  editorShowTracksAutomation: boolean;
  editorShowVoiceEffects: boolean;
  editorShowMastering: boolean;
  editorShowMusicMixer: boolean;
  editorShowTranscript: boolean;
  editorShowSpectrum: boolean;
  editorShowSnapshots: boolean;

  // Export & AI capabilities
  exportShowAudiogram: boolean;
  exportShowProOptions: boolean;
  enableCloudAiApi: boolean;
  showLocalSpeechOption: boolean;

  // Novice self-guidance
  showNoviceHints: boolean;
}

export const WORKSPACE_STORAGE_KEY = 'studiowave_workspace_config_v1';

export function getPresetConfig(
  presetId: Exclude<WorkspacePresetId, 'custom'>
): WorkspaceConfig {
  switch (presetId) {
    case 'recorder-only':
      return {
        presetId: 'recorder-only',
        showEditScreen: false,
        showExportScreen: false,
        showLibraryScreen: false,
        showBatchScreen: false,
        recorderShowTimer: true,
        recorderShowWaveform: true,
        recorderShowMicPicker: true,
        recorderShowOpenFile: false,
        recorderShowSampleButton: false,
        recorderShowOptionalSettings: false,
        recorderShowProCockpit: false,
        editorShowEasyFixes: true,
        editorShowSoundPitch: false,
        editorShowAudioRepair: false,
        editorShowTracksAutomation: false,
        editorShowVoiceEffects: false,
        editorShowMastering: false,
        editorShowMusicMixer: false,
        editorShowTranscript: false,
        editorShowSpectrum: false,
        editorShowSnapshots: false,
        exportShowAudiogram: false,
        exportShowProOptions: false,
        enableCloudAiApi: false,
        showLocalSpeechOption: false,
        showNoviceHints: true,
      };

    case 'novice-office':
      return {
        presetId: 'novice-office',
        showEditScreen: true,
        showExportScreen: true,
        showLibraryScreen: true,
        showBatchScreen: false,
        recorderShowTimer: true,
        recorderShowWaveform: true,
        recorderShowMicPicker: true,
        recorderShowOpenFile: true,
        recorderShowSampleButton: true,
        recorderShowOptionalSettings: true,
        recorderShowProCockpit: false,
        editorShowEasyFixes: true,
        editorShowSoundPitch: true,
        editorShowAudioRepair: false,
        editorShowTracksAutomation: false,
        editorShowVoiceEffects: false,
        editorShowMastering: false,
        editorShowMusicMixer: true,
        editorShowTranscript: true,
        editorShowSpectrum: false,
        editorShowSnapshots: false,
        exportShowAudiogram: true,
        exportShowProOptions: false,
        enableCloudAiApi: false,
        showLocalSpeechOption: false,
        showNoviceHints: true,
      };

    case 'ai-office':
      return {
        presetId: 'ai-office',
        showEditScreen: true,
        showExportScreen: true,
        showLibraryScreen: true,
        showBatchScreen: false,
        recorderShowTimer: true,
        recorderShowWaveform: true,
        recorderShowMicPicker: true,
        recorderShowOpenFile: true,
        recorderShowSampleButton: true,
        recorderShowOptionalSettings: true,
        recorderShowProCockpit: false,
        editorShowEasyFixes: true,
        editorShowSoundPitch: true,
        editorShowAudioRepair: true,
        editorShowTracksAutomation: false,
        editorShowVoiceEffects: false,
        editorShowMastering: false,
        editorShowMusicMixer: true,
        editorShowTranscript: true,
        editorShowSpectrum: false,
        editorShowSnapshots: false,
        exportShowAudiogram: true,
        exportShowProOptions: false,
        enableCloudAiApi: true,
        showLocalSpeechOption: true,
        showNoviceHints: true,
      };

    case 'full-pro':
      return {
        presetId: 'full-pro',
        showEditScreen: true,
        showExportScreen: true,
        showLibraryScreen: true,
        showBatchScreen: true,
        recorderShowTimer: true,
        recorderShowWaveform: true,
        recorderShowMicPicker: true,
        recorderShowOpenFile: true,
        recorderShowSampleButton: true,
        recorderShowOptionalSettings: true,
        recorderShowProCockpit: true,
        editorShowEasyFixes: true,
        editorShowSoundPitch: true,
        editorShowAudioRepair: true,
        editorShowTracksAutomation: true,
        editorShowVoiceEffects: true,
        editorShowMastering: true,
        editorShowMusicMixer: true,
        editorShowTranscript: true,
        editorShowSpectrum: true,
        editorShowSnapshots: true,
        exportShowAudiogram: true,
        exportShowProOptions: true,
        enableCloudAiApi: false,
        showLocalSpeechOption: false,
        showNoviceHints: false,
      };
  }
}

export function isRecorderOnlyConfig(config: WorkspaceConfig): boolean {
  return (
    !config.showEditScreen &&
    !config.showExportScreen &&
    !config.showLibraryScreen &&
    !config.showBatchScreen
  );
}

export function getVisibleSteps(config: WorkspaceConfig): AppStep[] {
  const steps: AppStep[] = ['record'];
  if (config.showEditScreen) steps.push('edit');
  if (config.showExportScreen) steps.push('export');
  if (config.showLibraryScreen) steps.push('library');
  if (config.showBatchScreen) steps.push('batch');
  return steps;
}

export function resolveSafeStep(currentStep: AppStep, config: WorkspaceConfig): AppStep {
  if (currentStep === 'ntk-suite') return 'ntk-suite';
  const visible = getVisibleSteps(config);
  if (visible.includes(currentStep)) return currentStep;
  return visible[0] ?? 'record';
}

export function getVisibleEditorTabs(config: WorkspaceConfig): EditorToolTabId[] {
  const tabs: EditorToolTabId[] = [];
  if (config.editorShowEasyFixes) tabs.push('cleanup');
  if (config.editorShowSoundPitch) tabs.push('sound');
  if (config.editorShowAudioRepair) tabs.push('repair');
  if (config.editorShowTracksAutomation) tabs.push('tracks');
  if (config.editorShowVoiceEffects) tabs.push('effects');
  if (config.editorShowMastering) tabs.push('mastering');
  if (config.editorShowMusicMixer) tabs.push('mixer');
  if (config.editorShowTranscript) tabs.push('transcript');
  // Never leave the editor with zero tabs if user unchecks every single tool
  if (tabs.length === 0) tabs.push('cleanup');
  return tabs;
}

export function resolveSafeEditorTab(
  currentTab: EditorToolTabId,
  config: WorkspaceConfig
): EditorToolTabId {
  const visible = getVisibleEditorTabs(config);
  if (visible.includes(currentTab)) return currentTab;
  return visible[0];
}

export function loadWorkspaceConfig(): WorkspaceConfig {
  const fallback = getPresetConfig('novice-office');
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<WorkspaceConfig>;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

export function saveWorkspaceConfig(config: WorkspaceConfig): void {
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage quota issues in restricted browsers
  }
}
