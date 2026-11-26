import type {
  NtkCustomAiButton,
  NtkPoolType,
  NtkRotationStrategy,
  NtkTranscriptSegment,
  NtkVisibilityMatrix,
  NtkVoiceConfigSnapshot,
  NtkWorkstationSettings,
} from '../types';

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const ntkVoiceApi = {
  getConfig(): Promise<NtkVoiceConfigSnapshot> {
    return apiJson<NtkVoiceConfigSnapshot>('/api/ntk-voice/config');
  },

  updateConfig(payload: {
    sttStrategy?: NtkRotationStrategy;
    llmStrategy?: NtkRotationStrategy;
    visibility?: Partial<NtkVisibilityMatrix>;
    aiButtons?: NtkCustomAiButton[];
    workstation?: Partial<NtkWorkstationSettings> & { stemApiToken?: string };
  }): Promise<NtkVoiceConfigSnapshot> {
    return apiJson<NtkVoiceConfigSnapshot>('/api/ntk-voice/config', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  addKey(payload: {
    pool: NtkPoolType;
    provider: string;
    label: string;
    apiKey: string;
    model: string;
    accountId?: string;
    baseUrl?: string;
  }): Promise<NtkVoiceConfigSnapshot> {
    return apiJson<NtkVoiceConfigSnapshot>('/api/ntk-voice/keys', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  updateKey(
    id: string,
    payload: {
      label?: string;
      model?: string;
      enabled?: boolean;
      apiKey?: string;
      accountId?: string;
      baseUrl?: string;
      clearCooldown?: boolean;
    }
  ): Promise<NtkVoiceConfigSnapshot> {
    return apiJson<NtkVoiceConfigSnapshot>(`/api/ntk-voice/keys/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  deleteKey(id: string): Promise<NtkVoiceConfigSnapshot> {
    return apiJson<NtkVoiceConfigSnapshot>(`/api/ntk-voice/keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  reorderKeys(pool: NtkPoolType, orderedIds: string[]): Promise<NtkVoiceConfigSnapshot> {
    return apiJson<NtkVoiceConfigSnapshot>('/api/ntk-voice/keys/reorder', {
      method: 'POST',
      body: JSON.stringify({ pool, orderedIds }),
    });
  },

  testKeys(keyId?: string): Promise<{
    results: Array<{
      id: string;
      label: string;
      provider: string;
      pool: NtkPoolType;
      ok: boolean;
      status: string;
      latencyMs: number;
      message: string;
    }>;
    stemStatus: { configured: boolean; ok: boolean; message: string };
    snapshot: NtkVoiceConfigSnapshot;
  }> {
    return apiJson('/api/ntk-voice/keys/test', {
      method: 'POST',
      body: JSON.stringify({ keyId }),
    });
  },

  transcribeChunks(payload: {
    chunks: Array<{
      chunkIndex: number;
      offsetSeconds: number;
      durationSeconds: number;
      audioBase64: string;
      mimeType: string;
    }>;
    language?: string;
  }): Promise<{
    text: string;
    segments: NtkTranscriptSegment[];
    providersUsed: string[];
    failovers: number;
    chunkSummaries: Array<{ chunkIndex: number; provider: string; keyLabel: string }>;
  }> {
    return apiJson('/api/ntk-voice/transcribe', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  runIntelligence(payload: {
    transcript: string;
    buttonId?: string;
    prompt?: string;
    targetLanguage?: string;
    buttonLabel?: string;
  }): Promise<{
    text: string;
    provider: string;
    keyId: string;
    keyLabel: string;
    model: string;
    failovers: number;
    buttonId: string;
    buttonLabel: string;
  }> {
    return apiJson('/api/ntk-voice/intelligence', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  separateStems(payload: {
    audioBase64: string;
    mimeType: string;
  }): Promise<{
    stems: { vocals?: string; drums?: string; bass?: string; other?: string };
    source: string;
  }> {
    return apiJson('/api/ntk-voice/stems', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  resetStats(): Promise<NtkVoiceConfigSnapshot> {
    return apiJson('/api/ntk-voice/reset-stats', { method: 'POST' });
  },

  resetDefaults(): Promise<NtkVoiceConfigSnapshot> {
    return apiJson('/api/ntk-voice/reset-defaults', { method: 'POST' });
  },
};
