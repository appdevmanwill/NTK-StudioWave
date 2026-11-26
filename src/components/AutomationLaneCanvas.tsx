import { Check, RotateCcw, Sliders } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AutomationCurveOptions, AutomationPoint, ThemeMode } from '../types/audio';
import { formatDuration } from '../utils/audioDsp';

interface AutomationLaneCanvasProps {
  buffer: AudioBuffer;
  theme: ThemeMode;
  ecoMode?: boolean;
  isProcessing: boolean;
  onApplyAutomation: (opts: AutomationCurveOptions) => void;
}

type LaneMode = 'volume' | 'pan';

export function AutomationLaneCanvas({
  buffer,
  theme,
  ecoMode = false,
  isProcessing,
  onApplyAutomation,
}: AutomationLaneCanvasProps) {
  const duration = Math.max(0.1, buffer.duration);
  const [laneMode, setLaneMode] = useState<LaneMode>('volume');
  const [volumePoints, setVolumePoints] = useState<AutomationPoint[]>([
    { id: 'v-start', timeSec: 0, value: 0 },
    { id: 'v-end', timeSec: duration, value: 0 },
  ]);
  const [panPoints, setPanPoints] = useState<AutomationPoint[]>([
    { id: 'p-start', timeSec: 0, value: 0 },
    { id: 'p-end', timeSec: duration, value: 0 },
  ]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Keep endpoint timestamps aligned when audio duration changes
  useEffect(() => {
    setVolumePoints([
      { id: 'v-start', timeSec: 0, value: 0 },
      { id: 'v-end', timeSec: duration, value: 0 },
    ]);
    setPanPoints([
      { id: 'p-start', timeSec: 0, value: 0 },
      { id: 'p-end', timeSec: duration, value: 0 },
    ]);
  }, [duration]);

  // Pre-compute lightweight waveform silhouette for background reference
  const wavePeaks = useMemo(() => {
    const bins = 140;
    const ch = buffer.getChannelData(0);
    const out = new Float32Array(bins);
    const step = Math.max(1, Math.floor(ch.length / bins));
    for (let b = 0; b < bins; b++) {
      let max = 0;
      const start = b * step;
      const end = Math.min(ch.length, start + step);
      const stride = Math.max(1, Math.floor((end - start) / 48));
      for (let i = start; i < end; i += stride) {
        const a = Math.abs(ch[i]);
        if (a > max) max = a;
      }
      out[b] = max;
    }
    return out;
  }, [buffer]);

  const activePoints = laneMode === 'volume' ? volumePoints : panPoints;
  const setActivePoints = laneMode === 'volume' ? setVolumePoints : setPanPoints;

  // Value <-> normalized Y [0=top .. 1=bottom]
  const valueToY = (val: number, mode: LaneMode) => {
    if (mode === 'volume') {
      // +12 dB at top (0.08), -36 dB at bottom (0.92)
      const norm = (12 - val) / 48;
      return 0.08 + Math.max(0, Math.min(1, norm)) * 0.84;
    }
    // Pan: +1 (Right) at top (0.12), -1 (Left) at bottom (0.88)
    const norm = (1 - val) / 2;
    return 0.12 + Math.max(0, Math.min(1, norm)) * 0.76;
  };

  const yToValue = (yNorm: number, mode: LaneMode) => {
    if (mode === 'volume') {
      const clamped = Math.max(0, Math.min(1, (yNorm - 0.08) / 0.84));
      return Math.round((12 - clamped * 48) * 2) / 2; // 0.5 dB steps
    }
    const clamped = Math.max(0, Math.min(1, (yNorm - 0.12) / 0.76));
    return Math.round((1 - clamped * 2) * 20) / 20; // 0.05 pan steps
  };

  // Draw waveform silhouette + interactive automation curve
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = 760;
    const h = 152;
    const dpr = ecoMode ? 1 : Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = theme === 'dark' ? '#0f1623' : '#f8fafc';
    ctx.fillRect(0, 0, w, h);

    // Reference center / 0 dB hairline
    const zeroY = valueToY(0, laneMode) * h;
    ctx.strokeStyle = theme === 'dark' ? 'rgba(148,163,184,0.22)' : 'rgba(100,116,139,0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(w, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Waveform background silhouette
    ctx.fillStyle = theme === 'dark' ? 'rgba(59,130,246,0.18)' : 'rgba(59,130,246,0.16)';
    const barW = w / wavePeaks.length;
    for (let i = 0; i < wavePeaks.length; i++) {
      const barH = Math.max(2, wavePeaks[i] * (h * 0.75));
      ctx.fillRect(i * barW, h / 2 - barH / 2, Math.max(1.5, barW - 1), barH);
    }

    // Label markers on left edge
    ctx.fillStyle = theme === 'dark' ? 'rgba(148,163,184,0.75)' : 'rgba(71,85,105,0.75)';
    ctx.font = '10px "JetBrains Mono", monospace';
    if (laneMode === 'volume') {
      ctx.fillText('+12 dB', 8, 16);
      ctx.fillText('0 dB', 8, zeroY - 4);
      ctx.fillText('-36 dB', 8, h - 8);
    } else {
      ctx.fillText('Right (R)', 8, 18);
      ctx.fillText('Center', 8, zeroY - 4);
      ctx.fillText('Left (L)', 8, h - 8);
    }

    // Automation curve line + shaded fill
    const sorted = [...activePoints].sort((a, b) => a.timeSec - b.timeSec);
    const strokeCol = laneMode === 'volume' ? '#2563eb' : '#9333ea';
    const fillCol = laneMode === 'volume' ? 'rgba(37, 99, 235, 0.14)' : 'rgba(147, 51, 234, 0.14)';

    if (sorted.length > 0) {
      ctx.beginPath();
      sorted.forEach((pt, idx) => {
        const px = (pt.timeSec / duration) * w;
        const py = valueToY(pt.value, laneMode) * h;
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = strokeCol;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Subtle fill toward neutral line
      ctx.lineTo((sorted[sorted.length - 1].timeSec / duration) * w, zeroY);
      ctx.lineTo((sorted[0].timeSec / duration) * w, zeroY);
      ctx.closePath();
      ctx.fillStyle = fillCol;
      ctx.fill();

      // Draw draggable node handles
      for (const pt of sorted) {
        const px = (pt.timeSec / duration) * w;
        const py = valueToY(pt.value, laneMode) * h;
        ctx.beginPath();
        ctx.arc(px, py, pt.id === draggingId ? 7 : 5.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = strokeCol;
        ctx.stroke();
      }
    }
  }, [activePoints, draggingId, duration, ecoMode, laneMode, theme, wavePeaks]);

  const getPointerCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      xNorm: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      yNorm: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
      width: rect.width,
      height: rect.height,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { xNorm, yNorm, width, height } = getPointerCoords(e);
    const clickX = xNorm * width;
    const clickY = yNorm * height;

    // Check if user grabbed an existing point
    const hit = activePoints.find((pt) => {
      const px = (pt.timeSec / duration) * width;
      const py = valueToY(pt.value, laneMode) * height;
      return Math.hypot(px - clickX, py - clickY) <= 13;
    });

    if (hit) {
      setDraggingId(hit.id);
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    // Otherwise add a new automation keyframe right where the user clicked
    const newId = `pt-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    const newPt: AutomationPoint = {
      id: newId,
      timeSec: Math.max(0.02, Math.min(duration - 0.02, xNorm * duration)),
      value: yToValue(yNorm, laneMode),
    };
    setActivePoints((prev) => [...prev, newPt].sort((a, b) => a.timeSec - b.timeSec));
    setDraggingId(newId);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!draggingId) return;
    const { xNorm, yNorm } = getPointerCoords(e);
    const nextVal = yToValue(yNorm, laneMode);
    setActivePoints((prev) =>
      prev
        .map((pt) => {
          if (pt.id !== draggingId) return pt;
          const isStart = pt.id.endsWith('-start');
          const isEnd = pt.id.endsWith('-end');
          return {
            ...pt,
            timeSec: isStart
              ? 0
              : isEnd
              ? duration
              : Math.max(0.02, Math.min(duration - 0.02, xNorm * duration)),
            value: nextVal,
          };
        })
        .sort((a, b) => a.timeSec - b.timeSec)
    );
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const hit = activePoints.find((pt) => {
      if (pt.id.endsWith('-start') || pt.id.endsWith('-end')) return false;
      const px = (pt.timeSec / duration) * rect.width;
      const py = valueToY(pt.value, laneMode) * rect.height;
      return Math.hypot(px - clickX, py - clickY) <= 14;
    });
    if (hit) {
      setActivePoints((prev) => prev.filter((p) => p.id !== hit.id));
    }
  };

  const applyPresetShape = (shape: 'fade-in-out' | 'mid-dip' | 'pan-sweep' | 'reset') => {
    if (shape === 'reset') {
      setVolumePoints([
        { id: 'v-start', timeSec: 0, value: 0 },
        { id: 'v-end', timeSec: duration, value: 0 },
      ]);
      setPanPoints([
        { id: 'p-start', timeSec: 0, value: 0 },
        { id: 'p-end', timeSec: duration, value: 0 },
      ]);
      return;
    }
    if (shape === 'fade-in-out') {
      setLaneMode('volume');
      const fade = Math.min(2.0, duration * 0.18);
      setVolumePoints([
        { id: 'v-start', timeSec: 0, value: -30 },
        { id: 'v-in', timeSec: fade, value: 0 },
        { id: 'v-out', timeSec: Math.max(fade + 0.1, duration - fade), value: 0 },
        { id: 'v-end', timeSec: duration, value: -30 },
      ]);
    } else if (shape === 'mid-dip') {
      setLaneMode('volume');
      setVolumePoints([
        { id: 'v-start', timeSec: 0, value: 0 },
        { id: 'v-d1', timeSec: duration * 0.3, value: 0 },
        { id: 'v-d2', timeSec: duration * 0.42, value: -14 },
        { id: 'v-d3', timeSec: duration * 0.62, value: -14 },
        { id: 'v-d4', timeSec: duration * 0.72, value: 0 },
        { id: 'v-end', timeSec: duration, value: 0 },
      ]);
    } else if (shape === 'pan-sweep') {
      setLaneMode('pan');
      setPanPoints([
        { id: 'p-start', timeSec: 0, value: -0.75 },
        { id: 'p-mid', timeSec: duration * 0.5, value: 0 },
        { id: 'p-end', timeSec: duration, value: 0.75 },
      ]);
    }
  };

  const hasChanges =
    volumePoints.some((p) => Math.abs(p.value) > 0.05) ||
    panPoints.some((p) => Math.abs(p.value) > 0.02);

  return (
    <div
      data-testid="automation-lane-panel"
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sliders className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
              Draw Volume &amp; Stereo Pan Automation
            </h3>
          </div>
          <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
            Click anywhere on the line to add a handle, drag up or down to shape smooth volume fades or left-to-right stereo movement, or double-click a handle to remove it.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div
            role="group"
            aria-label="Automation lane type"
            className="flex items-center rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 p-0.5"
          >
            <button
              type="button"
              onClick={() => setLaneMode('volume')}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                laneMode === 'volume'
                  ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Volume (dB)
            </button>
            <button
              type="button"
              onClick={() => setLaneMode('pan')}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                laneMode === 'pan'
                  ? 'bg-white dark:bg-slate-800 text-purple-600 dark:text-purple-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Stereo Pan (L/R)
            </button>
          </div>
        </div>
      </div>

      {/* Quick Curve Presets */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500 dark:text-slate-400 font-medium">Quick shapes:</span>
        <button
          type="button"
          onClick={() => applyPresetShape('fade-in-out')}
          className="rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1 font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          Smooth Fade In &amp; Out
        </button>
        <button
          type="button"
          onClick={() => applyPresetShape('mid-dip')}
          className="rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1 font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          Mid-Section Dip
        </button>
        <button
          type="button"
          onClick={() => applyPresetShape('pan-sweep')}
          className="rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1 font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          Left → Right Pan Sweep
        </button>
        <button
          type="button"
          onClick={() => applyPresetShape('reset')}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1 font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          <RotateCcw className="h-3 w-3" />
          <span>Reset Flat</span>
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
        <canvas
          ref={canvasRef}
          data-testid="automation-lane-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={() => setDraggingId(null)}
          onDoubleClick={handleDoubleClick}
          className="block w-full h-[152px] cursor-pointer touch-none"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
          {activePoints.length} control points · Track length {formatDuration(duration, true)}
        </span>
        <button
          type="button"
          data-testid="apply-automation-btn"
          disabled={!hasChanges || isProcessing}
          onClick={() => onApplyAutomation({ volumePoints, panPoints })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-45 transition-colors whitespace-nowrap"
        >
          <Check className="h-3.5 w-3.5" />
          <span>{isProcessing ? 'Applying...' : 'Apply Automation to Track'}</span>
        </button>
      </div>
    </div>
  );
}
