import type {
  NtkCustomAiButton,
  NtkRotationStrategy,
  NtkVisibilityMatrix,
  NtkVoiceConfigSnapshot,
  NtkWorkstationSettings,
} from '../types';

export const NTK_LOCAL_CONFIG_KEY = 'ntk_reorder_suite_local_config_v1';

interface StoredLocalSuiteSettings {
  sttStrategy?: NtkRotationStrategy;
  llmStrategy?: NtkRotationStrategy;
  visibility?: Partial<NtkVisibilityMatrix>;
  aiButtons?: NtkCustomAiButton[];
  workstation?: Partial<Omit<NtkWorkstationSettings, 'stemApiTokenMask'>>;
}

export interface LocalConfigPatch {
  sttStrategy?: NtkRotationStrategy;
  llmStrategy?: NtkRotationStrategy;
  visibility?: Partial<NtkVisibilityMatrix>;
  aiButtons?: NtkCustomAiButton[];
  workstation?: Partial<NtkWorkstationSettings>;
}

function getStorageSafe(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Ignore storage access errors in private contexts
  }
  return null;
}

/**
 * Pure immutable patcher for non-secret NTK Reorder Suite settings.
 * Never touches API keys or server-only tokens.
 */
export function applyLocalConfigPatch(
  base: NtkVoiceConfigSnapshot,
  patch: LocalConfigPatch
): NtkVoiceConfigSnapshot {
  const nextWorkstation: NtkWorkstationSettings = {
    ...base.workstation,
    ...(patch.workstation ?? {}),
    stemApiTokenMask: base.workstation.stemApiTokenMask,
  };
  return {
    ...base,
    sttStrategy: patch.sttStrategy ?? base.sttStrategy,
    llmStrategy: patch.llmStrategy ?? base.llmStrategy,
    visibility: {
      ...base.visibility,
      ...(patch.visibility ?? {}),
    },
    aiButtons: patch.aiButtons
      ? patch.aiButtons.map((b) => ({ ...b }))
      : base.aiButtons.map((b) => ({ ...b })),
    workstation: nextWorkstation,
  };
}

export function hasSavedLocalNtkConfig(): boolean {
  const storage = getStorageSafe();
  if (!storage) return false;
  try {
    return Boolean(storage.getItem(NTK_LOCAL_CONFIG_KEY));
  } catch {
    return false;
  }
}

export function loadLocalNtkConfig(fallback: NtkVoiceConfigSnapshot): NtkVoiceConfigSnapshot {
  const storage = getStorageSafe();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(NTK_LOCAL_CONFIG_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as StoredLocalSuiteSettings;
    return applyLocalConfigPatch(fallback, parsed);
  } catch {
    return fallback;
  }
}

export function saveLocalNtkConfig(config: NtkVoiceConfigSnapshot): void {
  const storage = getStorageSafe();
  if (!storage) return;
  try {
    // Store ONLY non-secret UI/workstation settings locally (never secrets or API keys)
    const { stemApiTokenMask: _omitMask, ...safeWorkstation } = config.workstation;
    const payload: StoredLocalSuiteSettings = {
      sttStrategy: config.sttStrategy,
      llmStrategy: config.llmStrategy,
      visibility: { ...config.visibility },
      aiButtons: config.aiButtons.map((b) => ({ ...b })),
      workstation: safeWorkstation,
    };
    storage.setItem(NTK_LOCAL_CONFIG_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota issues in restricted browsers
  }
}

export function clearLocalNtkConfig(): void {
  const storage = getStorageSafe();
  if (!storage) return;
  try {
    storage.removeItem(NTK_LOCAL_CONFIG_KEY);
  } catch {
    // Ignore storage removal errors
  }
}

/**
 * Combines live server metadata (keys summary, catalog, logs) with local non-secret settings
 * so offline edits survive while still keeping live server key pools accurate.
 */
export function mergeServerWithLocalConfig(
  serverSnap: NtkVoiceConfigSnapshot,
  hasLocalSaved: boolean,
  localSnap: NtkVoiceConfigSnapshot
): NtkVoiceConfigSnapshot {
  if (!hasLocalSaved) return serverSnap;
  return {
    ...serverSnap,
    sttStrategy: localSnap.sttStrategy,
    llmStrategy: localSnap.llmStrategy,
    visibility: { ...serverSnap.visibility, ...localSnap.visibility },
    aiButtons: localSnap.aiButtons.length > 0 ? localSnap.aiButtons : serverSnap.aiButtons,
    workstation: {
      ...serverSnap.workstation,
      ...localSnap.workstation,
      stemApiTokenMask: serverSnap.workstation.stemApiTokenMask,
    },
  };
}
