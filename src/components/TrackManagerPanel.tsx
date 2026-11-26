import {
  ChevronDown,
  ChevronUp,
  Copy,
  Layers,
  Plus,
  Radio,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { LibraryRecording, OverlayTrack, TrackEqSettings } from '../types/audio';
import {
  DEFAULT_TRACK_EQ,
  computeWaveformPeaks,
  formatDuration,
  isTrackEqActive,
  mixToMono,
} from '../utils/audioDsp';
import { extractChannels } from '../services/audioBackend';
import { computeTrackPlaybackParams } from '../utils/pitchCorrection';
import { STARTER_SOUND_PACK } from '../utils/sampleSynthesizer';
import { Tooltip } from './Tooltip';

export interface MainTrackControlState {
  gain: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  eq: TrackEqSettings;
}

interface TrackManagerPanelProps {
  mainTitle: string;
  mainBuffer: AudioBuffer;
  mainControl: MainTrackControlState;
  onChangeMainControl: (next: MainTrackControlState) => void;
  overlayTracks: OverlayTrack[];
  onUpdateOverlayTrack: (id: string, patch: Partial<OverlayTrack>) => void;
  onRemoveOverlayTrack: (id: string) => void;
  onUploadOverlayFile: (file: File) => Promise<void>;
  onAddStarterOverlay: (packItemId: string) => void;
  onDuplicateMainTrack: () => void;
  onAddLibraryOverlay: (recordingId: string) => Promise<void>;
  onBounceMixdown: () => Promise<void>;
  libraryRecordings: LibraryRecording[];
  isProcessing: boolean;
  currentTime: number;
}

function formatPanLabel(pan: number): string {
  if (Math.abs(pan) < 0.03) return 'C';
  const pct = Math.round(Math.abs(pan) * 100);
  return pan < 0 ? `L${pct}` : `R${pct}`;
}

function formatDbSigned(val: number): string {
  const rounded = Math.round(val * 10) / 10;
  if (Math.abs(rounded) < 0.05) return '0 dB';
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} dB`;
}

function formatFreqLabel(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
}

function TrackEqControls({
  trackKey,
  trackLabel,
  eq,
  onChange,
  isOpen,
  onToggleOpen,
}: {
  trackKey: string;
  trackLabel: string;
  eq: TrackEqSettings;
  onChange: (next: TrackEqSettings) => void;
  isOpen: boolean;
  onToggleOpen: () => void;
}) {
  const active = isTrackEqActive(eq);
  const summaryText = active
    ? `${eq.lowGainDb >= 0 ? '+' : ''}${eq.lowGainDb.toFixed(0)} / ${eq.midGainDb >= 0 ? '+' : ''}${eq.midGainDb.toFixed(0)} / ${eq.highGainDb >= 0 ? '+' : ''}${eq.highGainDb.toFixed(0)} dB`
    : eq.enabled
    ? 'Flat'
    : 'Bypassed';

  return (
    <div className="border-t border-slate-200/70 dark:border-slate-800/80 pt-2.5 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          data-testid={`track-eq-toggle-${trackKey}`}
          aria-expanded={isOpen}
          onClick={onToggleOpen}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
            active
              ? 'border-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-300'
              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:border-blue-500/50'
          }`}
        >
          <SlidersHorizontal className="h-3 w-3" />
          <span>3-Band EQ</span>
          <span
            data-testid={`track-eq-summary-${trackKey}`}
            className="font-mono text-[10px] tabular-nums opacity-85"
          >
            ({summaryText})
          </span>
          {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>

        {isOpen && (
          <div className="flex items-center gap-2.5">
            <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                aria-label={`${trackLabel} 3-Band EQ enabled`}
                checked={eq.enabled}
                onChange={(e) => onChange({ ...eq, enabled: e.target.checked })}
                className="rounded border-slate-300 dark:border-slate-700 accent-blue-600"
              />
              <span>Active</span>
            </label>
            <button
              type="button"
              onClick={() => onChange({ ...DEFAULT_TRACK_EQ, enabled: eq.enabled })}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400"
            >
              <RotateCcw className="h-2.5 w-2.5" />
              <span>Reset Flat</span>
            </button>
          </div>
        )}
      </div>

      {isOpen && (
        <div
          data-testid={`track-eq-panel-${trackKey}`}
          className={`grid grid-cols-1 md:grid-cols-3 gap-3 rounded-lg border border-slate-200/80 dark:border-slate-800 bg-white/80 dark:bg-[#0D111A] p-3 transition-opacity ${
            eq.enabled ? 'opacity-100' : 'opacity-55'
          }`}
        >
          {/* Low Shelf Band */}
          <div className="space-y-2 rounded-md border border-slate-100 dark:border-slate-800/80 p-2.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-bold text-slate-800 dark:text-slate-200">Low Shelf</span>
              <span className="font-mono tabular-nums font-semibold text-blue-600 dark:text-blue-400">
                {formatDbSigned(eq.lowGainDb)}
              </span>
            </div>
            <input
              type="range"
              aria-label={`${trackLabel} Low Shelf Gain`}
              min={-12}
              max={12}
              step={0.5}
              value={eq.lowGainDb}
              onChange={(e) => onChange({ ...eq, lowGainDb: Number(e.target.value) })}
              className="w-full"
            />
            <div className="flex items-center justify-between gap-2 text-[10px] text-slate-500 dark:text-slate-400">
              <span>Freq</span>
              <input
                type="range"
                aria-label={`${trackLabel} Low Shelf Frequency`}
                min={60}
                max={400}
                step={10}
                value={eq.lowFreqHz}
                onChange={(e) => onChange({ ...eq, lowFreqHz: Number(e.target.value) })}
                className="flex-1"
              />
              <span className="w-12 text-right font-mono tabular-nums">
                {formatFreqLabel(eq.lowFreqHz)}
              </span>
            </div>
          </div>

          {/* Mid Peaking Band */}
          <div className="space-y-2 rounded-md border border-slate-100 dark:border-slate-800/80 p-2.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-bold text-slate-800 dark:text-slate-200">Mid Band</span>
              <span className="font-mono tabular-nums font-semibold text-indigo-600 dark:text-indigo-400">
                {formatDbSigned(eq.midGainDb)}
              </span>
            </div>
            <input
              type="range"
              aria-label={`${trackLabel} Mid Band Gain`}
              min={-12}
              max={12}
              step={0.5}
              value={eq.midGainDb}
              onChange={(e) => onChange({ ...eq, midGainDb: Number(e.target.value) })}
              className="w-full"
            />
            <div className="flex items-center justify-between gap-2 text-[10px] text-slate-500 dark:text-slate-400">
              <span>Freq</span>
              <input
                type="range"
                aria-label={`${trackLabel} Mid Band Frequency`}
                min={400}
                max={4500}
                step={50}
                value={eq.midFreqHz}
                onChange={(e) => onChange({ ...eq, midFreqHz: Number(e.target.value) })}
                className="flex-1"
              />
              <span className="w-12 text-right font-mono tabular-nums">
                {formatFreqLabel(eq.midFreqHz)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 text-[10px] text-slate-500 dark:text-slate-400">
              <span>Q</span>
              <input
                type="range"
                aria-label={`${trackLabel} Mid Band Q`}
                min={0.5}
                max={4.0}
                step={0.1}
                value={eq.midQ}
                onChange={(e) => onChange({ ...eq, midQ: Number(e.target.value) })}
                className="flex-1"
              />
              <span className="w-12 text-right font-mono tabular-nums">{eq.midQ.toFixed(1)}</span>
            </div>
          </div>

          {/* High Shelf Band */}
          <div className="space-y-2 rounded-md border border-slate-100 dark:border-slate-800/80 p-2.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-bold text-slate-800 dark:text-slate-200">High Shelf</span>
              <span className="font-mono tabular-nums font-semibold text-emerald-600 dark:text-emerald-400">
                {formatDbSigned(eq.highGainDb)}
              </span>
            </div>
            <input
              type="range"
              aria-label={`${trackLabel} High Shelf Gain`}
              min={-12}
              max={12}
              step={0.5}
              value={eq.highGainDb}
              onChange={(e) => onChange({ ...eq, highGainDb: Number(e.target.value) })}
              className="w-full"
            />
            <div className="flex items-center justify-between gap-2 text-[10px] text-slate-500 dark:text-slate-400">
              <span>Freq</span>
              <input
                type="range"
                aria-label={`${trackLabel} High Shelf Frequency`}
                min={3000}
                max={14000}
                step={250}
                value={eq.highFreqHz}
                onChange={(e) => onChange({ ...eq, highFreqHz: Number(e.target.value) })}
                className="flex-1"
              />
              <span className="w-12 text-right font-mono tabular-nums">
                {formatFreqLabel(eq.highFreqHz)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MiniTrackWaveform({
  buffer,
  color,
  offsetSec,
  timelineDuration,
  dimmed,
}: {
  buffer: AudioBuffer;
  color: string;
  offsetSec: number;
  timelineDuration: number;
  dimmed: boolean;
}) {
  const bars = useMemo(() => {
    const mono = mixToMono(extractChannels(buffer));
    const { mins, maxs } = computeWaveformPeaks(mono, 72);
    const out: number[] = [];
    for (let i = 0; i < maxs.length; i++) {
      out.push(Math.max(Math.abs(mins[i] ?? 0), Math.abs(maxs[i] ?? 0)));
    }
    return out;
  }, [buffer]);

  const leftPct = Math.min(92, (Math.max(0, offsetSec) / Math.max(0.1, timelineDuration)) * 100);
  const widthPct = Math.max(
    6,
    Math.min(100 - leftPct, (buffer.duration / Math.max(0.1, timelineDuration)) * 100)
  );

  return (
    <div className="relative h-10 w-full rounded-lg bg-slate-100 dark:bg-[#0B0F17] border border-slate-200/70 dark:border-slate-800/90 overflow-hidden">
      <div
        className={`absolute top-0.5 bottom-0.5 rounded-md flex items-center gap-[1px] px-1 overflow-hidden transition-opacity ${
          dimmed ? 'opacity-30' : 'opacity-95'
        }`}
        style={{
          left: `${leftPct}%`,
          width: `${widthPct}%`,
          backgroundColor: `${color}18`,
          border: `1px solid ${color}55`,
        }}
      >
        {bars.map((p, idx) => (
          <div
            key={idx}
            className="flex-1 rounded-full"
            style={{
              height: `${Math.max(12, Math.min(92, p * 100))}%`,
              backgroundColor: color,
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function TrackManagerPanel({
  mainTitle,
  mainBuffer,
  mainControl,
  onChangeMainControl,
  overlayTracks,
  onUpdateOverlayTrack,
  onRemoveOverlayTrack,
  onUploadOverlayFile,
  onAddStarterOverlay,
  onDuplicateMainTrack,
  onAddLibraryOverlay,
  onBounceMixdown,
  libraryRecordings,
  isProcessing,
  currentTime,
}: TrackManagerPanelProps) {
  const [expandedEqIds, setExpandedEqIds] = useState<Record<string, boolean>>({});

  const toggleEqDrawer = (id: string) => {
    setExpandedEqIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const allTracksForRouting = useMemo(
    () => [
      {
        id: 'main-track',
        gain: mainControl.gain,
        pan: mainControl.pan,
        muted: mainControl.muted,
        solo: mainControl.solo,
      },
      ...overlayTracks.map((t) => ({
        id: t.id,
        gain: t.gain,
        pan: t.pan,
        muted: t.muted,
        solo: t.solo,
      })),
    ],
    [mainControl, overlayTracks]
  );

  const routing = useMemo(
    () => computeTrackPlaybackParams(allTracksForRouting),
    [allTracksForRouting]
  );

  const timelineDuration = useMemo(
    () =>
      Math.max(
        mainBuffer.duration,
        ...overlayTracks.map((t) => Math.max(0, t.offsetSec) + t.buffer.duration)
      ),
    [mainBuffer.duration, overlayTracks]
  );

  const anySolo = allTracksForRouting.some((t) => t.solo);
  const activeLibrary = libraryRecordings.filter((r) => !r.deletedAt);

  return (
    <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-4">
      {/* Header + Quick Add Controls */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-4">
        <div>
          <h3 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
            <Layers className="h-4.5 w-4.5 text-blue-500" />
            <span>Multi-Track Overlay Manager</span>
            <Tooltip text="Layer multiple audio tracks with live per-track Volume Gain, Stereo Panning, 3-Band Parametric EQ, and Solo/Mute controls." />
          </h3>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {overlayTracks.length + 1} track{overlayTracks.length === 0 ? '' : 's'} active · Timeline{' '}
            <span className="font-mono tabular-nums">{formatDuration(timelineDuration, true)}</span>
            {anySolo && (
              <span className="ml-2 font-semibold text-amber-600 dark:text-amber-400">
                · Solo Mode Active
              </span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:border-blue-500 transition-colors">
            <Upload className="h-3.5 w-3.5 text-blue-500" />
            <span>Overlay Audio File</span>
            <input
              type="file"
              accept="audio/*"
              aria-label="Upload audio file to overlay track"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUploadOverlayFile(f);
                e.target.value = '';
              }}
            />
          </label>

          <button
            type="button"
            onClick={onDuplicateMainTrack}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:border-blue-500 transition-colors"
          >
            <Copy className="h-3.5 w-3.5 text-indigo-500" />
            <span>Duplicate Vocal Track</span>
          </button>

          {activeLibrary.length > 0 && (
            <select
              aria-label="Overlay recording from library"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) {
                  onAddLibraryOverlay(e.target.value);
                  e.target.value = '';
                }
              }}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-700 dark:text-slate-200"
            >
              <option value="">+ Overlay from Library...</option>
              {activeLibrary.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title} ({formatDuration(r.duration)})
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            disabled={isProcessing || overlayTracks.length === 0}
            onClick={onBounceMixdown}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-40 whitespace-nowrap"
          >
            <Radio className="h-3.5 w-3.5" />
            <span>{isProcessing ? 'Bouncing...' : 'Bounce Mixdown to Main'}</span>
          </button>
        </div>
      </div>

      {/* Built-In Starter Track Overlays (1-click offline overlays) */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-slate-500 dark:text-slate-400">
          Quick Overlay Bed / SFX (at {formatDuration(currentTime, true)}):
        </span>
        {STARTER_SOUND_PACK.slice(0, 5).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onAddStarterOverlay(item.id)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:border-blue-500 transition-colors"
          >
            <Plus className="h-3 w-3 text-blue-500" />
            <span>{item.name}</span>
          </button>
        ))}
      </div>

      {/* Track List */}
      <div className="space-y-3" data-testid="track-manager-list">
        {/* Track 1: Main Track */}
        {(() => {
          const mainRoute = routing['main-track'];
          const dimmed = !mainRoute?.audible;
          return (
            <div
              data-testid="track-row-main"
              className={`rounded-xl border p-4 space-y-3 transition-colors ${
                mainControl.solo
                  ? 'border-amber-500/60 bg-amber-500/5'
                  : 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="h-3 w-3 rounded-full bg-blue-500 shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-slate-900 dark:text-white truncate">
                        Track 1 · {mainTitle}
                      </span>
                      <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
                        Main
                      </span>
                    </div>
                    <div className="text-[11px] font-mono tabular-nums text-slate-500">
                      {formatDuration(mainBuffer.duration, true)} · {mainBuffer.numberOfChannels}ch ·{' '}
                      {Math.round(mainBuffer.sampleRate / 1000)} kHz
                    </div>
                  </div>
                </div>

                {/* Solo & Mute Toggles */}
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-pressed={mainControl.solo}
                    aria-label={`Solo ${mainTitle}`}
                    onClick={() =>
                      onChangeMainControl({ ...mainControl, solo: !mainControl.solo })
                    }
                    className={`flex h-7 w-7 items-center justify-center rounded-md border text-xs font-bold transition-colors ${
                      mainControl.solo
                        ? 'border-amber-500 bg-amber-500 text-slate-950'
                        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:border-amber-500'
                    }`}
                  >
                    S
                  </button>
                  <button
                    type="button"
                    aria-pressed={mainControl.muted}
                    aria-label={`Mute ${mainTitle}`}
                    onClick={() =>
                      onChangeMainControl({ ...mainControl, muted: !mainControl.muted })
                    }
                    className={`flex h-7 w-7 items-center justify-center rounded-md border text-xs font-bold transition-colors ${
                      mainControl.muted
                        ? 'border-rose-500 bg-rose-600 text-white'
                        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:border-rose-500'
                    }`}
                  >
                    M
                  </button>
                </div>
              </div>

              <MiniTrackWaveform
                buffer={mainBuffer}
                color="#3b82f6"
                offsetSec={0}
                timelineDuration={timelineDuration}
                dimmed={dimmed}
              />

              {/* Volume Gain & Stereo Pan Controls */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-0.5">
                <div className="flex items-center gap-2.5 text-xs">
                  {mainControl.muted || mainControl.gain === 0 ? (
                    <VolumeX className="h-3.5 w-3.5 text-rose-500 shrink-0" />
                  ) : (
                    <Volume2 className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                  )}
                  <span className="w-10 text-slate-500 dark:text-slate-400">Gain</span>
                  <input
                    type="range"
                    aria-label="Main track volume gain"
                    min={0}
                    max={1.5}
                    step={0.05}
                    value={mainControl.gain}
                    onChange={(e) =>
                      onChangeMainControl({ ...mainControl, gain: Number(e.target.value) })
                    }
                    className="flex-1"
                  />
                  <span className="w-11 text-right font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-200">
                    {Math.round(mainControl.gain * 100)}%
                  </span>
                </div>

                <div className="flex items-center gap-2.5 text-xs">
                  <span className="w-10 text-slate-500 dark:text-slate-400">Pan</span>
                  <span className="text-[10px] font-mono text-slate-400">L</span>
                  <input
                    type="range"
                    aria-label="Main track panning"
                    min={-1}
                    max={1}
                    step={0.05}
                    value={mainControl.pan}
                    onChange={(e) =>
                      onChangeMainControl({ ...mainControl, pan: Number(e.target.value) })
                    }
                    className="flex-1"
                  />
                  <span className="text-[10px] font-mono text-slate-400">R</span>
                  <button
                    type="button"
                    title="Click to center pan"
                    onClick={() => onChangeMainControl({ ...mainControl, pan: 0 })}
                    className="w-11 text-right font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-200 hover:text-blue-500"
                  >
                    {formatPanLabel(mainControl.pan)}
                  </button>
                </div>
              </div>

              {/* Per-Track 3-Band Parametric Equalizer */}
              <TrackEqControls
                trackKey="main"
                trackLabel="Main track"
                eq={mainControl.eq}
                onChange={(nextEq) => onChangeMainControl({ ...mainControl, eq: nextEq })}
                isOpen={Boolean(expandedEqIds['main-track'])}
                onToggleOpen={() => toggleEqDrawer('main-track')}
              />
            </div>
          );
        })()}

        {/* Overlaid Audio Buffer Tracks */}
        {overlayTracks.map((track, idx) => {
          const trackRoute = routing[track.id];
          const dimmed = !trackRoute?.audible;
          const trackEq = track.eq ?? DEFAULT_TRACK_EQ;
          return (
            <div
              key={track.id}
              data-testid={`track-row-overlay-${idx}`}
              className={`rounded-xl border p-4 space-y-3 transition-colors ${
                track.solo
                  ? 'border-amber-500/60 bg-amber-500/5'
                  : 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className="h-3 w-3 rounded-full shrink-0"
                    style={{ backgroundColor: track.color }}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        aria-label={`Track ${idx + 2} name`}
                        value={track.name}
                        onChange={(e) => onUpdateOverlayTrack(track.id, { name: e.target.value })}
                        className="text-sm font-bold bg-transparent text-slate-900 dark:text-white border-b border-transparent hover:border-slate-300 dark:hover:border-slate-700 focus:border-blue-500 focus:outline-none truncate max-w-[220px]"
                      />
                      <span className="text-[11px] font-mono tabular-nums text-slate-500">
                        {formatDuration(track.buffer.duration, true)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Start Offset */}
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                    <span>Start:</span>
                    <input
                      type="number"
                      aria-label={`${track.name} start offset seconds`}
                      min={0}
                      max={Math.max(60, Math.ceil(timelineDuration + 10))}
                      step={0.1}
                      value={Number(track.offsetSec.toFixed(1))}
                      onChange={(e) =>
                        onUpdateOverlayTrack(track.id, {
                          offsetSec: Math.max(0, Number(e.target.value) || 0),
                        })
                      }
                      className="w-16 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-0.5 font-mono text-xs tabular-nums text-slate-800 dark:text-slate-100"
                    />
                    <span>s</span>
                  </label>

                  {/* Solo & Mute Toggles */}
                  <button
                    type="button"
                    aria-pressed={track.solo}
                    aria-label={`Solo ${track.name}`}
                    onClick={() => onUpdateOverlayTrack(track.id, { solo: !track.solo })}
                    className={`flex h-7 w-7 items-center justify-center rounded-md border text-xs font-bold transition-colors ${
                      track.solo
                        ? 'border-amber-500 bg-amber-500 text-slate-950'
                        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:border-amber-500'
                    }`}
                  >
                    S
                  </button>
                  <button
                    type="button"
                    aria-pressed={track.muted}
                    aria-label={`Mute ${track.name}`}
                    onClick={() => onUpdateOverlayTrack(track.id, { muted: !track.muted })}
                    className={`flex h-7 w-7 items-center justify-center rounded-md border text-xs font-bold transition-colors ${
                      track.muted
                        ? 'border-rose-500 bg-rose-600 text-white'
                        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:border-rose-500'
                    }`}
                  >
                    M
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${track.name}`}
                    onClick={() => onRemoveOverlayTrack(track.id)}
                    className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 dark:border-slate-700 text-slate-400 hover:border-rose-500 hover:text-rose-500 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <MiniTrackWaveform
                buffer={track.buffer}
                color={track.color}
                offsetSec={track.offsetSec}
                timelineDuration={timelineDuration}
                dimmed={dimmed}
              />

              {/* Volume Gain & Stereo Pan Controls */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-0.5">
                <div className="flex items-center gap-2.5 text-xs">
                  {track.muted || track.gain === 0 ? (
                    <VolumeX className="h-3.5 w-3.5 text-rose-500 shrink-0" />
                  ) : (
                    <Volume2 className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                  )}
                  <span className="w-10 text-slate-500 dark:text-slate-400">Gain</span>
                  <input
                    type="range"
                    aria-label={`${track.name} volume gain`}
                    min={0}
                    max={1.5}
                    step={0.05}
                    value={track.gain}
                    onChange={(e) =>
                      onUpdateOverlayTrack(track.id, { gain: Number(e.target.value) })
                    }
                    className="flex-1"
                  />
                  <span className="w-11 text-right font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-200">
                    {Math.round(track.gain * 100)}%
                  </span>
                </div>

                <div className="flex items-center gap-2.5 text-xs">
                  <span className="w-10 text-slate-500 dark:text-slate-400">Pan</span>
                  <span className="text-[10px] font-mono text-slate-400">L</span>
                  <input
                    type="range"
                    aria-label={`${track.name} panning`}
                    min={-1}
                    max={1}
                    step={0.05}
                    value={track.pan}
                    onChange={(e) =>
                      onUpdateOverlayTrack(track.id, { pan: Number(e.target.value) })
                    }
                    className="flex-1"
                  />
                  <span className="text-[10px] font-mono text-slate-400">R</span>
                  <button
                    type="button"
                    title="Click to center pan"
                    onClick={() => onUpdateOverlayTrack(track.id, { pan: 0 })}
                    className="w-11 text-right font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-200 hover:text-blue-500"
                  >
                    {formatPanLabel(track.pan)}
                  </button>
                </div>
              </div>

              {/* Per-Track 3-Band Parametric Equalizer */}
              <TrackEqControls
                trackKey={`overlay-${idx}`}
                trackLabel={track.name}
                eq={trackEq}
                onChange={(nextEq) => onUpdateOverlayTrack(track.id, { eq: nextEq })}
                isOpen={Boolean(expandedEqIds[track.id])}
                onToggleOpen={() => toggleEqDrawer(track.id)}
              />
            </div>
          );
        })}

        {overlayTracks.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 px-4 py-6 text-center text-xs text-slate-500 dark:text-slate-400">
            No extra tracks overlaid yet. Upload an audio file, duplicate your main vocal track for stereo doubling, or click any starter sound bed above to start layering.
          </div>
        )}
      </div>
    </section>
  );
}
