import { Eraser, RotateCcw, ShieldCheck, Sparkles, Waves } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DeClickOptions, DeReverbOptions, SpectralBoxSelection, ThemeMode } from '../types/audio';
import { extractChannels } from '../services/audioBackend';
import { formatDuration } from '../utils/audioDsp';
import { computeSpectrogramGrid } from '../utils/spectralRepairDsp';

interface SpectralRepairPanelProps {
  buffer: AudioBuffer;
  theme: ThemeMode;
  ecoMode?: boolean;
  isProcessing: boolean;
  onRepairClicks: (opts: DeClickOptions) => void;
  onReduceReverb: (opts: DeReverbOptions) => void;
  onEraseSpectralBox: (box: SpectralBoxSelection) => void;
}

export function SpectralRepairPanel({
  buffer,
  theme,
  ecoMode = false,
  isProcessing,
  onRepairClicks,
  onReduceReverb,
  onEraseSpectralBox,
}: SpectralRepairPanelProps) {
  const [clickSens, setClickSens] = useState(65);
  const [removePlosives, setRemovePlosives] = useState(true);
  const [plosiveStrength, setPlosiveStrength] = useState(68);
  const [reverbStrength, setReverbStrength] = useState(55);
  const [reverbDecayMs, setReverbDecayMs] = useState(260);
  const [eraseReductionDb, setEraseReductionDb] = useState(-32);

  // Box selection on the interactive spectrogram (in normalized canvas fractions [0..1])
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragEnd, setDragEnd] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const specGrid = useMemo(() => {
    const chs = extractChannels(buffer);
    return computeSpectrogramGrid(chs, buffer.sampleRate, {
      maxCols: ecoMode ? 120 : 200,
      fftSize: 512,
      maxHz: Math.min(8000, buffer.sampleRate / 2),
    });
  }, [buffer, ecoMode]);

  // Convert normalized drag rectangle into real Time (sec) × Frequency (Hz) coordinates
  const selectedBox: SpectralBoxSelection | null = useMemo(() => {
    if (!dragStart || !dragEnd) return null;
    const x0 = Math.max(0, Math.min(1, Math.min(dragStart.x, dragEnd.x)));
    const x1 = Math.max(0, Math.min(1, Math.max(dragStart.x, dragEnd.x)));
    const yTop = Math.max(0, Math.min(1, Math.min(dragStart.y, dragEnd.y)));
    const yBot = Math.max(0, Math.min(1, Math.max(dragStart.y, dragEnd.y)));
    if (x1 - x0 < 0.015 || yBot - yTop < 0.03) return null;
    return {
      startSec: x0 * specGrid.durationSec,
      endSec: x1 * specGrid.durationSec,
      // Top of canvas = maxHz, bottom = 0 Hz
      minHz: Math.round((1 - yBot) * specGrid.maxHz),
      maxHz: Math.round((1 - yTop) * specGrid.maxHz),
      reductionDb: eraseReductionDb,
    };
  }, [dragStart, dragEnd, specGrid.durationSec, specGrid.maxHz, eraseReductionDb]);

  // Render Spectrogram + Interactive Eraser Box onto <canvas>
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = 760;
    const height = 190;
    const dpr = ecoMode ? 1 : Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background
    ctx.fillStyle = theme === 'dark' ? '#0b101b' : '#0f172a';
    ctx.fillRect(0, 0, width, height);

    const { cols, rows, data } = specGrid;
    const cellW = width / cols;
    const cellH = height / rows;

    // Paint clean magma/studio thermal spectrogram palette
    for (let c = 0; c < cols; c++) {
      const x = c * cellW;
      for (let r = 0; r < rows; r++) {
        const val = data[c * rows + r];
        if (val < 0.08) continue;
        // Row 0 = bottom (0 Hz), row rows-1 = top (maxHz)
        const y = height - (r + 1) * cellH;
        let red = 0;
        let grn = 0;
        let blu = 0;
        if (val < 0.45) {
          const t = val / 0.45;
          red = Math.round(18 + t * 44);
          grn = Math.round(36 + t * 92);
          blu = Math.round(96 + t * 138);
        } else if (val < 0.78) {
          const t = (val - 0.45) / 0.33;
          red = Math.round(62 + t * 182);
          grn = Math.round(128 + t * 62);
          blu = Math.round(234 - t * 150);
        } else {
          const t = (val - 0.78) / 0.22;
          red = Math.round(244 + t * 11);
          grn = Math.round(190 + t * 62);
          blu = Math.round(84 + t * 156);
        }
        ctx.fillStyle = `rgb(${red},${grn},${blu})`;
        ctx.fillRect(x, y, Math.ceil(cellW), Math.ceil(cellH));
      }
    }

    // Subtle horizontal frequency reference grid lines with crisp legible tags
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.font = '600 10px "JetBrains Mono", monospace';
    const marks = [1000, 2000, 4000, 6000].filter((hz) => hz < specGrid.maxHz);
    for (const hz of marks) {
      const y = height * (1 - hz / specGrid.maxHz);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      const label = `${hz / 1000} kHz`;
      const textW = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
      ctx.fillRect(6, y - 15, textW + 8, 13);
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(label, 10, y - 5);
    }

    // Active drag selection rectangle
    if (dragStart && dragEnd) {
      const rx = Math.min(dragStart.x, dragEnd.x) * width;
      const ry = Math.min(dragStart.y, dragEnd.y) * height;
      const rw = Math.abs(dragEnd.x - dragStart.x) * width;
      const rh = Math.abs(dragEnd.y - dragStart.y) * height;
      ctx.fillStyle = 'rgba(244, 63, 94, 0.28)';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = '#fb7185';
      ctx.lineWidth = 1.75;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
    }
  }, [specGrid, dragStart, dragEnd, theme, ecoMode]);

  const pointerToNorm = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  return (
    <div className="space-y-6" data-testid="spectral-repair-panel">
      {/* 1. Interactive Visual Spectrogram Eraser */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
              Visual Sound Eraser (Spectrogram)
            </h3>
            <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
              Drag a box directly over a phone beep, cough, chair squeak, or hum band to erase only that sound without touching your voice.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {selectedBox && (
              <button
                type="button"
                onClick={() => {
                  setDragStart(null);
                  setDragEnd(null);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Clear Box</span>
              </button>
            )}
            <button
              type="button"
              data-testid="erase-spectral-box-btn"
              disabled={!selectedBox || isProcessing}
              onClick={() => {
                if (selectedBox) {
                  onEraseSpectralBox(selectedBox);
                  setDragStart(null);
                  setDragEnd(null);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-45 transition-colors whitespace-nowrap"
            >
              <Eraser className="h-3.5 w-3.5" />
              <span>{isProcessing ? 'Erasing...' : 'Erase Selected Sound'}</span>
            </button>
          </div>
        </div>

        <div className="relative overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
          <canvas
            ref={canvasRef}
            data-testid="spectral-eraser-canvas"
            onPointerDown={(e) => {
              const pt = pointerToNorm(e);
              setDragStart(pt);
              setDragEnd(pt);
              setIsDragging(true);
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!isDragging) return;
              setDragEnd(pointerToNorm(e));
            }}
            onPointerUp={() => setIsDragging(false)}
            className="block w-full h-[190px] cursor-crosshair touch-none"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 text-xs text-slate-600 dark:text-slate-400">
          <div className="font-mono tabular-nums">
            {selectedBox ? (
              <span className="text-rose-600 dark:text-rose-400 font-semibold">
                Selected: {formatDuration(selectedBox.startSec, true)} – {formatDuration(selectedBox.endSec, true)} · {selectedBox.minHz} Hz – {selectedBox.maxHz} Hz
              </span>
            ) : (
              <span>Tip: Click and drag anywhere on the spectrogram above to target an unwanted sound.</span>
            )}
          </div>
          <label className="flex items-center gap-2.5">
            <span>Erase Depth</span>
            <input
              type="range"
              aria-label="Spectral erase depth dB"
              min={-54}
              max={-12}
              step={2}
              value={eraseReductionDb}
              onChange={(e) => setEraseReductionDb(Number(e.target.value))}
              className="w-28"
            />
            <span className="font-mono tabular-nums w-12 text-right">{eraseReductionDb} dB</span>
          </label>
        </div>
      </div>

      {/* 2. One-Click Rule-Based Repair Pair: De-Click/De-Plosive + Room Echo Reducer */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 flex flex-col justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              <h4 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                Fix Mouth Clicks &amp; Mic Pops (De-Click / De-Plosive)
              </h4>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Removes sharp mouth clicks, cable crackles, and heavy &ldquo;P&rdquo;/&ldquo;B&rdquo; air pops hitting the microphone while keeping your voice crisp.
            </p>
            <label className="block space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-700 dark:text-slate-300">Click Sensitivity</span>
                <span className="font-mono tabular-nums text-slate-500">{clickSens}%</span>
              </div>
              <input
                type="range"
                aria-label="De-click sensitivity"
                min={20}
                max={95}
                value={clickSens}
                onChange={(e) => setClickSens(Number(e.target.value))}
                className="w-full"
              />
            </label>
            <div className="flex items-center justify-between text-xs pt-1">
              <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={removePlosives}
                  onChange={(e) => setRemovePlosives(e.target.checked)}
                  className="h-4 w-4 rounded accent-blue-600"
                />
                <span>Also soften &ldquo;P&rdquo;/&ldquo;B&rdquo; mic thumps</span>
              </label>
              {removePlosives && (
                <span className="font-mono tabular-nums text-slate-500">{plosiveStrength}%</span>
              )}
            </div>
            {removePlosives && (
              <input
                type="range"
                aria-label="De-plosive strength"
                min={20}
                max={100}
                value={plosiveStrength}
                onChange={(e) => setPlosiveStrength(Number(e.target.value))}
                className="w-full"
              />
            )}
          </div>
          <button
            type="button"
            data-testid="apply-declick-btn"
            disabled={isProcessing}
            onClick={() =>
              onRepairClicks({
                sensitivity: clickSens,
                removePlosives,
                plosiveStrength,
              })
            }
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            <ShieldCheck className="h-4 w-4" />
            <span>{isProcessing ? 'Repairing...' : 'Repair Clicks & Mic Pops'}</span>
          </button>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 flex flex-col justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Waves className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <h4 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                Reduce Room Echo (Rule-Based De-Reverb)
              </h4>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Tightens hollow bedroom, office, or hallway echo tails so your voice sounds closer and dryer — lightweight and 100% offline.
            </p>
            <label className="block space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-700 dark:text-slate-300">Echo Reduction Strength</span>
                <span className="font-mono tabular-nums text-slate-500">{reverbStrength}%</span>
              </div>
              <input
                type="range"
                aria-label="De-reverb strength"
                min={15}
                max={95}
                value={reverbStrength}
                onChange={(e) => setReverbStrength(Number(e.target.value))}
                className="w-full"
              />
            </label>
            <label className="block space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-700 dark:text-slate-300">Room Size / Tail Length</span>
                <span className="font-mono tabular-nums text-slate-500">{reverbDecayMs} ms</span>
              </div>
              <input
                type="range"
                aria-label="Room decay length ms"
                min={120}
                max={550}
                step={20}
                value={reverbDecayMs}
                onChange={(e) => setReverbDecayMs(Number(e.target.value))}
                className="w-full"
              />
            </label>
          </div>
          <button
            type="button"
            data-testid="apply-dereverb-btn"
            disabled={isProcessing}
            onClick={() =>
              onReduceReverb({
                strength: reverbStrength,
                decaySec: reverbDecayMs / 1000,
              })
            }
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
          >
            <Waves className="h-4 w-4" />
            <span>{isProcessing ? 'Cleaning Echo...' : 'Reduce Room Echo'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
