import { Activity, ChevronDown, ChevronUp, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { EffectSettings, RealtimeNoiseGateHandle, ThemeMode } from '../types/audio';

interface FrequencySpectrumCanvasProps {
  analyser: AnalyserNode | null;
  noiseGateRef: React.MutableRefObject<RealtimeNoiseGateHandle | null>;
  isPlaying: boolean;
  theme: ThemeMode;
  ecoMode?: boolean;
  effects: EffectSettings;
  onToggleNoiseGate: (enabled: boolean) => void;
}

const BAND_COUNT = 48;
const AXIS_MARKERS = [
  { label: '60 Hz', hz: 60 },
  { label: '250 Hz', hz: 250 },
  { label: '1 kHz', hz: 1000 },
  { label: '4 kHz', hz: 4000 },
  { label: '12 kHz', hz: 12000 },
];

const MIN_HZ = 40;
const MAX_HZ = 16000;

function freqToNormalizedX(hz: number): number {
  const clamped = Math.max(MIN_HZ, Math.min(MAX_HZ, hz));
  return Math.log(clamped / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ);
}

export function FrequencySpectrumCanvas({
  analyser,
  noiseGateRef,
  isPlaying,
  theme,
  ecoMode = false,
  effects,
  onToggleNoiseGate,
}: FrequencySpectrumCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [expanded, setExpanded] = useState(true);
  const [liveStats, setLiveStats] = useState<{
    peakHz: number;
    energyPct: number;
    gateOpen: boolean;
    inputDb: number;
  }>({
    peakHz: 0,
    energyPct: 0,
    gateOpen: true,
    inputDb: -100,
  });

  // Persist peak-hold caps across animation frames
  const peakCapsRef = useRef<Float32Array>(new Float32Array(BAND_COUNT));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !expanded) return;

    const g = canvas.getContext('2d');
    if (!g) return;

    const dpr = ecoMode ? 1 : Math.min(2, window.devicePixelRatio || 1);
    let rafId = 0;
    let lastStatUpdate = 0;
    let lastDrawTime = 0;
    const minFrameGapMs = ecoMode ? 80 : 16;
    const freqData = analyser ? new Uint8Array(analyser.frequencyBinCount) : new Uint8Array(512);
    const sampleRate = analyser?.context.sampleRate ?? 44100;
    const nyquist = sampleRate / 2;

    const syncCanvasSize = () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(240, Math.floor(rect.width));
      const h = Math.max(88, Math.floor(rect.height));
      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
      }
      return { w, h };
    };

    const drawFrame = (activePlayback: boolean) => {
      const { w, h } = syncCanvasSize();
      const plotH = h - 20;

      g.save();
      g.scale(dpr, dpr);
      g.clearRect(0, 0, w, h);

      // Background surface
      const isDark = theme === 'dark';
      g.fillStyle = isDark ? '#0B0F17' : '#F8FAFC';
      g.fillRect(0, 0, w, h);

      // Subtle horizontal dB grid lines
      g.strokeStyle = isDark ? 'rgba(148,163,184,0.10)' : 'rgba(15,23,42,0.07)';
      g.lineWidth = 1;
      for (let row = 1; row <= 3; row++) {
        const y = Math.round((plotH / 4) * row) + 0.5;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(w, y);
        g.stroke();
      }

      // Highlight High-Pass cut region when rumble filter is active
      if (effects.studioPolish || effects.cleanNoise || effects.breathSoftener) {
        const hpX = freqToNormalizedX(effects.highPassHz) * w;
        g.fillStyle = isDark ? 'rgba(245, 158, 11, 0.08)' : 'rgba(245, 158, 11, 0.10)';
        g.fillRect(0, 0, hpX, plotH);
      }

      // Highlight De-Esser notch marker when Breath/Sibilance Softener is active
      if (effects.breathSoftener) {
        const deX = freqToNormalizedX(effects.deEsserFreqHz) * w;
        g.strokeStyle = 'rgba(168, 85, 247, 0.55)';
        g.setLineDash([3, 3]);
        g.beginPath();
        g.moveTo(deX, 4);
        g.lineTo(deX, plotH);
        g.stroke();
        g.setLineDash([]);
      }

      // Sample frequency data from AnalyserNode when playing
      let peakBinIndex = 0;
      let peakBinValue = 0;
      let totalEnergy = 0;

      if (activePlayback && analyser) {
        analyser.getByteFrequencyData(freqData);
        for (let i = 1; i < freqData.length; i++) {
          totalEnergy += freqData[i];
          if (freqData[i] > peakBinValue) {
            peakBinValue = freqData[i];
            peakBinIndex = i;
          }
        }
      } else {
        freqData.fill(0);
      }

      // Draw logarithmic frequency spectrum bars
      const gap = 2.5;
      const barW = Math.max(2, (w - 16 - gap * (BAND_COUNT - 1)) / BAND_COUNT);
      const startX = 8;
      const peaks = peakCapsRef.current;

      const barGrad = g.createLinearGradient(0, plotH, 0, 6);
      if (effects.noiseGate) {
        barGrad.addColorStop(0, '#0284c7');
        barGrad.addColorStop(0.55, '#3b82f6');
        barGrad.addColorStop(1, '#10b981');
      } else {
        barGrad.addColorStop(0, '#2563eb');
        barGrad.addColorStop(0.6, '#38bdf8');
        barGrad.addColorStop(1, '#818cf8');
      }

      for (let b = 0; b < BAND_COUNT; b++) {
        const t0 = b / BAND_COUNT;
        const t1 = (b + 1) / BAND_COUNT;
        const f0 = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, t0);
        const f1 = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, t1);
        const bin0 = Math.max(0, Math.floor((f0 / nyquist) * freqData.length));
        const bin1 = Math.min(freqData.length - 1, Math.max(bin0, Math.ceil((f1 / nyquist) * freqData.length)));

        let maxMag = 0;
        for (let k = bin0; k <= bin1; k++) {
          if (freqData[k] > maxMag) maxMag = freqData[k];
        }
        const norm = activePlayback ? maxMag / 255 : 0;

        // Smooth peak hold decay
        if (norm > peaks[b]) {
          peaks[b] = norm;
        } else {
          peaks[b] = Math.max(0, peaks[b] - (activePlayback ? 0.018 : 0.06));
        }

        const x = startX + b * (barW + gap);
        const barH = Math.max(2, norm * (plotH - 10));
        const y = plotH - barH;

        g.fillStyle = activePlayback && norm > 0.01 ? barGrad : isDark ? 'rgba(148,163,184,0.18)' : 'rgba(100,116,139,0.22)';
        g.beginPath();
        g.roundRect(x, y, barW, barH, [2, 2, 0, 0]);
        g.fill();

        // Peak-hold cap
        if (peaks[b] > 0.04) {
          const capY = plotH - peaks[b] * (plotH - 10) - 2;
          g.fillStyle = isDark ? 'rgba(226,232,240,0.85)' : 'rgba(30,41,59,0.75)';
          g.fillRect(x, Math.max(2, capY), barW, 1.5);
        }
      }

      // Draw Noise Gate threshold reference line when enabled
      if (effects.noiseGate) {
        // Map thresholdDb (-60..-20) onto spectrum height as a visual reference floor
        const normThresh = Math.max(0.08, Math.min(0.85, (effects.noiseGateDb + 70) / 60));
        const gateY = Math.round(plotH - normThresh * (plotH - 12)) + 0.5;
        g.strokeStyle = 'rgba(16, 185, 129, 0.55)';
        g.lineWidth = 1;
        g.setLineDash([4, 4]);
        g.beginPath();
        g.moveTo(8, gateY);
        g.lineTo(w - 8, gateY);
        g.stroke();
        g.setLineDash([]);
      }

      // Bottom frequency axis ruler
      g.strokeStyle = isDark ? 'rgba(148,163,184,0.16)' : 'rgba(15,23,42,0.12)';
      g.beginPath();
      g.moveTo(0, plotH + 0.5);
      g.lineTo(w, plotH + 0.5);
      g.stroke();

      g.fillStyle = isDark ? '#94a3b8' : '#64748b';
      g.font = '500 10px "JetBrains Mono", monospace';
      g.textAlign = 'center';
      for (const m of AXIS_MARKERS) {
        const mx = Math.max(22, Math.min(w - 22, freqToNormalizedX(m.hz) * w));
        g.fillText(m.label, mx, h - 5);
      }

      g.restore();

      // Throttle React readout updates to ~10Hz
      const now = performance.now();
      if (activePlayback && now - lastStatUpdate > 100) {
        lastStatUpdate = now;
        const peakHz = peakBinValue > 8 ? Math.round((peakBinIndex / freqData.length) * nyquist) : 0;
        const avgEnergy = Math.round((totalEnergy / Math.max(1, freqData.length * 255)) * 100);
        const gateState = noiseGateRef.current?.getState();
        setLiveStats({
          peakHz,
          energyPct: avgEnergy,
          gateOpen: gateState ? gateState.isOpen : true,
          inputDb: gateState ? Math.round(gateState.inputDb) : -100,
        });
      }
    };

    if (!isPlaying) {
      peakCapsRef.current.fill(0);
      drawFrame(false);
      setLiveStats((prev) => ({ ...prev, peakHz: 0, energyPct: 0, gateOpen: !effects.noiseGate }));
      return;
    }

    const loop = (now: number) => {
      if (now - lastDrawTime >= minFrameGapMs) {
        lastDrawTime = now;
        drawFrame(true);
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [
    analyser,
    ecoMode,
    effects.breathSoftener,
    effects.cleanNoise,
    effects.deEsserFreqHz,
    effects.highPassHz,
    effects.noiseGate,
    effects.noiseGateDb,
    effects.studioPolish,
    expanded,
    isPlaying,
    noiseGateRef,
    theme,
  ]);

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0D121C] overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 border-b border-slate-200/70 dark:border-slate-800/80">
        <div className="flex items-center gap-2 text-xs">
          <Activity
            className={`h-3.5 w-3.5 ${
              isPlaying ? 'text-blue-500 animate-pulse' : 'text-slate-400 dark:text-slate-500'
            }`}
          />
          <span className="font-semibold text-slate-800 dark:text-slate-200">
            Live Frequency Spectrum
          </span>
          <span className="hidden sm:inline font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
            {isPlaying
              ? liveStats.peakHz > 0
                ? `Peak ${liveStats.peakHz >= 1000 ? `${(liveStats.peakHz / 1000).toFixed(1)} kHz` : `${liveStats.peakHz} Hz`}`
                : 'Monitoring 40 Hz – 16 kHz'
              : 'Press Play to monitor live frequencies'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Live Noise Gate quick status + toggle */}
          <button
            type="button"
            onClick={() => onToggleNoiseGate(!effects.noiseGate)}
            aria-pressed={effects.noiseGate}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
              effects.noiseGate
                ? 'border-emerald-500/50 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <ShieldCheck className="h-3 w-3" />
            <span>
              {effects.noiseGate
                ? isPlaying
                  ? liveStats.gateOpen
                    ? `Noise Gate: Open (${effects.noiseGateDb} dB)`
                    : `Noise Gate: Muting Floor (${effects.noiseGateDb} dB)`
                  : `Noise Gate On (${effects.noiseGateDb} dB)`
                : 'Noise Gate: Off'}
            </span>
          </button>

          <button
            type="button"
            aria-label={expanded ? 'Collapse frequency spectrum' : 'Expand frequency spectrum'}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-slate-500 hover:bg-slate-200/70 dark:hover:bg-slate-800"
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="relative h-28 w-full">
          <canvas
            ref={canvasRef}
            data-testid="frequency-spectrum-canvas"
            data-active={isPlaying ? 'playing' : 'idle'}
            data-peak-hz={liveStats.peakHz}
            data-energy={liveStats.energyPct}
            data-gate-enabled={effects.noiseGate ? 'true' : 'false'}
            data-gate-open={liveStats.gateOpen ? 'true' : 'false'}
            className="h-full w-full block"
          />
        </div>
      )}
    </div>
  );
}
