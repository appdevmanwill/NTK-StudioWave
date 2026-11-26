import { Magnet, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  BookmarkMarker,
  OopsMarker,
  RepetitionRegion,
  SilenceRegion,
  ThemeMode,
} from '../types/audio';
import {
  computeWaveformPeaks,
  formatDuration,
  mixToMono,
  snapToZeroCrossing,
} from '../utils/audioDsp';
import { extractChannels } from '../services/audioBackend';

interface WaveformCanvasProps {
  buffer: AudioBuffer | null;
  currentTime: number;
  duration: number;
  selection: { start: number; end: number } | null;
  onSelectRange: (range: { start: number; end: number } | null) => void;
  onSeek: (timeSec: number) => void;
  silences: SilenceRegion[];
  repetitions: RepetitionRegion[];
  bookmarks: BookmarkMarker[];
  oopsMarkers: OopsMarker[];
  snapToSilence: boolean;
  onToggleSnapToSilence: (v: boolean) => void;
  theme: ThemeMode;
}

export function WaveformCanvas({
  buffer,
  currentTime,
  duration,
  selection,
  onSelectRange,
  onSeek,
  silences,
  repetitions,
  bookmarks,
  oopsMarkers,
  snapToSilence,
  onToggleSnapToSilence,
  theme,
}: WaveformCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [containerWidth, setContainerWidth] = useState(960);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartSecRef = useRef<number | null>(null);

  const monoPcm = useMemo(() => {
    if (!buffer) return new Float32Array(0);
    return mixToMono(extractChannels(buffer));
  }, [buffer]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 100) setContainerWidth(Math.floor(w));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const canvasCssWidth = Math.max(containerWidth, Math.round(containerWidth * zoom));
  const canvasCssHeight = 176;

  const peaks = useMemo(() => {
    if (monoPcm.length === 0) return { mins: new Float32Array(0), maxs: new Float32Array(0) };
    // 1 peak bucket per 2 CSS pixels for razor-sharp waveform bars
    const buckets = Math.max(120, Math.floor(canvasCssWidth / 2));
    return computeWaveformPeaks(monoPcm, buckets);
  }, [monoPcm, canvasCssWidth]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = canvasCssWidth * dpr;
    canvas.height = canvasCssHeight * dpr;
    const g = canvas.getContext('2d');
    if (!g) return;

    g.save();
    g.scale(dpr, dpr);

    const isDark = theme === 'dark';
    const rulerH = 24;
    const waveTop = rulerH;
    const waveH = canvasCssHeight - rulerH;
    const midY = waveTop + waveH / 2;

    // Background
    g.fillStyle = isDark ? '#0D121C' : '#F8FAFC';
    g.fillRect(0, 0, canvasCssWidth, canvasCssHeight);

    // Ruler background
    g.fillStyle = isDark ? '#131A27' : '#F1F5F9';
    g.fillRect(0, 0, canvasCssWidth, rulerH);
    g.strokeStyle = isDark ? '#1E293B' : '#E2E8F0';
    g.beginPath();
    g.moveTo(0, rulerH + 0.5);
    g.lineTo(canvasCssWidth, rulerH + 0.5);
    g.stroke();

    // Time ticks on ruler
    if (duration > 0) {
      const targetTicks = Math.max(4, Math.floor(canvasCssWidth / 95));
      const rawStep = duration / targetTicks;
      const niceSteps = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
      const step = niceSteps.find((s) => s >= rawStep) ?? 60;
      g.fillStyle = isDark ? '#94A3B8' : '#64748B';
      g.font = '500 10px "JetBrains Mono", monospace';
      g.textAlign = 'left';
      for (let t = 0; t <= duration; t += step) {
        const x = (t / duration) * canvasCssWidth;
        g.strokeStyle = isDark ? '#273245' : '#CBD5E1';
        g.beginPath();
        g.moveTo(x + 0.5, rulerH - 6);
        g.lineTo(x + 0.5, rulerH);
        g.stroke();
        if (x < canvasCssWidth - 36) {
          g.fillText(formatDuration(t, step < 1), x + 4, 15);
        }
      }
    }

    // Center zero line
    g.strokeStyle = isDark ? 'rgba(148,163,184,0.14)' : 'rgba(100,116,139,0.18)';
    g.beginPath();
    g.moveTo(0, midY);
    g.lineTo(canvasCssWidth, midY);
    g.stroke();

    // 1. Yellow overlays: Detected Silences / Pauses
    if (duration > 0) {
      for (const s of silences) {
        const x1 = (s.start / duration) * canvasCssWidth;
        const x2 = (s.end / duration) * canvasCssWidth;
        g.fillStyle = isDark ? 'rgba(245, 158, 11, 0.18)' : 'rgba(245, 158, 11, 0.22)';
        g.fillRect(x1, waveTop, Math.max(2, x2 - x1), waveH);
        g.fillStyle = isDark ? 'rgba(245, 158, 11, 0.7)' : 'rgba(217, 119, 6, 0.85)';
        g.fillRect(x1, waveTop, Math.max(2, x2 - x1), 2.5);
      }

      // 2. Purple overlays: Detected Repeated Takes / Retakes
      for (const r of repetitions) {
        const x1 = (r.start / duration) * canvasCssWidth;
        const x2 = (r.end / duration) * canvasCssWidth;
        const isOops = r.source === 'oops';
        g.fillStyle = isOops
          ? isDark
            ? 'rgba(244, 63, 94, 0.22)'
            : 'rgba(225, 29, 72, 0.16)'
          : isDark
          ? 'rgba(168, 85, 247, 0.24)'
          : 'rgba(147, 51, 234, 0.18)';
        g.fillRect(x1, waveTop, Math.max(3, x2 - x1), waveH);
        g.fillStyle = isOops ? '#e11d48' : '#9333ea';
        g.fillRect(x1, waveTop, Math.max(3, x2 - x1), 3);
      }

      // 3. Red overlay: User Cut Selection
      if (selection && selection.end > selection.start) {
        const x1 = (selection.start / duration) * canvasCssWidth;
        const x2 = (selection.end / duration) * canvasCssWidth;
        g.fillStyle = isDark ? 'rgba(239, 68, 68, 0.22)' : 'rgba(239, 68, 68, 0.16)';
        g.fillRect(x1, waveTop, Math.max(2, x2 - x1), waveH);
        g.strokeStyle = '#ef4444';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(x1, waveTop);
        g.lineTo(x1, canvasCssHeight);
        g.moveTo(x2, waveTop);
        g.lineTo(x2, canvasCssHeight);
        g.stroke();
      }
    }

    // 4. Blue Waveform Bars (Voice / Audio)
    const count = peaks.mins.length;
    if (count > 0) {
      const barW = canvasCssWidth / count;
      const playX = duration > 0 ? (currentTime / duration) * canvasCssWidth : 0;
      const ampH = (waveH / 2) * 0.86;

      for (let i = 0; i < count; i++) {
        const x = i * barW;
        const minVal = peaks.mins[i];
        const maxVal = peaks.maxs[i];
        const yTop = midY - maxVal * ampH;
        const yBot = midY - minVal * ampH;
        const h = Math.max(1.5, yBot - yTop);

        g.fillStyle =
          x <= playX
            ? isDark
              ? '#60A5FA'
              : '#1D4ED8'
            : isDark
            ? '#3B82F6'
            : '#2563EB';
        g.fillRect(x, yTop, Math.max(1, barW - 0.5), h);
      }
    }

    // 5. Red Oops Retake vertical pins
    if (duration > 0) {
      for (const o of oopsMarkers) {
        const x = (o.time / duration) * canvasCssWidth;
        g.strokeStyle = '#e11d48';
        g.lineWidth = 1.5;
        g.setLineDash([4, 3]);
        g.beginPath();
        g.moveTo(x, waveTop);
        g.lineTo(x, canvasCssHeight);
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = '#e11d48';
        g.beginPath();
        g.arc(x, waveTop + 7, 4, 0, Math.PI * 2);
        g.fill();
      }

      // 6. Green Bookmark pins
      for (const b of bookmarks) {
        const x = (b.time / duration) * canvasCssWidth;
        g.strokeStyle = '#16a34a';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(x, waveTop);
        g.lineTo(x, canvasCssHeight);
        g.stroke();

        g.fillStyle = '#16a34a';
        g.beginPath();
        g.moveTo(x, waveTop);
        g.lineTo(x + 9, waveTop + 6);
        g.lineTo(x, waveTop + 12);
        g.closePath();
        g.fill();
      }

      // 7. Playhead cursor
      const px = Math.max(1, Math.min(canvasCssWidth - 1, (currentTime / duration) * canvasCssWidth));
      g.strokeStyle = isDark ? '#F8FAFC' : '#0F172A';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, canvasCssHeight);
      g.stroke();

      g.fillStyle = isDark ? '#F8FAFC' : '#0F172A';
      g.beginPath();
      g.moveTo(px - 5, 0);
      g.lineTo(px + 5, 0);
      g.lineTo(px, 8);
      g.closePath();
      g.fill();
    }

    g.restore();
  }, [
    peaks,
    canvasCssWidth,
    canvasCssHeight,
    duration,
    currentTime,
    silences,
    repetitions,
    bookmarks,
    oopsMarkers,
    selection,
    theme,
  ]);

  const clientXToTime = (clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas || duration <= 0) return 0;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const rawSec = ratio * duration;
    if (snapToSilence && buffer && monoPcm.length > 0) {
      return snapToZeroCrossing(monoPcm, buffer.sampleRate, rawSec, 0.05);
    }
    return rawSec;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!buffer || duration <= 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = clientXToTime(e.clientX);
    dragStartSecRef.current = t;
    setIsDragging(true);
    onSeek(t);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDragging || dragStartSecRef.current === null || duration <= 0) return;
    const t = clientXToTime(e.clientX);
    const s = Math.min(dragStartSecRef.current, t);
    const en = Math.max(dragStartSecRef.current, t);
    if (en - s > 0.08) {
      onSelectRange({ start: s, end: en });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDragging) return;
    setIsDragging(false);
    const start = dragStartSecRef.current;
    dragStartSecRef.current = null;
    if (start !== null) {
      const end = clientXToTime(e.clientX);
      if (Math.abs(end - start) <= 0.08) {
        onSelectRange(null);
        onSeek(end);
      }
    }
  };

  return (
    <div className="space-y-2.5">
      {/* Legend + Zoom & Magnetic Snap Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-600 dark:text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-xs bg-blue-500" /> Voice
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-xs bg-amber-500" /> Silences ({silences.length})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-xs bg-purple-500" /> Repetitions ({repetitions.length})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-xs bg-rose-500" /> Cut / Oops
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-xs bg-emerald-600" /> Bookmarks ({bookmarks.length})
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onToggleSnapToSilence(!snapToSilence)}
            aria-pressed={snapToSilence}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
              snapToSilence
                ? 'border-blue-500/50 bg-blue-500/10 text-blue-600 dark:text-blue-400'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <Magnet className="h-3.5 w-3.5" />
            <span>Snap-to-Silence {snapToSilence ? 'On' : 'Off'}</span>
          </button>

          <div className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1">
            <button
              type="button"
              aria-label="Zoom out waveform"
              onClick={() => setZoom((z) => Math.max(1, Number((z - 0.5).toFixed(1))))}
              className="text-slate-500 hover:text-slate-900 dark:hover:text-white"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <input
              type="range"
              aria-label="Waveform zoom level"
              min={1}
              max={6}
              step={0.25}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="w-20 h-1.5 cursor-pointer"
            />
            <button
              type="button"
              aria-label="Zoom in waveform"
              onClick={() => setZoom((z) => Math.min(6, Number((z + 0.5).toFixed(1))))}
              className="text-slate-500 hover:text-slate-900 dark:hover:text-white"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label="Fit waveform to screen"
              onClick={() => setZoom(1)}
              className="ml-1 text-slate-500 hover:text-slate-900 dark:hover:text-white"
              title="Fit to screen"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Scrollable High-DPI Waveform Viewport */}
      <div
        ref={containerRef}
        className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D121C]"
      >
        <canvas
          ref={canvasRef}
          data-testid="waveform-canvas"
          style={{ width: `${canvasCssWidth}px`, height: `${canvasCssHeight}px` }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className="block cursor-crosshair select-none touch-none"
        />
      </div>

      {/* Selection summary */}
      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>
          Click anywhere to jump · Drag across the waveform to select a section to cut or keep
        </span>
        {selection && (
          <span className="font-mono tabular-nums text-rose-600 dark:text-rose-400 font-medium">
            Selected: {formatDuration(selection.start, true)} – {formatDuration(selection.end, true)} (
            {(selection.end - selection.start).toFixed(1)}s)
          </span>
        )}
      </div>
    </div>
  );
}
