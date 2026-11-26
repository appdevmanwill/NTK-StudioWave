import { AlertTriangle, Headphones, Mic, ShieldCheck, Sliders, Volume2 } from 'lucide-react';
import type { NtkEqPresetId, NtkLiveConsoleSettings } from '../types';
import {
  NTK_7BAND_EQ_SPECS,
  NTK_STUDIO_PRESETS,
  applyPresetToConsole,
} from '../utils/ntkAudioUtils';

interface LiveEqConsoleProps {
  settings: NtkLiveConsoleSettings;
  onChange: (next: NtkLiveConsoleSettings) => void;
  devices: MediaDeviceInfo[];
  selectedDeviceId: string;
  onSelectDevice: (id: string) => void;
  clipping: boolean;
  gateOpen: boolean;
  isRecording: boolean;
}

const PRESET_ORDER: NtkEqPresetId[] = [
  'clear-office',
  'cut-rumble',
  'soften-music',
  'broadcast-radio',
  'flat-raw',
];

export function LiveEqConsole({
  settings,
  onChange,
  devices,
  selectedDeviceId,
  onSelectDevice,
  clipping,
  gateOpen,
  isRecording,
}: LiveEqConsoleProps) {
  const handleBandChange = (idx: number, val: number) => {
    const nextBands = [...settings.eqBandsDb] as [
      number,
      number,
      number,
      number,
      number,
      number,
      number
    ];
    nextBands[idx] = val;
    onChange({ ...settings, eqBandsDb: nextBands });
  };

  return (
    <section
      aria-label="Live Sound Engineering Console"
      data-testid="ntk-live-eq-console"
      className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-4 sm:p-5 space-y-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600/10 text-blue-600 dark:text-blue-400">
            <Sliders className="h-4.5 w-4.5" />
          </span>
          <div>
            <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">
              Live Sound Engineering Console
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Real-time 7-band EQ, noise gate, compressor &amp; limiter — active during recording and playback.
            </p>
          </div>
        </div>

        {/* Safety Mode Toggle */}
        <div
          role="group"
          aria-label="EQ recording safety mode"
          className="inline-flex rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 p-0.5 text-xs"
        >
          <button
            type="button"
            disabled={isRecording}
            onClick={() => onChange({ ...settings, bakeEqLive: false })}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-semibold transition-colors disabled:opacity-60 ${
              !settings.bakeEqLive
                ? 'bg-white dark:bg-slate-800 text-emerald-700 dark:text-emerald-300 shadow-xs'
                : 'text-slate-600 dark:text-slate-400'
            }`}
            title="Saves an untouched raw master and applies EQ during playback & export so you can always remix."
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>Keep Raw Master (Safe)</span>
          </button>
          <button
            type="button"
            disabled={isRecording}
            onClick={() => onChange({ ...settings, bakeEqLive: true })}
            className={`rounded-lg px-2.5 py-1.5 font-semibold transition-colors disabled:opacity-60 ${
              settings.bakeEqLive
                ? 'bg-white dark:bg-slate-800 text-blue-700 dark:text-blue-300 shadow-xs'
                : 'text-slate-600 dark:text-slate-400'
            }`}
            title="Records the live EQ & dynamics directly into the main track (raw backup still preserved)."
          >
            Bake EQ Live
          </button>
        </div>
      </div>

      {/* 1-Click Studio Presets */}
      <div className="space-y-2">
        <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
          1-Click Studio Presets
        </div>
        <div className="flex flex-wrap gap-2">
          {PRESET_ORDER.map((id) => {
            const p = NTK_STUDIO_PRESETS[id];
            const active = settings.presetId === id;
            return (
              <button
                key={id}
                type="button"
                data-testid={`ntk-eq-preset-${id}`}
                onClick={() => onChange(applyPresetToConsole(settings, id))}
                title={p.description}
                className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  active
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {p.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* 7-Band Live Equalizer */}
      <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-3.5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            7-Band Live Equalizer (-12 dB to +12 dB)
          </span>
          <button
            type="button"
            onClick={() =>
              onChange({ ...settings, presetId: 'flat-raw', eqBandsDb: [0, 0, 0, 0, 0, 0, 0] })
            }
            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
          >
            Reset Flat
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {NTK_7BAND_EQ_SPECS.map((band, idx) => {
            const val = settings.eqBandsDb[idx] ?? 0;
            return (
              <div
                key={band.freqHz}
                className="flex flex-col items-center rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-[#131822] p-2.5 text-center"
              >
                <span className="font-mono text-xs font-bold text-slate-900 dark:text-white">
                  {band.shortLabel}
                </span>
                <span className="text-[10px] text-slate-500 dark:text-slate-400 leading-tight mt-0.5 min-h-[24px] flex items-center">
                  {band.roleLabel}
                </span>
                <input
                  type="range"
                  aria-label={`${band.shortLabel} ${band.roleLabel}`}
                  min={-12}
                  max={12}
                  step={0.5}
                  value={val}
                  onChange={(e) => handleBandChange(idx, Number(e.target.value))}
                  className="mt-2 w-full accent-blue-600 cursor-pointer"
                />
                <span
                  className={`mt-1 font-mono text-[11px] font-semibold tabular-nums ${
                    val > 0
                      ? 'text-blue-600 dark:text-blue-400'
                      : val < 0
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1)} dB
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Dynamics, Input Gain, Mic Selector & Live Headphone Monitor */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Input Gain + Clipping Warning */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
              <Volume2 className="h-3.5 w-3.5 text-blue-600" />
              Input Gain
            </span>
            <span className="font-mono font-bold tabular-nums text-slate-900 dark:text-white">
              {settings.inputGainDb > 0 ? `+${settings.inputGainDb}` : settings.inputGainDb} dB
            </span>
          </div>
          <input
            type="range"
            aria-label="Input Gain in dB"
            min={-12}
            max={18}
            step={1}
            value={settings.inputGainDb}
            onChange={(e) => onChange({ ...settings, inputGainDb: Number(e.target.value) })}
            className="w-full accent-blue-600"
          />
          {clipping ? (
            <div className="flex items-center gap-1.5 rounded-lg bg-rose-500/15 px-2 py-1 text-[11px] font-semibold text-rose-700 dark:text-rose-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>Clipping! Lower Input Gain</span>
            </div>
          ) : (
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              Clean headroom — no distortion
            </div>
          )}
        </div>

        {/* Real-Time Noise Gate */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <label className="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.noiseGateEnabled}
                onChange={(e) => onChange({ ...settings, noiseGateEnabled: e.target.checked })}
                className="rounded accent-blue-600"
              />
              <span>Noise Gate</span>
            </label>
            <span
              className={`font-mono text-[11px] font-semibold ${
                !settings.noiseGateEnabled
                  ? 'text-slate-400'
                  : gateOpen
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-amber-600 dark:text-amber-400'
              }`}
            >
              {!settings.noiseGateEnabled ? 'Off' : gateOpen ? 'Open' : 'Gated'}
            </span>
          </div>
          <input
            type="range"
            aria-label="Noise Gate Threshold"
            min={-65}
            max={-20}
            step={1}
            disabled={!settings.noiseGateEnabled}
            value={settings.noiseGateThresholdDb}
            onChange={(e) =>
              onChange({ ...settings, noiseGateThresholdDb: Number(e.target.value) })
            }
            className="w-full accent-blue-600 disabled:opacity-40"
          />
          <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
            Threshold: {settings.noiseGateThresholdDb} dB
          </div>
        </div>

        {/* Compressor & Limiter */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <label className="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.compressorEnabled}
                onChange={(e) => onChange({ ...settings, compressorEnabled: e.target.checked })}
                className="rounded accent-blue-600"
              />
              <span>Compressor</span>
            </label>
            <label className="flex items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.limiterEnabled}
                onChange={(e) => onChange({ ...settings, limiterEnabled: e.target.checked })}
                className="rounded accent-blue-600"
              />
              <span>Limiter</span>
            </label>
          </div>
          <input
            type="range"
            aria-label="Compressor Threshold"
            min={-36}
            max={-6}
            step={1}
            disabled={!settings.compressorEnabled}
            value={settings.compressorThresholdDb}
            onChange={(e) =>
              onChange({ ...settings, compressorThresholdDb: Number(e.target.value) })
            }
            className="w-full accent-blue-600 disabled:opacity-40"
          />
          <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
            Leveling threshold: {settings.compressorThresholdDb} dB
          </div>
        </div>

        {/* Mic Input Selector + Live Headphone Monitor */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-3 space-y-2">
          <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200">
            <Mic className="h-3.5 w-3.5 text-blue-600" />
            <span>Microphone Input</span>
          </label>
          <select
            aria-label="Choose microphone input"
            value={selectedDeviceId}
            disabled={isRecording}
            onChange={(e) => onSelectDevice(e.target.value)}
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-100"
          >
            <option value="">System Default Microphone</option>
            {devices.map((d, idx) => (
              <option key={d.deviceId || idx} value={d.deviceId}>
                {d.label || `Microphone ${idx + 1}`}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2 pt-1 text-xs font-semibold text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.liveMonitorEnabled}
              onChange={(e) => onChange({ ...settings, liveMonitorEnabled: e.target.checked })}
              className="rounded accent-blue-600"
            />
            <Headphones className="h-3.5 w-3.5 text-blue-600" />
            <span>Live Headphone Monitor</span>
          </label>
          {settings.liveMonitorEnabled && (
            <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300 leading-snug">
              Use headphones to prevent speaker feedback while monitoring live.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
