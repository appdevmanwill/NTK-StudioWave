import { useEffect, useMemo, useRef } from 'react';
import type { MixerState, ThemeMode } from '../types/audio';
import { extractChannels } from '../services/audioBackend';
import { computeAutoDuckingCurve } from '../utils/ruleBasedEditorDsp';

interface DuckingEnvelopeCanvasProps {
  voiceBuffer: AudioBuffer;
  mixer: MixerState;
  currentTime: number;
  duration: number;
  theme: ThemeMode;
}

/**
 * Lightweight HTML5 Canvas visualizing the voice speech envelope (blue bars)
 * overlaid with the real continuous Envelope-Following Auto-Ducking Gain Automation curve
 * (amber/emerald line) and live playhead position.
 */
export function DuckingEnvelopeCanvas({
  voiceBuffer,
  mixer,
  currentTime,
  duration,
  theme,
}: DuckingEnvelopeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const envelopeData = useMemo(() => {
    const chs = extractChannels(voiceBuffer);
    return computeAutoDuckingCurve(chs, voiceBuffer.sampleRate, {
      baseVolume: Math.max(0.05, mixer.musicVolume),
      duckAmountDb: mixer.duckAmountDb || -12,
      thresholdDb: mixer.duckThresholdDb ?? -34,
      attackMs: mixer.duckAttackMs ?? 45,
      holdMs: mixer.duckHoldMs ?? 180,
      releaseMs: mixer.duckReleaseMs ?? 380,
      lookAheadMs: 40,
      pointsPerSec: 30,
    });
  }, [
    voiceBuffer,
    mixer.musicVolume,
    mixer.duckAmountDb,
    mixer.duckThresholdDb,
    mixer.duckAttackMs,
    mixer.duckHoldMs,
    mixer.duckReleaseMs,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext('2d');
    if (!g) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(260, Math.floor(rect.width));
    const h = 88;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }

    g.save();
    g.scale(dpr, dpr);
    const isDark = theme === 'dark';

    // Background
    g.fillStyle = isDark ? '#0B0F17' : '#F8FAFC';
    g.fillRect(0, 0, w, h);

    // Subtle guide grid
    g.strokeStyle = isDark ? 'rgba(148,163,184,0.12)' : 'rgba(15,23,42,0.08)';
    g.lineWidth = 1;
    for (let row = 1; row <= 3; row++) {
      const y = (h / 4) * row;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }

    const { voiceEnvelope, gainCurve } = envelopeData;
    const n = voiceEnvelope.length;
    const baseVol = Math.max(0.05, mixer.musicVolume);

    // 1. Voice speech envelope silhouette (soft blue bottom bars)
    g.fillStyle = isDark ? 'rgba(59, 130, 246, 0.25)' : 'rgba(37, 99, 235, 0.18)';
    const step = w / Math.max(1, n - 1);
    g.beginPath();
    g.moveTo(0, h);
    for (let i = 0; i < n; i++) {
      const x = i * step;
      const amp = Math.min(1, voiceEnvelope[i]);
      const y = h - amp * (h - 14);
      g.lineTo(x, y);
    }
    g.lineTo(w, h);
    g.closePath();
    g.fill();

    // 2. Music Gain Automation Curve (amber when Auto-Ducking is ON, flat dashed slate when OFF)
    g.save();
    if (mixer.autoDucking) {
      g.strokeStyle = '#f59e0b';
      g.lineWidth = 2.4;
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const x = i * step;
        const normGain = Math.max(0, Math.min(1, gainCurve[i] / baseVol));
        const y = h - 10 - normGain * (h - 22);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();

      // Subtle shaded ducking area under curve
      g.lineTo(w, h - 10);
      g.lineTo(0, h - 10);
      g.closePath();
      g.fillStyle = 'rgba(245, 158, 11, 0.10)';
      g.fill();
    } else {
      g.strokeStyle = isDark ? '#64748b' : '#94a3b8';
      g.lineWidth = 1.5;
      g.setLineDash([5, 4]);
      const y = 12;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    g.restore();

    // 3. Playhead indicator
    if (duration > 0) {
      const px = Math.max(0, Math.min(w, (currentTime / duration) * w));
      g.strokeStyle = isDark ? '#ffffff' : '#0f172a';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, h);
      g.stroke();
    }

    g.restore();
  }, [currentTime, duration, envelopeData, mixer.autoDucking, mixer.musicVolume, theme]);

  return (
    <div className="space-y-1.5" data-testid="ducking-envelope-visualizer">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-blue-500" />
            <span>Voice Envelope</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            <span>Music Gain Automation</span>
          </span>
        </div>
        <span className="font-mono tabular-nums text-amber-600 dark:text-amber-400">
          {mixer.autoDucking
            ? `Auto-Ducks up to -${envelopeData.maxDuckDb.toFixed(1)} dB during speech`
            : 'Auto-Ducking Off (Flat Music Level)'}
        </span>
      </div>
      <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
        <canvas ref={canvasRef} className="block w-full h-[88px]" />
      </div>
    </div>
  );
}
