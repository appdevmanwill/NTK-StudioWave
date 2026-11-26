import {
  ArrowRight,
  CheckCircle2,
  Crown,
  Gauge,
  Radio,
  RefreshCw,
  Sliders,
  Sparkles,
  Waves,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  MasteringAnalysis,
  MasteringPlan,
  MasteringTarget,
  MultibandBandSettings,
} from '../types/audio';
import { MASTERING_TARGETS } from '../utils/masteringEngine';
import { audioBackend } from '../services/audioBackend';
import { Tooltip } from './Tooltip';

interface MasteringAssistantPanelProps {
  currentBuffer: AudioBuffer;
  isProcessing: boolean;
  onApplyProMaster: (plan: MasteringPlan) => Promise<{
    afterAnalysis: MasteringAnalysis;
    maxReductionDb: number;
  } | null>;
  onGoToExport: () => void;
}

function energyBarWidthPct(db: number): number {
  // Map -60 dB .. -6 dB cleanly into 6% .. 100%
  return Math.max(6, Math.min(100, ((db + 60) / 54) * 100));
}

export function MasteringAssistantPanel({
  currentBuffer,
  isProcessing,
  onApplyProMaster,
  onGoToExport,
}: MasteringAssistantPanelProps) {
  const [target, setTarget] = useState<MasteringTarget>('podcast');
  const [plan, setPlan] = useState<MasteringPlan>(() =>
    audioBackend.analyzeMastering(currentBuffer, 'podcast')
  );
  const [lastResult, setLastResult] = useState<{
    before: MasteringAnalysis;
    after: MasteringAnalysis;
    maxReductionDb: number;
    targetLabel: string;
  } | null>(null);

  // Re-analyze whenever the active AudioBuffer or selected destination target changes
  useEffect(() => {
    setPlan(audioBackend.analyzeMastering(currentBuffer, target));
  }, [currentBuffer, target]);

  const handleReanalyze = () => {
    setPlan(audioBackend.analyzeMastering(currentBuffer, target));
  };

  const updateBand = (
    bandKey: 'low' | 'mid' | 'high',
    patch: Partial<MultibandBandSettings>
  ) => {
    setPlan((prev) => ({
      ...prev,
      multiband: {
        ...prev.multiband,
        [bandKey]: {
          ...prev.multiband[bandKey],
          ...patch,
        },
      },
    }));
  };

  const handleRunProMaster = async () => {
    const beforeSnapshot = { ...plan.analysis };
    const res = await onApplyProMaster(plan);
    if (res) {
      setLastResult({
        before: beforeSnapshot,
        after: res.afterAnalysis,
        maxReductionDb: res.maxReductionDb,
        targetLabel: MASTERING_TARGETS[plan.target].label,
      });
    }
  };

  return (
    <section
      data-testid="mastering-assistant-panel"
      className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-5"
    >
      {/* Header + Primary One-Click Pro Master CTA */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-4">
        <div className="space-y-1 max-w-2xl">
          <h3 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Crown className="h-4.5 w-4.5 text-amber-500" />
            <span>Mastering Assistant</span>
            <Tooltip text="Analyzes your track's loudness, dynamic range, and spectral balance to auto-calculate optimal Multiband Compression, Stereo Enhancement, and Brickwall Limiting." />
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Automatically calculates studio-grade multiband compression, stereo width, and brickwall limiting for release-ready final exports.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleReanalyze}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-blue-500 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Re-Analyze</span>
          </button>

          <button
            type="button"
            data-testid="pro-master-button"
            disabled={isProcessing}
            onClick={handleRunProMaster}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            <Sparkles className="h-4 w-4" />
            <span>{isProcessing ? 'Mastering Audio...' : 'Pro Master'}</span>
          </button>
        </div>
      </div>

      {/* Destination Target Presets */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        {(Object.keys(MASTERING_TARGETS) as MasteringTarget[]).map((key) => {
          const item = MASTERING_TARGETS[key];
          const active = target === key;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => setTarget(key)}
              className={`rounded-xl border p-3 text-left transition-colors ${
                active
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 hover:border-slate-300 dark:hover:border-slate-700'
              }`}
            >
              <div className="text-xs font-bold text-slate-900 dark:text-white">{item.label}</div>
              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                {item.desc}
              </p>
            </button>
          );
        })}
      </div>

      {/* Track Acoustic Analysis & Auto-Diagnosis */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div
          data-testid="mastering-metrics"
          className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0D111A] p-4 space-y-3"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
              Current Track Analysis
            </span>
            <span className="font-mono text-[11px] tabular-nums text-blue-600 dark:text-blue-400">
              Target {plan.targetLufs} LUFS
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-2">
              <div className="text-[10px] text-slate-500">Loudness</div>
              <div className="font-mono text-sm font-bold tabular-nums text-slate-900 dark:text-white">
                {plan.analysis.integratedLufs.toFixed(1)}
              </div>
              <div className="text-[10px] font-mono text-slate-400">LUFS</div>
            </div>
            <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-2">
              <div className="text-[10px] text-slate-500">True Peak</div>
              <div className="font-mono text-sm font-bold tabular-nums text-slate-900 dark:text-white">
                {plan.analysis.peakDb.toFixed(1)}
              </div>
              <div className="text-[10px] font-mono text-slate-400">dBFS</div>
            </div>
            <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-2">
              <div className="text-[10px] text-slate-500">Dynamics</div>
              <div className="font-mono text-sm font-bold tabular-nums text-slate-900 dark:text-white">
                {plan.analysis.crestFactorDb.toFixed(1)}
              </div>
              <div className="text-[10px] font-mono text-slate-400">dB Crest</div>
            </div>
          </div>

          {/* 3-Band Spectral Energy Balance */}
          <div className="space-y-1.5 pt-1">
            {[
              { label: 'Low (< 250 Hz)', db: plan.analysis.lowEnergyDb, color: 'bg-blue-500' },
              { label: 'Mid (250–3.2k)', db: plan.analysis.midEnergyDb, color: 'bg-indigo-500' },
              { label: 'High (> 3.2 kHz)', db: plan.analysis.highEnergyDb, color: 'bg-emerald-500' },
            ].map((b) => (
              <div key={b.label} className="space-y-0.5 text-[11px]">
                <div className="flex justify-between font-mono tabular-nums text-slate-600 dark:text-slate-400">
                  <span>{b.label}</span>
                  <span>{b.db.toFixed(1)} dB</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${b.color}`}
                    style={{ width: `${energyBarWidthPct(b.db)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Assistant Auto-Calculated Engineering Notes */}
        <div className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0D111A] p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
              <Radio className="h-3.5 w-3.5 text-blue-500" />
              <span>Auto-Calculated Mastering Chain</span>
            </span>
            <span className="text-[11px] font-mono text-slate-500">
              {plan.analysis.isMonoSource ? 'Mono → Stereo Master' : `Stereo Corr ${plan.analysis.stereoCorrelation}`}
            </span>
          </div>

          <ul className="space-y-2 text-xs text-slate-600 dark:text-slate-300">
            {plan.recommendations.map((note, idx) => (
              <li key={idx} className="flex items-start gap-2 leading-relaxed">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* 3 Calculated Modules: Multiband Compressor, Stereo Enhancer, Brickwall Limiter */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Module 1: 3-Band Multiband Compressor (7 cols) */}
        <div className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="font-display text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
              <Sliders className="h-3.5 w-3.5 text-blue-500" />
              <span>1. 3-Band Multiband Compressor</span>
            </span>
            <span className="text-[11px] font-mono text-slate-500">
              X-Over {plan.multiband.lowCutoffHz} Hz / {(plan.multiband.highCutoffHz / 1000).toFixed(1)} kHz
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {(['low', 'mid', 'high'] as const).map((bandKey) => {
              const b = plan.multiband[bandKey];
              return (
                <div
                  key={bandKey}
                  data-testid={`master-band-${bandKey}`}
                  className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0D111A] p-3 space-y-2"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-slate-900 dark:text-white">{b.name}</span>
                    <span className="font-mono text-[10px] text-slate-500">{b.rangeLabel}</span>
                  </div>

                  <div className="space-y-1 text-[11px]">
                    <div className="flex justify-between font-mono tabular-nums">
                      <span className="text-slate-500">Thresh</span>
                      <span className="text-slate-800 dark:text-slate-200">{b.thresholdDb} dB</span>
                    </div>
                    <input
                      type="range"
                      aria-label={`${b.name} band threshold`}
                      min={-36}
                      max={-6}
                      step={0.5}
                      value={b.thresholdDb}
                      onChange={(e) => updateBand(bandKey, { thresholdDb: Number(e.target.value) })}
                      className="w-full"
                    />
                  </div>

                  <div className="space-y-1 text-[11px]">
                    <div className="flex justify-between font-mono tabular-nums">
                      <span className="text-slate-500">Ratio</span>
                      <span className="text-slate-800 dark:text-slate-200">{b.ratio.toFixed(1)}:1</span>
                    </div>
                    <input
                      type="range"
                      aria-label={`${b.name} band ratio`}
                      min={1.2}
                      max={6}
                      step={0.1}
                      value={b.ratio}
                      onChange={(e) => updateBand(bandKey, { ratio: Number(e.target.value) })}
                      className="w-full"
                    />
                  </div>

                  <div className="space-y-1 text-[11px]">
                    <div className="flex justify-between font-mono tabular-nums">
                      <span className="text-slate-500">Makeup</span>
                      <span className="text-blue-600 dark:text-blue-400">
                        {b.makeupGainDb >= 0 ? '+' : ''}
                        {b.makeupGainDb.toFixed(1)} dB
                      </span>
                    </div>
                    <input
                      type="range"
                      aria-label={`${b.name} band makeup gain`}
                      min={-4}
                      max={6}
                      step={0.2}
                      value={b.makeupGainDb}
                      onChange={(e) => updateBand(bandKey, { makeupGainDb: Number(e.target.value) })}
                      className="w-full"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Module 2 & 3: Stereo Enhancer + Brickwall Limiter (5 cols) */}
        <div className="lg:col-span-5 flex flex-col gap-4">
          {/* Stereo Enhancer */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-display text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <Waves className="h-3.5 w-3.5 text-indigo-500" />
                <span>2. Stereo Enhancer</span>
              </span>
              <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  aria-label="Enable Stereo Enhancer"
                  checked={plan.stereoEnhancer.enabled}
                  onChange={(e) =>
                    setPlan((prev) => ({
                      ...prev,
                      stereoEnhancer: { ...prev.stereoEnhancer, enabled: e.target.checked },
                    }))
                  }
                  className="accent-indigo-600"
                />
                <span>Active</span>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3 text-[11px]">
              <div className="space-y-1">
                <div className="flex justify-between font-mono tabular-nums">
                  <span className="text-slate-500">Width</span>
                  <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                    {Math.round(plan.stereoEnhancer.width * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Stereo Enhancer Width"
                  min={1.0}
                  max={1.5}
                  step={0.02}
                  value={plan.stereoEnhancer.width}
                  onChange={(e) =>
                    setPlan((prev) => ({
                      ...prev,
                      stereoEnhancer: { ...prev.stereoEnhancer, width: Number(e.target.value) },
                    }))
                  }
                  className="w-full"
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between font-mono tabular-nums">
                  <span className="text-slate-500">Mono Bass</span>
                  <span className="font-semibold text-slate-700 dark:text-slate-200">
                    &lt; {plan.stereoEnhancer.monoBelowHz} Hz
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Stereo Enhancer Mono Bass Frequency"
                  min={80}
                  max={250}
                  step={10}
                  value={plan.stereoEnhancer.monoBelowHz}
                  onChange={(e) =>
                    setPlan((prev) => ({
                      ...prev,
                      stereoEnhancer: {
                        ...prev.stereoEnhancer,
                        monoBelowHz: Number(e.target.value),
                      },
                    }))
                  }
                  className="w-full"
                />
              </div>
            </div>
          </div>

          {/* Brickwall Limiter */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-display text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <Gauge className="h-3.5 w-3.5 text-amber-500" />
                <span>3. Brickwall Limiter</span>
              </span>
              <span className="font-mono text-[11px] text-amber-600 dark:text-amber-400">
                Zero-Clip Guard
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 text-[11px]">
              <div className="space-y-1">
                <div className="flex justify-between font-mono tabular-nums">
                  <span className="text-slate-500">Drive</span>
                  <span className="font-semibold text-amber-600 dark:text-amber-400">
                    {plan.limiter.driveDb >= 0 ? '+' : ''}
                    {plan.limiter.driveDb.toFixed(1)} dB
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Mastering Limiter Drive"
                  min={-4}
                  max={14}
                  step={0.5}
                  value={plan.limiter.driveDb}
                  onChange={(e) =>
                    setPlan((prev) => ({
                      ...prev,
                      limiter: { ...prev.limiter, driveDb: Number(e.target.value) },
                    }))
                  }
                  className="w-full"
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between font-mono tabular-nums">
                  <span className="text-slate-500">Ceiling</span>
                  <span className="font-semibold text-slate-700 dark:text-slate-200">
                    {plan.limiter.ceilingDb.toFixed(1)} dBTP
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Mastering Limiter Ceiling"
                  min={-2.0}
                  max={-0.1}
                  step={0.1}
                  value={plan.limiter.ceilingDb}
                  onChange={(e) =>
                    setPlan((prev) => ({
                      ...prev,
                      limiter: { ...prev.limiter, ceilingDb: Number(e.target.value) },
                    }))
                  }
                  className="w-full"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Post-Master Verification Summary + Direct Export Shortcut */}
      {lastResult && (
        <div
          data-testid="mastering-result-banner"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-xs"
        >
          <div className="flex items-center gap-2.5 text-emerald-800 dark:text-emerald-200">
            <CheckCircle2 className="h-4.5 w-4.5 text-emerald-500 shrink-0" />
            <span>
              <strong>Pro Master Applied ({lastResult.targetLabel}):</strong> Loudness{' '}
              <span className="font-mono">
                {lastResult.before.integratedLufs.toFixed(1)} → {lastResult.after.integratedLufs.toFixed(1)} LUFS
              </span>{' '}
              · True Peak capped at{' '}
              <span className="font-mono">{lastResult.after.peakDb.toFixed(1)} dBFS</span> · Undo anytime with Ctrl+Z.
            </span>
          </div>
          <button
            type="button"
            onClick={onGoToExport}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 whitespace-nowrap"
          >
            <span>Export Mastered Audio</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </section>
  );
}
