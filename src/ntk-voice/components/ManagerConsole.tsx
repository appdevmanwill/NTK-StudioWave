import {
  Activity,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Download,
  Eye,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldAlert,
  Sliders,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  NtkCustomAiButton,
  NtkPoolType,
  NtkPublicKey,
  NtkRotationStrategy,
  NtkVisibilityMatrix,
  NtkVoiceConfigSnapshot,
  NtkWorkstationSettings,
} from '../types';
import {
  applyLocalConfigPatch,
  clearLocalNtkConfig,
  saveLocalNtkConfig,
} from '../services/ntkLocalConfig';
import { ntkVoiceApi } from '../services/ntkVoiceApi';

interface ManagerConsoleProps {
  config: NtkVoiceConfigSnapshot;
  onConfigUpdated: (next: NtkVoiceConfigSnapshot) => void;
  onExportAllZip: () => Promise<void>;
  onMasterResetStorage: () => Promise<void>;
  onClose: () => void;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
}

const VISIBILITY_ITEMS: Array<{
  key: keyof NtkVisibilityMatrix;
  label: string;
  desc: string;
}> = [
  {
    key: 'aiFeaturesEnabled',
    label: 'Optional AI Tools (OFF by default — Not Compulsory)',
    desc: 'Turn on only if you want cloud transcription, summaries, or AI notes. All recording, playback, Live EQ, trimming, flags, and MP3/WAV export work 100% without AI or API keys.',
  },
  {
    key: 'showAdvancedToggle',
    label: 'Show "Advanced Tools" Switch',
    desc: 'Let workers expand the live EQ console, waveform trimmer, and optional stem mixer.',
  },
  {
    key: 'meetingAudioCapture',
    label: 'Online Meeting Audio Capture (Desktop Chrome/Edge)',
    desc: 'Show the optional "Record Online Meeting (Call Audio + My Mic)" toggle on supported PCs.',
  },
  {
    key: 'liveEqConsole',
    label: 'Live 7-Band Sound Engineering Console',
    desc: 'Allow access to 7-band EQ, presets, noise gate, compressor, limiter, and live monitor.',
  },
  {
    key: 'aiStemMixer',
    label: '4-Track Sound & Stem Mixer (Offline Rule-Based + Optional Cloud)',
    desc: 'Show Vocals / Drums / Bass / Other Instruments post-recording mixer inside Advanced Tools.',
  },
  {
    key: 'waveformTrimmer',
    label: 'Visual Waveform Trimmer & Voice-Over Layer',
    desc: 'Show non-destructive trim, silence cutter, and 2-track voice-over layering.',
  },
  {
    key: 'momentFlags',
    label: 'Live Moment Flags & Timestamp Notes',
    desc: 'Let users drop clickable flags during recording and playback.',
  },
  {
    key: 'multiFormatExport',
    label: 'Multi-Format Export (MP3 / WAV / WebM)',
    desc: 'Show WAV and WebM download buttons alongside standard MP3.',
  },
  {
    key: 'defaultNoisePolish',
    label: 'Automatic Novice Noise Reduction & Voice Leveling',
    desc: 'Keep subtle noise reduction & voice leveling ON automatically for untrained users.',
  },
  {
    key: 'optionalProfiles',
    label: 'Enable Optional Profiles (OFF by default)',
    desc: 'Adds a simple optional profile tag for personal standalone use without locking coworkers out.',
  },
  {
    key: 'localBrowserWhisperFallback',
    label: 'Optional Local Browser Speech Fallback (OFF by default)',
    desc: 'Adds a local browser dictation fallback button; kept OFF by default for low-RAM PCs.',
  },
];

export function ManagerConsole({
  config,
  onConfigUpdated,
  onExportAllZip,
  onMasterResetStorage,
  onClose,
  onNotify,
}: ManagerConsoleProps) {
  const [tab, setTab] = useState<'visibility' | 'workstation' | 'keys' | 'prompts'>('visibility');
  const [testingKeys, setTestingKeys] = useState(false);
  const [saving, setSaving] = useState(false);

  // Add key form state
  const [newPool, setNewPool] = useState<NtkPoolType>('stt');
  const [newProvider, setNewProvider] = useState('groq');
  const [newLabel, setNewLabel] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [newModel, setNewModel] = useState('whisper-large-v3-turbo');
  const [newAccountId, setNewAccountId] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('');

  // Editable drafts for prompts & workstation
  const [buttonsDraft, setButtonsDraft] = useState<NtkCustomAiButton[]>(config.aiButtons);
  const [wsDraft, setWsDraft] = useState<NtkWorkstationSettings>(config.workstation);
  const [stemTokenInput, setStemTokenInput] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    setButtonsDraft(config.aiButtons);
    setWsDraft(config.workstation);
  }, [config.aiButtons, config.workstation]);

  const catalogForPool = config.catalog[newPool];
  const activeCatalogEntry =
    catalogForPool.find((c) => c.id === newProvider) || catalogForPool[0];

  const handleSelectPool = (pool: NtkPoolType) => {
    setNewPool(pool);
    const first = config.catalog[pool][0];
    setNewProvider(first.id);
    setNewModel(first.defaultModel);
  };

  const handleSelectProvider = (providerId: string) => {
    setNewProvider(providerId);
    const entry = config.catalog[newPool].find((p) => p.id === providerId);
    if (entry) setNewModel(entry.defaultModel);
  };

  const handleAddKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newApiKey.trim()) {
      onNotify('API keys are optional — paste a key only when you want to add one to the pool.', 'info');
      return;
    }
    setSaving(true);
    try {
      const updated = await ntkVoiceApi.addKey({
        pool: newPool,
        provider: newProvider,
        label: newLabel,
        apiKey: newApiKey,
        model: newModel,
        accountId: newAccountId || undefined,
        baseUrl: newBaseUrl || undefined,
      });
      onConfigUpdated(updated);
      setNewLabel('');
      setNewApiKey('');
      setNewBaseUrl('');
      onNotify('Added key securely to server-side rotation pool.', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/fetch|network|failed to fetch|404/i.test(msg)) {
        onNotify(
          'Optional server-side key management needs the optional backend running. All local recording, EQ, and export tools work offline.',
          'warning'
        );
      } else {
        onNotify(msg || 'Could not add API key.', 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleMoveKey = async (pool: NtkPoolType, keyId: string, dir: -1 | 1) => {
    const poolKeys = config.keys
      .filter((k) => k.pool === pool)
      .sort((a, b) => a.priority - b.priority);
    const idx = poolKeys.findIndex((k) => k.id === keyId);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= poolKeys.length) return;
    const reordered = [...poolKeys];
    [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
    try {
      const next = await ntkVoiceApi.reorderKeys(
        pool,
        reordered.map((k) => k.id)
      );
      onConfigUpdated(next);
    } catch {
      onNotify(
        'Could not reach the optional API key backend. Reorder keys once connected to the server.',
        'warning'
      );
    }
  };

  const handleToggleKey = async (key: NtkPublicKey) => {
    try {
      const next = await ntkVoiceApi.updateKey(key.id, { enabled: !key.enabled });
      onConfigUpdated(next);
    } catch {
      onNotify(
        'Could not reach the optional API key backend while offline.',
        'warning'
      );
    }
  };

  const handleDeleteKey = async (key: NtkPublicKey) => {
    try {
      const next = await ntkVoiceApi.deleteKey(key.id);
      onConfigUpdated(next);
      onNotify(key.fromEnv ? 'Disabled server-env key.' : 'Removed key from pool.', 'info');
    } catch {
      onNotify(
        'Could not reach the optional API key backend while offline.',
        'warning'
      );
    }
  };

  const handleTestAllKeys = async () => {
    setTestingKeys(true);
    try {
      const res = await ntkVoiceApi.testKeys();
      onConfigUpdated(res.snapshot);
      const okCount = res.results.filter((r) => r.ok).length;
      onNotify(
        `Tested ${res.results.length} active key(s): ${okCount} Ready.${
          res.stemStatus.configured ? ` Stem Space: ${res.stemStatus.message}.` : ''
        }`,
        okCount > 0 ? 'success' : 'warning'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      onNotify(
        /fetch|network|404/i.test(msg)
          ? 'Key testing needs the optional online backend. All offline recording and DSP editing work without keys.'
          : msg || 'Key health test failed.',
        'warning'
      );
    } finally {
      setTestingKeys(false);
    }
  };

  const isBrowserOffline = () =>
    typeof navigator !== 'undefined' && navigator.onLine === false;

  const handleStrategyChange = async (pool: NtkPoolType, strategy: NtkRotationStrategy) => {
    const patch = pool === 'stt' ? { sttStrategy: strategy } : { llmStrategy: strategy };
    const localNext = applyLocalConfigPatch(config, patch);
    saveLocalNtkConfig(localNext);
    onConfigUpdated(localNext);
    if (isBrowserOffline()) {
      onNotify('Saved locally on this device (offline mode).', 'info');
      return;
    }
    try {
      const next = await ntkVoiceApi.updateConfig(patch);
      saveLocalNtkConfig(next);
      onConfigUpdated(next);
      onNotify(
        `${pool === 'stt' ? 'Transcription' : 'Text AI'} rotation set to ${
          strategy === 'round_robin' ? 'Round-Robin Load Balancing' : 'Priority Failover'
        }.`,
        'info'
      );
    } catch {
      onNotify('Saved locally on this device (offline mode).', 'info');
    }
  };

  const handleToggleVisibility = async (key: keyof NtkVisibilityMatrix) => {
    const patch = { visibility: { [key]: !config.visibility[key] } };
    const localNext = applyLocalConfigPatch(config, patch);
    saveLocalNtkConfig(localNext);
    onConfigUpdated(localNext);
    if (isBrowserOffline()) {
      onNotify('Updated visibility locally on this device (offline mode).', 'info');
      return;
    }
    try {
      const next = await ntkVoiceApi.updateConfig(patch);
      saveLocalNtkConfig(next);
      onConfigUpdated(next);
    } catch {
      onNotify('Updated visibility locally on this device (offline mode).', 'info');
    }
  };

  const handleSavePrompts = async () => {
    setSaving(true);
    const patch = {
      aiButtons: buttonsDraft,
      workstation: { defaultLanguage: wsDraft.defaultLanguage },
    };
    const localNext = applyLocalConfigPatch(config, patch);
    saveLocalNtkConfig(localNext);
    onConfigUpdated(localNext);
    if (isBrowserOffline()) {
      setSaving(false);
      onNotify('Saved custom buttons locally on this device (offline mode).', 'info');
      return;
    }
    try {
      const next = await ntkVoiceApi.updateConfig(patch);
      saveLocalNtkConfig(next);
      onConfigUpdated(next);
      onNotify('Saved custom AI buttons and default language.', 'success');
    } catch {
      onNotify('Saved custom buttons locally on this device (offline mode).', 'info');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveWorkstation = async () => {
    setSaving(true);
    const { stemApiTokenMask: _omitMask, ...safeWsDraft } = wsDraft;
    const localNext = applyLocalConfigPatch(config, { workstation: safeWsDraft });
    saveLocalNtkConfig(localNext);
    onConfigUpdated(localNext);
    if (isBrowserOffline()) {
      setStemTokenInput('');
      setSaving(false);
      onNotify('Saved workstation settings locally on this device (offline mode).', 'info');
      return;
    }
    try {
      const next = await ntkVoiceApi.updateConfig({
        workstation: {
          ...safeWsDraft,
          ...(stemTokenInput.trim() ? { stemApiToken: stemTokenInput.trim() } : {}),
        },
      });
      saveLocalNtkConfig(next);
      onConfigUpdated(next);
      setStemTokenInput('');
      onNotify('Saved workstation & safety settings.', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg && !/fetch|network|404/i.test(msg)) {
        onNotify(msg, 'error');
      } else {
        setStemTokenInput('');
        onNotify('Saved workstation settings locally on this device (offline mode).', 'info');
      }
    } finally {
      setSaving(false);
    }
  };

  const renderPoolKeys = (pool: NtkPoolType, heading: string) => {
    const strategy = pool === 'stt' ? config.sttStrategy : config.llmStrategy;
    const poolKeys = config.keys
      .filter((k) => k.pool === pool)
      .sort((a, b) => a.priority - b.priority);

    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-bold text-slate-900 dark:text-white">{heading}</h4>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {poolKeys.filter((k) => k.enabled).length} enabled key(s) · automatic silent failover on 429/401/5xx/timeout
            </p>
          </div>
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => handleStrategyChange(pool, 'round_robin')}
              className={`rounded-md px-2.5 py-1 font-semibold ${
                strategy === 'round_robin'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              Round-Robin
            </button>
            <button
              type="button"
              onClick={() => handleStrategyChange(pool, 'priority_failover')}
              className={`rounded-md px-2.5 py-1 font-semibold ${
                strategy === 'priority_failover'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              Priority Failover
            </button>
          </div>
        </div>

        {poolKeys.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400 py-2">
            No keys added (100% optional). Recording, playback, Live EQ, trimming, and export work completely without API keys.
          </p>
        ) : (
          <div className="space-y-2">
            {poolKeys.map((k, idx) => {
              const badgeColor =
                k.status === 'ready'
                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                  : k.status === 'cooldown'
                  ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30'
                  : k.status === 'error'
                  ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30'
                  : 'bg-slate-200/80 dark:bg-slate-800 text-slate-500 border-slate-300 dark:border-slate-700';

              const statusLabel =
                k.status === 'ready'
                  ? 'Ready'
                  : k.status === 'cooldown'
                  ? 'Cooling Down'
                  : k.status === 'error'
                  ? 'Error'
                  : 'Disabled';

              return (
                <div
                  key={k.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] font-bold text-slate-400">
                        #{idx + 1}
                      </span>
                      <span className="text-xs font-bold text-slate-900 dark:text-white">
                        {k.label}
                      </span>
                      <span className="rounded-md bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600 dark:text-slate-300">
                        {k.provider}
                      </span>
                      <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${badgeColor}`}>
                        {statusLabel}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                      <span>{k.model}</span>
                      <span>·</span>
                      <span>{k.keyMask}</span>
                      <span>·</span>
                      <span>{k.requestCount} req ({k.successCount} ok / {k.errorCount} err)</span>
                      {k.lastLatencyMs !== null && <span>· {k.lastLatencyMs}ms</span>}
                    </div>
                    {k.lastError && (
                      <div className="mt-1 text-[11px] text-rose-600 dark:text-rose-400 truncate">
                        Last issue: {k.lastError}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      aria-label={`Move ${k.label} up`}
                      disabled={idx === 0}
                      onClick={() => handleMoveKey(pool, k.id, -1)}
                      className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 disabled:opacity-30"
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${k.label} down`}
                      disabled={idx === poolKeys.length - 1}
                      onClick={() => handleMoveKey(pool, k.id, 1)}
                      className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 disabled:opacity-30"
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleKey(k)}
                      className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold ${
                        k.enabled
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : 'border-slate-300 dark:border-slate-700 text-slate-500'
                      }`}
                    >
                      {k.enabled ? 'On' : 'Off'}
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${k.label}`}
                      onClick={() => handleDeleteKey(k)}
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 hover:text-rose-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ntk-manager-title"
      data-testid="ntk-manager-console"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/60 backdrop-blur-xs p-0 sm:p-4"
    >
      <div className="w-full sm:max-w-4xl max-h-[92vh] flex flex-col rounded-t-3xl sm:rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-900 dark:bg-blue-600 text-white">
              <Settings className="h-4.5 w-4.5" />
            </span>
            <div>
              <h2
                id="ntk-manager-title"
                className="font-display text-base font-bold text-slate-900 dark:text-white"
              >
                NTK Reorder Suite — Manager Console
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Direct office owner controls (no PIN) · Keys are stored encrypted on the server and never sent back to browsers.
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="ntk-close-manager-btn"
            aria-label="Close Manager Console"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Manager Navigation Tabs */}
        <div
          role="tablist"
          className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800 px-5 overflow-x-auto bg-slate-50/70 dark:bg-slate-900/50"
        >
          {[
            { id: 'visibility', label: 'Feature Visibility Matrix', icon: Eye },
            { id: 'workstation', label: 'Workstation & Safety', icon: Sliders },
            { id: 'keys', label: 'Optional AI & API Keys', icon: KeyRound },
            { id: 'prompts', label: 'Optional AI Buttons', icon: Sparkles },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                data-testid={`ntk-manage-tab-${item.id}`}
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id as typeof tab)}
                className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-3 text-xs font-semibold whitespace-nowrap transition-colors ${
                  tab === item.id
                    ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* TAB: OPTIONAL AI & API KEY POOL */}
          {tab === 'keys' && (
            <div className="space-y-5">
              {/* Clear Optional Reassurance + Instant AI Master Switch */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60 p-4">
                <div className="space-y-0.5 max-w-xl">
                  <div className="text-xs font-bold text-slate-900 dark:text-white">
                    AI &amp; API Keys Are 100% Optional (Not Compulsory)
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                    Recording, playback, speed controls, flags, 7-band Live EQ, trimming, and MP3/WAV/WebM export work completely offline with zero API keys. Enable AI below and add keys only if you want cloud transcription or text notes.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={config.visibility.aiFeaturesEnabled}
                  data-testid="ntk-keys-tab-ai-toggle"
                  onClick={() => handleToggleVisibility('aiFeaturesEnabled')}
                  className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${
                    config.visibility.aiFeaturesEnabled
                      ? 'border-blue-500/40 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                      : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200'
                  }`}
                >
                  <span>{config.visibility.aiFeaturesEnabled ? 'Optional AI: ON' : 'Optional AI: OFF'}</span>
                  <span
                    className={`inline-flex h-4 w-7 items-center rounded-full p-0.5 transition-colors ${
                      config.visibility.aiFeaturesEnabled
                        ? 'bg-blue-600 justify-end'
                        : 'bg-slate-300 dark:bg-slate-600 justify-start'
                    }`}
                  >
                    <span className="h-3 w-3 rounded-full bg-white" />
                  </span>
                </button>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-200/80 dark:border-blue-900/60 bg-blue-50/60 dark:bg-blue-950/30 p-3.5">
                <div className="text-xs text-slate-700 dark:text-slate-200">
                  <strong className="text-slate-900 dark:text-white">Pool Health:</strong>{' '}
                  {config.summary.sttReady}/{config.summary.sttTotal} STT Ready ·{' '}
                  {config.summary.llmReady}/{config.summary.llmTotal} Text AI Ready ·{' '}
                  Today&apos;s usage: <span className="font-mono font-bold">{config.dailyAiRequests}</span>
                  {config.workstation.dailyAiRequestCap > 0
                    ? ` / ${config.workstation.dailyAiRequestCap}`
                    : ' (Unlimited)'}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="ntk-test-all-keys-btn"
                    disabled={testingKeys}
                    onClick={handleTestAllKeys}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
                  >
                    {testingKeys ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Activity className="h-3.5 w-3.5" />
                    )}
                    <span>Test All Keys</span>
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const next = await ntkVoiceApi.resetStats();
                        onConfigUpdated(next);
                        onNotify('Cleared cooldowns & failover logs.', 'info');
                      } catch {
                        onNotify(
                          'Log clearing applies only when connected to the optional server.',
                          'warning'
                        );
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>Clear Logs</span>
                  </button>
                </div>
              </div>

              {renderPoolKeys('stt', 'Speech-to-Text (Transcription) Free Key Pool')}
              {renderPoolKeys('llm', 'Text Intelligence (Summaries, Actions, Email) Free Key Pool')}

              {/* Add Key Form */}
              <form
                onSubmit={handleAddKey}
                className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3"
              >
                <div className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                  <Plus className="h-4 w-4 text-blue-600" />
                  <span>Add Free-Tier Provider Key (Unlimited Keys per Provider)</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                  <label className="space-y-1">
                    <span className="font-semibold text-slate-600 dark:text-slate-300">Pool</span>
                    <select
                      value={newPool}
                      onChange={(e) => handleSelectPool(e.target.value as NtkPoolType)}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2"
                    >
                      <option value="stt">Speech-to-Text (Transcription)</option>
                      <option value="llm">Text Intelligence (Notes / Email)</option>
                    </select>
                  </label>

                  <label className="space-y-1">
                    <span className="font-semibold text-slate-600 dark:text-slate-300">Provider</span>
                    <select
                      value={newProvider}
                      onChange={(e) => handleSelectProvider(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2"
                    >
                      {catalogForPool.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1">
                    <span className="font-semibold text-slate-600 dark:text-slate-300">Model</span>
                    <input
                      type="text"
                      list="ntk-model-suggestions"
                      value={newModel}
                      onChange={(e) => setNewModel(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2"
                    />
                    <datalist id="ntk-model-suggestions">
                      {activeCatalogEntry.models.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </label>

                  <label className="space-y-1">
                    <span className="font-semibold text-slate-600 dark:text-slate-300">
                      Label (e.g. Groq Key #2)
                    </span>
                    <input
                      type="text"
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                      placeholder={`${activeCatalogEntry.name} Key`}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2"
                    />
                  </label>

                  <label className="space-y-1">
                    <span className="font-semibold text-slate-600 dark:text-slate-300">
                      API Key / Token (Optional · Encrypted Server-Side)
                    </span>
                    <input
                      type="password"
                      value={newApiKey}
                      onChange={(e) => setNewApiKey(e.target.value)}
                      placeholder="Optional — paste key only if using AI..."
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2"
                    />
                  </label>

                  {activeCatalogEntry.needsAccountId && (
                    <label className="space-y-1">
                      <span className="font-semibold text-slate-600 dark:text-slate-300">
                        Cloudflare Account ID
                      </span>
                      <input
                        type="text"
                        value={newAccountId}
                        onChange={(e) => setNewAccountId(e.target.value)}
                        placeholder="32-char Cloudflare Account ID"
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2"
                      />
                    </label>
                  )}

                  {activeCatalogEntry.needsBaseUrl && (
                    <label className="space-y-1">
                      <span className="font-semibold text-slate-600 dark:text-slate-300">
                        Custom OpenAI HTTPS Endpoint URL
                      </span>
                      <input
                        type="url"
                        value={newBaseUrl}
                        onChange={(e) => setNewBaseUrl(e.target.value)}
                        placeholder="https://api.example.com/v1"
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2"
                      />
                    </label>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    {activeCatalogEntry.freeTierNote}
                  </span>
                  <button
                    type="submit"
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-white px-4 py-2 text-xs font-semibold text-white dark:text-slate-900 hover:opacity-90 disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Add Key to Pool</span>
                  </button>
                </div>
              </form>

              {/* Optional Hugging Face HTDemucs Stem Separation Endpoint */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3">
                <div className="text-xs font-bold text-slate-900 dark:text-white">
                  4-Track AI Stem Separation Endpoint (Optional Free Hugging Face HTDemucs Space)
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <label className="space-y-1">
                    <span className="font-semibold text-slate-600 dark:text-slate-300">
                      Hugging Face Gradio Space / Stem API HTTPS URL
                    </span>
                    <input
                      type="url"
                      value={wsDraft.stemSeparationUrl}
                      onChange={(e) => setWsDraft({ ...wsDraft, stemSeparationUrl: e.target.value })}
                      placeholder="https://your-htdemucs-space.hf.space"
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="font-semibold text-slate-600 dark:text-slate-300">
                      Optional HF Token (for private Spaces)
                    </span>
                    <input
                      type="password"
                      value={stemTokenInput}
                      onChange={(e) => setStemTokenInput(e.target.value)}
                      placeholder={config.workstation.stemApiTokenMask || 'Leave blank for public Spaces'}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2"
                    />
                  </label>
                </div>
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleSaveWorkstation}
                  className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                >
                  Save Stem Endpoint
                </button>
              </div>

              {/* Live Failover & Rotation Audit Log */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-2">
                <div className="text-xs font-bold text-slate-900 dark:text-white">
                  Recent Rotation &amp; Failover Log
                </div>
                {config.failoverLogs.length === 0 ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    No AI calls or key tests logged yet. Click &ldquo;Test All Keys&rdquo; above to verify connectivity.
                  </p>
                ) : (
                  <div className="max-h-40 overflow-y-auto space-y-1 font-mono text-[11px]">
                    {config.failoverLogs.map((entry) => (
                      <div
                        key={entry.id}
                        className="flex items-start gap-2 rounded-lg bg-slate-50 dark:bg-slate-900/60 px-2.5 py-1.5"
                      >
                        <span className="text-slate-400 shrink-0">
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </span>
                        <span
                          className={`uppercase font-bold shrink-0 ${
                            entry.event === 'success' || entry.event === 'test_ok'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : entry.event === 'failover' || entry.event === 'cooldown'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-rose-600 dark:text-rose-400'
                          }`}
                        >
                          {entry.event}
                        </span>
                        <span className="text-slate-700 dark:text-slate-200 break-all">
                          [{entry.pool}/{entry.label}] {entry.message}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: FEATURE VISIBILITY MATRIX */}
          {tab === 'visibility' && (
            <div className="space-y-3">
              <p className="text-xs text-slate-600 dark:text-slate-300">
                Control exactly which features appear for office workers. Changes take effect immediately across the suite.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {VISIBILITY_ITEMS.map((item) => {
                  const enabled = config.visibility[item.key];
                  return (
                    <button
                      key={item.key}
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      data-testid={`ntk-vis-${item.key}`}
                      onClick={() => handleToggleVisibility(item.key)}
                      className={`flex items-start justify-between gap-3 rounded-xl border p-3.5 text-left transition-colors ${
                        enabled
                          ? 'border-blue-500/40 bg-blue-50/40 dark:bg-blue-950/20'
                          : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40'
                      }`}
                    >
                      <div>
                        <div className="text-xs font-bold text-slate-900 dark:text-white">
                          {item.label}
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                          {item.desc}
                        </div>
                      </div>
                      <span
                        className={`mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${
                          enabled ? 'bg-blue-600 justify-end' : 'bg-slate-300 dark:bg-slate-700 justify-start'
                        }`}
                      >
                        <span className="h-4 w-4 rounded-full bg-white shadow-xs" />
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 3: CUSTOM AI BUTTON & PROMPT BUILDER */}
          {tab === 'prompts' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 p-3.5 text-xs">
                <label className="space-y-1">
                  <span className="font-bold text-slate-800 dark:text-slate-200">
                    Default Speech Language
                  </span>
                  <select
                    value={wsDraft.defaultLanguage}
                    onChange={(e) => setWsDraft({ ...wsDraft, defaultLanguage: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2"
                  >
                    <option value="auto">Auto-Detect Language</option>
                    <option value="en">English (en)</option>
                    <option value="es">Spanish (es)</option>
                    <option value="fr">French (fr)</option>
                    <option value="de">German (de)</option>
                    <option value="pt">Portuguese (pt)</option>
                    <option value="ar">Arabic (ar)</option>
                    <option value="hi">Hindi (hi)</option>
                    <option value="zh">Chinese (zh)</option>
                  </select>
                </label>
                <div className="flex items-end">
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                    Customize the 1-click buttons novices see on every recording. Enable/disable any button or edit its plain-English prompt.
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                {buttonsDraft.map((btn, idx) => (
                  <div
                    key={btn.id}
                    className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-2.5 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="flex items-center gap-2 font-bold text-slate-900 dark:text-white cursor-pointer">
                        <input
                          type="checkbox"
                          checked={btn.enabled}
                          onChange={(e) => {
                            const copy = [...buttonsDraft];
                            copy[idx] = { ...btn, enabled: e.target.checked };
                            setButtonsDraft(copy);
                          }}
                          className="rounded accent-blue-600"
                        />
                        <span>Button #{idx + 1} ({btn.kind === 'transcribe' ? 'Speech-to-Text' : 'Text AI'})</span>
                      </label>
                      {btn.id === 'btn-translate' && (
                        <input
                          type="text"
                          value={btn.targetLanguage || ''}
                          onChange={(e) => {
                            const copy = [...buttonsDraft];
                            copy[idx] = { ...btn, targetLanguage: e.target.value };
                            setButtonsDraft(copy);
                          }}
                          placeholder="Target language (e.g. Spanish)"
                          className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1"
                        />
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <input
                        type="text"
                        aria-label={`Button ${idx + 1} label`}
                        value={btn.label}
                        onChange={(e) => {
                          const copy = [...buttonsDraft];
                          copy[idx] = { ...btn, label: e.target.value };
                          setButtonsDraft(copy);
                        }}
                        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 font-semibold"
                      />
                      <input
                        type="text"
                        aria-label={`Button ${idx + 1} helper description`}
                        value={btn.description}
                        onChange={(e) => {
                          const copy = [...buttonsDraft];
                          copy[idx] = { ...btn, description: e.target.value };
                          setButtonsDraft(copy);
                        }}
                        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5"
                      />
                    </div>
                    <textarea
                      rows={2}
                      aria-label={`Button ${idx + 1} AI prompt`}
                      value={btn.prompt}
                      onChange={(e) => {
                        const copy = [...buttonsDraft];
                        copy[idx] = { ...btn, prompt: e.target.value };
                        setButtonsDraft(copy);
                      }}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5"
                    />
                  </div>
                ))}
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleSavePrompts}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Save AI Buttons &amp; Prompts</span>
                </button>
              </div>
            </div>
          )}

          {/* TAB 4: SHARED WORKSTATION & SAFETY SETTINGS */}
          {tab === 'workstation' && (
            <div className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <label className="space-y-1">
                  <span className="font-bold text-slate-800 dark:text-slate-200">
                    Editable Suite Name
                  </span>
                  <input
                    type="text"
                    value={wsDraft.suiteName}
                    onChange={(e) => setWsDraft({ ...wsDraft, suiteName: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
                  />
                </label>

                <label className="space-y-1">
                  <span className="font-bold text-slate-800 dark:text-slate-200">
                    Welcome / 3-Step Hint Message
                  </span>
                  <input
                    type="text"
                    value={wsDraft.welcomeMessage}
                    onChange={(e) => setWsDraft({ ...wsDraft, welcomeMessage: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
                  />
                </label>

                <label className="space-y-1">
                  <span className="font-bold text-slate-800 dark:text-slate-200">
                    Max Recording Duration (minutes)
                  </span>
                  <input
                    type="number"
                    min={5}
                    max={240}
                    value={wsDraft.maxRecordingMinutes}
                    onChange={(e) =>
                      setWsDraft({ ...wsDraft, maxRecordingMinutes: Number(e.target.value) })
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
                  />
                </label>

                <label className="space-y-1">
                  <span className="font-bold text-slate-800 dark:text-slate-200">
                    Auto-Stop on Prolonged Silence (seconds, 0 = off)
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={600}
                    step={15}
                    value={wsDraft.autoStopSilenceSec}
                    onChange={(e) =>
                      setWsDraft({ ...wsDraft, autoStopSilenceSec: Number(e.target.value) })
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
                  />
                </label>

                <label className="space-y-1">
                  <span className="font-bold text-slate-800 dark:text-slate-200">
                    Shared PC Auto-Cleanup Retention
                  </span>
                  <select
                    value={wsDraft.retentionPolicy}
                    onChange={(e) =>
                      setWsDraft({
                        ...wsDraft,
                        retentionPolicy: e.target.value as '24h' | '7d' | 'manual',
                      })
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
                  >
                    <option value="24h">Move recordings to Trash after 24 hours</option>
                    <option value="7d">Move recordings to Trash after 7 days (Recommended)</option>
                    <option value="manual">Manual only (never auto-archive)</option>
                  </select>
                </label>

                <label className="space-y-1">
                  <span className="font-bold text-slate-800 dark:text-slate-200">
                    Daily Office AI Request Cap (0 = unlimited)
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={50000}
                    value={wsDraft.dailyAiRequestCap}
                    onChange={(e) =>
                      setWsDraft({ ...wsDraft, dailyAiRequestCap: Number(e.target.value) })
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2"
                  />
                </label>
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleSaveWorkstation}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Save Workstation Settings</span>
                </button>
              </div>

              {/* Backup & Master Reset */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-4 space-y-3">
                <div className="font-bold text-slate-900 dark:text-white">
                  Backup &amp; Shared Workstation Maintenance
                </div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={onExportAllZip}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2 font-semibold text-slate-800 dark:text-slate-100"
                  >
                    <Download className="h-3.5 w-3.5 text-blue-600" />
                    <span>Export All Backup (.zip)</span>
                  </button>

                  <button
                    type="button"
                    onClick={async () => {
                      clearLocalNtkConfig();
                      const fallbackNext = applyLocalConfigPatch(config, {
                        sttStrategy: 'round_robin',
                        llmStrategy: 'round_robin',
                        visibility: {
                          aiFeaturesEnabled: false,
                          showAdvancedToggle: true,
                          meetingAudioCapture: true,
                          liveEqConsole: true,
                          aiStemMixer: true,
                          waveformTrimmer: true,
                          momentFlags: true,
                          multiFormatExport: true,
                          defaultNoisePolish: true,
                          optionalProfiles: false,
                          localBrowserWhisperFallback: false,
                        },
                        workstation: {
                          suiteName: 'NTK Reorder Suite',
                          welcomeMessage: '1. Tap Record • 2. Speak normally • 3. Play, edit, or save',
                          defaultLanguage: 'auto',
                          maxRecordingMinutes: 60,
                          autoStopSilenceSec: 0,
                          retentionPolicy: '7d',
                          dailyAiRequestCap: 250,
                        },
                      });
                      onConfigUpdated(fallbackNext);
                      setButtonsDraft(fallbackNext.aiButtons);
                      setWsDraft(fallbackNext.workstation);
                      if (isBrowserOffline()) {
                        onNotify('Restored suite defaults locally (offline mode).', 'info');
                        return;
                      }
                      try {
                        const next = await ntkVoiceApi.resetDefaults();
                        onConfigUpdated(next);
                        setButtonsDraft(next.aiButtons);
                        setWsDraft(next.workstation);
                        onNotify('Restored default visibility, prompts, and workstation settings.', 'info');
                      } catch {
                        onNotify('Restored suite defaults locally (offline mode).', 'info');
                      }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2 font-semibold text-slate-700 dark:text-slate-200"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Reset Suite Defaults</span>
                  </button>

                  {!confirmReset ? (
                    <button
                      type="button"
                      onClick={() => setConfirmReset(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 px-3.5 py-2 font-semibold text-rose-700 dark:text-rose-300"
                    >
                      <ShieldAlert className="h-3.5 w-3.5" />
                      <span>Master Storage Reset</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 rounded-lg border border-rose-500 bg-rose-50 dark:bg-rose-950/50 px-3 py-1.5">
                      <span className="font-semibold text-rose-700 dark:text-rose-200">
                        Wipe all local suite recordings?
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          await onMasterResetStorage();
                          setConfirmReset(false);
                        }}
                        className="rounded bg-rose-600 px-2.5 py-1 text-white font-bold"
                      >
                        Yes, Wipe
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmReset(false)}
                        className="rounded border border-slate-300 dark:border-slate-600 px-2 py-1 text-slate-700 dark:text-slate-200"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
