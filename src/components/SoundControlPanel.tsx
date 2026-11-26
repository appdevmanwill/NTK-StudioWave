import {
  AudioLines,
  CheckCircle2,
  Drum,
  Gauge,
  Headphones,
  Mic,
  Music2,
  Piano,
  RotateCcw,
  Sliders,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useState } from 'react';
import type {
  RegionTransformOptions,
  SoundBalanceSettings,
  SoundElementKey,
  SteadyNormalizeOptions,
  SteadyNormalizeStats,
  UserMode,
} from '../types/audio';
import { formatDuration } from '../utils/audioDsp';
import { DEFAULT_SOUND_BALANCE } from '../utils/ruleBasedEditorDsp';
import { Tooltip } from './Tooltip';

interface SoundControlPanelProps {
  userMode: UserMode;
  duration: number;
  selection: { start: number; end: number } | null;
  onClearSelection: () => void;
  onApplySoundBalance: (
    settings: SoundBalanceSettings,
    scope: 'full' | 'selection'
  ) => void;
  onApplySteadyNormalize: (
    options: SteadyNormalizeOptions
  ) => SteadyNormalizeStats | null;
  onApplyRegionTransform: (options: RegionTransformOptions) => void;
  isProcessing: boolean;
}

const ELEMENT_META: Array<{
  key: SoundElementKey;
  label: string;
  simpleDesc: string;
  proDesc: string;
  icon: typeof Mic;
  accent: string;
}> = [
  {
    key: 'leadVoice',
    label: 'Main Voice',
    simpleDesc: 'Center singing or speaking voice',
    proDesc: 'Center Mid harmonic core (220 Hz – 3.6 kHz)',
    icon: Mic,
    accent: 'text-blue-500',
  },
  {
    key: 'backupVoice',
    label: 'Backup Voices',
    simpleDesc: 'Harmonies, choir & wide side vocals',
    proDesc: 'Side vocal band (280 Hz – 5.0 kHz) & upper vocal harmonics',
    icon: Users,
    accent: 'text-violet-500',
  },
  {
    key: 'drums',
    label: 'Drums & Beats',
    simpleDesc: 'Kick hits, snares, claps & percussion',
    proDesc: 'Dual-envelope transient/percussive detector layer',
    icon: Drum,
    accent: 'text-amber-500',
  },
  {
    key: 'keyboard',
    label: 'Keyboard & Instruments',
    simpleDesc: 'Piano, keys, synths, guitars & pads',
    proDesc: 'Sustained melodic instrument harmonics outside lead core',
    icon: Piano,
    accent: 'text-emerald-500',
  },
  {
    key: 'bass',
    label: 'Bass & Low End',
    simpleDesc: 'Bass guitar & deep sub frequencies',
    proDesc: 'Sustained low-frequency layer (< 160 Hz)',
    icon: AudioLines,
    accent: 'text-cyan-500',
  },
];

export function SoundControlPanel({
  userMode,
  duration,
  selection,
  onClearSelection,
  onApplySoundBalance,
  onApplySteadyNormalize,
  onApplyRegionTransform,
  isProcessing,
}: SoundControlPanelProps) {
  // 1. Steady Voice Normalizer state
  const [normPreset, setNormPreset] = useState<'gentle' | 'steady' | 'loud'>('steady');
  const [normMode, setNormMode] = useState<'steady' | 'peak'>('steady');
  const [normNoiseFloorDb, setNormNoiseFloorDb] = useState(-44);
  const [normMaxBoostDb, setNormMaxBoostDb] = useState(18);
  const [lastNormStats, setLastNormStats] = useState<SteadyNormalizeStats | null>(null);

  // 2. 5-Element Sound Isolator & Rebalancer state
  const [balance, setBalance] = useState<SoundBalanceSettings>(DEFAULT_SOUND_BALANCE);
  const [balanceScope, setBalanceScope] = useState<'full' | 'selection'>('full');

  // 3. Any-Part Pitch, Rate & Volume Editor state
  const [pitchSemitones, setPitchSemitones] = useState(0);
  const [speedRate, setSpeedRate] = useState(1.0);
  const [preservePitch, setPreservePitch] = useState(true);
  const [gainDb, setGainDb] = useState(0);

  const hasSelection = selection !== null && selection.end - selection.start >= 0.1;

  const targetLufsForPreset =
    normPreset === 'gentle' ? -18 : normPreset === 'loud' ? -14 : -16;

  const handleRunSteadyNormalize = () => {
    const stats = onApplySteadyNormalize({
      mode: normMode,
      targetLufs: targetLufsForPreset,
      ceilingDb: -1.0,
      maxBoostDb: normMaxBoostDb,
      noiseFloorDb: normNoiseFloorDb,
      startSec: hasSelection && balanceScope === 'selection' ? selection!.start : undefined,
      endSec: hasSelection && balanceScope === 'selection' ? selection!.end : undefined,
    });
    if (stats) setLastNormStats(stats);
  };

  const applyRecipe = (recipe: 'voiceUp' | 'lessDrums' | 'soloVoice' | 'karaoke' | 'reset') => {
    if (recipe === 'reset') {
      setBalance(DEFAULT_SOUND_BALANCE);
      return;
    }
    if (recipe === 'voiceUp') {
      setBalance({
        leadVoice: 1.45,
        backupVoice: 0.85,
        drums: 0.65,
        keyboard: 0.55,
        bass: 0.8,
        muted: { leadVoice: false, backupVoice: false, drums: false, keyboard: false, bass: false },
        solo: null,
      });
    } else if (recipe === 'lessDrums') {
      setBalance({
        leadVoice: 1.05,
        backupVoice: 1.0,
        drums: 0.35,
        keyboard: 1.0,
        bass: 0.9,
        muted: { leadVoice: false, backupVoice: false, drums: false, keyboard: false, bass: false },
        solo: null,
      });
    } else if (recipe === 'soloVoice') {
      setBalance({
        leadVoice: 1.35,
        backupVoice: 0.2,
        drums: 0.1,
        keyboard: 0.1,
        bass: 0.1,
        muted: { leadVoice: false, backupVoice: false, drums: false, keyboard: false, bass: false },
        solo: 'leadVoice',
      });
    } else if (recipe === 'karaoke') {
      setBalance({
        leadVoice: 0,
        backupVoice: 0.9,
        drums: 1.05,
        keyboard: 1.1,
        bass: 1.05,
        muted: { leadVoice: true, backupVoice: false, drums: false, keyboard: false, bass: false },
        solo: null,
      });
    }
  };

  const isBalanceModified =
    balance.solo !== null ||
    Object.values(balance.muted).some(Boolean) ||
    Math.abs(balance.leadVoice - 1) > 0.01 ||
    Math.abs(balance.backupVoice - 1) > 0.01 ||
    Math.abs(balance.drums - 1) > 0.01 ||
    Math.abs(balance.keyboard - 1) > 0.01 ||
    Math.abs(balance.bass - 1) > 0.01;

  const isTransformModified =
    Math.abs(pitchSemitones) > 0.01 ||
    Math.abs(speedRate - 1.0) > 0.01 ||
    Math.abs(gainDb) > 0.01;

  const handleApplyTransformClick = () => {
    onApplyRegionTransform({
      startSec: hasSelection ? selection!.start : undefined,
      endSec: hasSelection ? selection!.end : undefined,
      pitchSemitones,
      speedRate,
      preservePitch,
      gainDb,
    });
  };

  return (
    <div className="space-y-5" data-testid="sound-control-panel">
      {/* CARD 1: STEADY VOICE NORMALIZER (Fixes fluctuating quiet/loud volume!) */}
      <section
        data-testid="steady-normalizer-card"
        className="rounded-2xl border border-emerald-500/35 bg-gradient-to-br from-emerald-500/8 via-white to-white dark:from-emerald-500/12 dark:via-[#131822] dark:to-[#131822] p-5 space-y-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white">
                <Volume2 className="h-4 w-4" />
              </span>
              <h3 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <span>Make Volume Steady (Fix Low & Loud Voice)</span>
                <Tooltip text="Automatically raises quiet parts and gently lowers loud spikes so your voice stays smooth and easy to hear from start to finish — without boosting background noise." />
              </h3>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Voice sounds quiet in some parts and loud in others? Pick a comfort level and click once to even it out cleanly.
            </p>
          </div>

          <button
            type="button"
            disabled={isProcessing}
            data-testid="apply-steady-normalize-btn"
            onClick={handleRunSteadyNormalize}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-xs sm:text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-45 shadow-sm whitespace-nowrap transition-colors"
          >
            <Volume2 className="h-4 w-4" />
            <span>{isProcessing ? 'Balancing...' : 'Make My Voice Steady'}</span>
          </button>
        </div>

        {/* 3 Plain-English Loudness Presets */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          {(
            [
              {
                id: 'gentle',
                title: 'Gentle & Natural',
                desc: 'Softly evens out voice while keeping natural expression.',
                pro: '-18 LUFS',
              },
              {
                id: 'steady',
                title: 'Steady Voice (Recommended)',
                desc: 'Best for podcasts, lessons, and uneven mic distance.',
                pro: '-16 LUFS',
              },
              {
                id: 'loud',
                title: 'Extra Clear & Loud',
                desc: 'Full, broadcast-ready volume for videos & phone speakers.',
                pro: '-14 LUFS',
              },
            ] as const
          ).map((p) => {
            const active = normPreset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setNormPreset(p.id)}
                className={`rounded-xl border p-3 text-left transition-colors ${
                  active
                    ? 'border-emerald-500 bg-emerald-500/12 text-slate-900 dark:text-white'
                    : 'border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/50 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold">{p.title}</span>
                  {userMode === 'pro' && (
                    <span className="font-mono text-[10px] text-emerald-600 dark:text-emerald-400">
                      {p.pro}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                  {p.desc}
                </p>
              </button>
            );
          })}
        </div>

        {/* Pro Mode Fine-Tuning (Hidden in Simple Mode to keep novices completely unstressed) */}
        {userMode === 'pro' && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-3.5 text-xs">
            <div className="space-y-1.5">
              <span className="font-semibold text-slate-700 dark:text-slate-300">Mode</span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setNormMode('steady')}
                  className={`flex-1 rounded-lg px-2.5 py-1.5 font-semibold ${
                    normMode === 'steady'
                      ? 'bg-emerald-600 text-white'
                      : 'border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  Steady Rider
                </button>
                <button
                  type="button"
                  onClick={() => setNormMode('peak')}
                  className={`flex-1 rounded-lg px-2.5 py-1.5 font-semibold ${
                    normMode === 'peak'
                      ? 'bg-emerald-600 text-white'
                      : 'border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  Peak Only
                </button>
              </div>
            </div>

            <label className="space-y-1">
              <div className="flex justify-between">
                <span className="text-slate-600 dark:text-slate-400">Silence Guard</span>
                <span className="font-mono tabular-nums text-slate-900 dark:text-white">
                  {normNoiseFloorDb} dBFS
                </span>
              </div>
              <input
                type="range"
                min={-56}
                max={-30}
                step={2}
                value={normNoiseFloorDb}
                onChange={(e) => setNormNoiseFloorDb(Number(e.target.value))}
                className="w-full"
              />
            </label>

            <label className="space-y-1">
              <div className="flex justify-between">
                <span className="text-slate-600 dark:text-slate-400">Max Quiet Boost</span>
                <span className="font-mono tabular-nums text-slate-900 dark:text-white">
                  +{normMaxBoostDb} dB
                </span>
              </div>
              <input
                type="range"
                min={6}
                max={24}
                step={1}
                value={normMaxBoostDb}
                onChange={(e) => setNormMaxBoostDb(Number(e.target.value))}
                className="w-full"
              />
            </label>
          </div>
        )}

        {/* Plain-English Before -> After Proof Banner */}
        {lastNormStats && (
          <div
            data-testid="steady-normalize-result"
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-800 dark:text-emerald-200"
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
              <span>
                <strong>Volume is now steady!</strong> Volume jumps tightened from{' '}
                <strong className="font-mono">{lastNormStats.beforeRangeDb.toFixed(1)} dB</strong>{' '}
                down to{' '}
                <strong className="font-mono">{lastNormStats.afterRangeDb.toFixed(1)} dB</strong>
                {' · '}Loudness{' '}
                <span className="font-mono">
                  {lastNormStats.beforeLufs.toFixed(1)} → {lastNormStats.afterLufs.toFixed(1)} LUFS
                </span>{' '}
                (zero clipping).
              </span>
            </div>
            <span className="text-[11px] opacity-80">Press Ctrl+Z anytime to undo</span>
          </div>
        )}
      </section>

      {/* CARD 2: RULE-BASED INDIVIDUAL SOUND CONTROL (Voice, Backup, Drums, Keys, Bass) */}
      <section
        data-testid="sound-rebalancer-card"
        className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Sliders className="h-4 w-4 text-blue-500" />
              <span>Adjust Individual Sounds (Voice, Drums, Keys & Bass)</span>
              <Tooltip text="100% rule-based acoustic separator (fast, zero AI download). Turn drums down, lift your main voice, or soften keyboards and backup vocals." />
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Drag any slider left to reduce or remove that sound, or right to make it louder — lightweight and instant on any PC.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {hasSelection && (
              <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => setBalanceScope('full')}
                  className={`rounded-md px-2.5 py-1 font-semibold ${
                    balanceScope === 'full'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white'
                      : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  Whole Track
                </button>
                <button
                  type="button"
                  onClick={() => setBalanceScope('selection')}
                  className={`rounded-md px-2.5 py-1 font-semibold ${
                    balanceScope === 'selection'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  Selected Part
                </button>
              </div>
            )}

            <button
              type="button"
              disabled={!isBalanceModified || isProcessing}
              data-testid="apply-sound-balance-btn"
              onClick={() => onApplySoundBalance(balance, hasSelection ? balanceScope : 'full')}
              className="rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-45 whitespace-nowrap"
            >
              {isProcessing ? 'Applying...' : 'Apply Sound Changes'}
            </button>
          </div>
        </div>

        {/* One-Click Novice Quick Recipes */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Quick Recipes:
          </span>
          {(
            [
              { id: 'voiceUp', label: 'Boost Voice, Soften Keys' },
              { id: 'lessDrums', label: 'Turn Down Drums' },
              { id: 'soloVoice', label: 'Main Voice Only' },
              { id: 'karaoke', label: 'Remove Main Voice' },
              { id: 'reset', label: 'Reset All (100%)' },
            ] as const
          ).map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => applyRecipe(r.id)}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
            >
              {r.label}
            </button>
          ))}
        </div>

        {/* 5 Clean Channel Strips */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {ELEMENT_META.map((el) => {
            const Icon = el.icon;
            const valuePct = Math.round(balance[el.key] * 100);
            const isMuted = balance.muted[el.key];
            const isSolo = balance.solo === el.key;
            const dimmedByOtherSolo = balance.solo !== null && !isSolo;

            return (
              <div
                key={el.key}
                data-testid={`sound-strip-${el.key}`}
                className={`rounded-xl border p-3.5 space-y-3 transition-colors ${
                  isSolo
                    ? 'border-blue-500 bg-blue-500/8'
                    : isMuted || dimmedByOtherSolo
                    ? 'border-slate-200 dark:border-slate-800 bg-slate-100/60 dark:bg-slate-900/30 opacity-75'
                    : 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50'
                }`}
              >
                <div className="flex items-start justify-between gap-1">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <Icon className={`h-4 w-4 shrink-0 ${el.accent}`} />
                      <span className="text-xs font-bold text-slate-900 dark:text-white truncate">
                        {el.label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                      {userMode === 'pro' ? el.proDesc : el.simpleDesc}
                    </p>
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-500 dark:text-slate-400">
                      {isMuted || valuePct === 0
                        ? 'Removed'
                        : valuePct < 95
                        ? 'Reduced'
                        : valuePct > 105
                        ? 'Boosted'
                        : 'Normal'}
                    </span>
                    <span className="font-mono font-bold tabular-nums text-slate-900 dark:text-white">
                      {isMuted ? '0%' : `${valuePct}%`}
                    </span>
                  </div>
                  <input
                    type="range"
                    aria-label={`${el.label} level`}
                    min={0}
                    max={200}
                    step={5}
                    value={isMuted ? 0 : valuePct}
                    onChange={(e) => {
                      const nextVal = Number(e.target.value) / 100;
                      setBalance((prev) => ({
                        ...prev,
                        [el.key]: nextVal,
                        muted: { ...prev.muted, [el.key]: nextVal === 0 },
                      }));
                    }}
                    className="w-full"
                  />
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-pressed={isMuted}
                    onClick={() =>
                      setBalance((prev) => ({
                        ...prev,
                        muted: { ...prev.muted, [el.key]: !prev.muted[el.key] },
                      }))
                    }
                    className={`flex-1 inline-flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold transition-colors ${
                      isMuted
                        ? 'bg-rose-600 text-white'
                        : 'border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                    }`}
                  >
                    <VolumeX className="h-3 w-3" />
                    <span>{isMuted ? 'Muted' : 'Mute'}</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={isSolo}
                    onClick={() =>
                      setBalance((prev) => ({
                        ...prev,
                        solo: prev.solo === el.key ? null : el.key,
                      }))
                    }
                    className={`flex-1 inline-flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold transition-colors ${
                      isSolo
                        ? 'bg-blue-600 text-white'
                        : 'border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                    }`}
                  >
                    <Headphones className="h-3 w-3" />
                    <span>Solo</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* CARD 3: ANY-PART PITCH, SPEED / RATE & VOLUME EDITOR */}
      <section
        data-testid="region-transform-card"
        className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Music2 className="h-4 w-4 text-violet-500" />
              <span>Change Pitch, Speed, or Volume (Whole Track or Any Part)</span>
              <Tooltip text="Highlight any section on the blue waveform above to adjust just that part — or leave nothing selected to change the whole recording. Smooth 15ms crossfades prevent clicks." />
            </h3>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {hasSelection ? (
                <>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/15 border border-blue-500/40 px-2.5 py-0.5 font-semibold text-blue-700 dark:text-blue-300">
                    Editing Selected Part: {formatDuration(selection!.start, true)} –{' '}
                    {formatDuration(selection!.end, true)}
                  </span>
                  <button
                    type="button"
                    onClick={onClearSelection}
                    className="text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white underline"
                  >
                    Switch to Whole Track
                  </button>
                </>
              ) : (
                <span className="text-slate-500 dark:text-slate-400">
                  Editing <strong>Whole Recording ({formatDuration(duration, true)})</strong>. Tip: drag across any part of the waveform above to change just that section.
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setPitchSemitones(0);
                setSpeedRate(1.0);
                setPreservePitch(true);
                setGainDb(0);
              }}
              className="inline-flex items-center gap-1 rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Reset</span>
            </button>
            <button
              type="button"
              disabled={!isTransformModified || isProcessing}
              data-testid="apply-region-transform-btn"
              onClick={handleApplyTransformClick}
              className="rounded-xl bg-violet-600 px-4 py-2 text-xs font-bold text-white hover:bg-violet-700 disabled:opacity-45 whitespace-nowrap"
            >
              {isProcessing
                ? 'Updating...'
                : hasSelection
                ? 'Apply to Selected Part'
                : 'Apply to Whole Track'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Pitch Control */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-900 dark:text-white">
                Pitch (Tone Height)
              </span>
              <span className="font-mono text-xs font-bold tabular-nums text-violet-600 dark:text-violet-400">
                {pitchSemitones === 0
                  ? 'Normal'
                  : `${pitchSemitones > 0 ? '+' : ''}${pitchSemitones} st`}
              </span>
            </div>
            <input
              type="range"
              aria-label="Pitch shift in semitones"
              data-testid="region-pitch-slider"
              min={-12}
              max={12}
              step={0.5}
              value={pitchSemitones}
              onChange={(e) => setPitchSemitones(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
              <span>Deeper (-12)</span>
              <span>Normal</span>
              <span>Higher (+12)</span>
            </div>
            <div className="flex gap-1.5 pt-1">
              {[-3, -1, 0, 1, 3].map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setPitchSemitones(st)}
                  className={`flex-1 rounded-md py-1 text-[11px] font-semibold ${
                    pitchSemitones === st
                      ? 'bg-violet-600 text-white'
                      : 'border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {st === 0 ? '0' : st > 0 ? `+${st}` : st}
                </button>
              ))}
            </div>
          </div>

          {/* Speed / Rate Control */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <Gauge className="h-3.5 w-3.5 text-blue-500" />
                <span>Speed / Rate</span>
              </span>
              <span className="font-mono text-xs font-bold tabular-nums text-blue-600 dark:text-blue-400">
                {speedRate.toFixed(2)}x
              </span>
            </div>
            <input
              type="range"
              aria-label="Speed or playback rate"
              data-testid="region-speed-slider"
              min={0.5}
              max={2.0}
              step={0.05}
              value={speedRate}
              onChange={(e) => setSpeedRate(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
              <span>Slower (0.5x)</span>
              <span>Normal</span>
              <span>Faster (2.0x)</span>
            </div>
            <label className="flex items-center gap-2 pt-1 text-[11px] text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={preservePitch}
                onChange={(e) => setPreservePitch(e.target.checked)}
                className="h-3.5 w-3.5 accent-blue-600"
              />
              <span>Keep voice natural (don&apos;t sound like a chipmunk)</span>
            </label>
          </div>

          {/* Volume / Gain Control */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <Volume2 className="h-3.5 w-3.5 text-emerald-500" />
                <span>Volume Boost / Cut</span>
              </span>
              <span className="font-mono text-xs font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                {gainDb === 0 ? 'Normal (0 dB)' : `${gainDb > 0 ? '+' : ''}${gainDb} dB`}
              </span>
            </div>
            <input
              type="range"
              aria-label="Volume gain in dB"
              data-testid="region-gain-slider"
              min={-24}
              max={24}
              step={1}
              value={gainDb}
              onChange={(e) => setGainDb(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
              <span>Quieter (-24 dB)</span>
              <span>Normal</span>
              <span>Louder (+24 dB)</span>
            </div>
            <div className="flex gap-1.5 pt-1">
              {[-6, -3, 0, 3, 6].map((db) => (
                <button
                  key={db}
                  type="button"
                  onClick={() => setGainDb(db)}
                  className={`flex-1 rounded-md py-1 text-[11px] font-semibold ${
                    gainDb === db
                      ? 'bg-emerald-600 text-white'
                      : 'border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {db === 0 ? '0' : db > 0 ? `+${db}` : db}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
