import type { AudiogramStyle } from '../types/audio';
import { formatDuration } from './audioDsp';

export interface AudiogramParticle {
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  phase: number;
}

export interface AudiogramFrameParams {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  aspect: '9:16' | '1:1';
  theme: 'midnight' | 'sunrise' | 'studio';
  style: AudiogramStyle;
  title: string;
  artist: string;
  coverImg: HTMLImageElement | null;
  freqData: Uint8Array;
  timeData?: Uint8Array;
  peakCaps: Float32Array;
  particles: AudiogramParticle[];
  elapsedSec: number;
  totalDurationSec: number;
  progress: number; // 0..1
}

export function createAudiogramParticles(count = 26): AudiogramParticle[] {
  const list: AudiogramParticle[] = [];
  for (let i = 0; i < count; i++) {
    // Deterministic seeded-style distribution so preview & export stay balanced and smooth
    const s1 = Math.sin(i * 12.9898) * 43758.5453;
    const s2 = Math.sin(i * 78.233 + 1.7) * 24634.6345;
    const r1 = s1 - Math.floor(s1);
    const r2 = s2 - Math.floor(s2);
    list.push({
      x: r1,
      y: r2,
      vx: (r1 - 0.5) * 0.018,
      vy: -(0.015 + r2 * 0.03),
      radius: 2 + (i % 5) * 1.4,
      alpha: 0.14 + (i % 4) * 0.08,
      phase: i * 0.7,
    });
  }
  return list;
}

function getThemePalette(theme: 'midnight' | 'sunrise' | 'studio') {
  if (theme === 'sunrise') {
    return {
      bgStops: ['#181036', '#6b211a', '#0f172a'] as const,
      orbA: 'rgba(249, 115, 22, 0.28)',
      orbB: 'rgba(236, 72, 153, 0.22)',
      primary: '#f97316',
      secondary: '#fb7185',
      glow: 'rgba(249, 115, 22, 0.48)',
      particle: '253, 186, 116',
      artStops: ['#ea580c', '#ec4899'] as const,
    };
  }
  if (theme === 'studio') {
    return {
      bgStops: ['#0b1120', '#112233', '#090d16'] as const,
      orbA: 'rgba(16, 185, 129, 0.24)',
      orbB: 'rgba(6, 182, 212, 0.20)',
      primary: '#10b981',
      secondary: '#06b6d4',
      glow: 'rgba(16, 185, 129, 0.45)',
      particle: '110, 231, 183',
      artStops: ['#059669', '#0891b2'] as const,
    };
  }
  return {
    bgStops: ['#070b14', '#13244a', '#0a1020'] as const,
    orbA: 'rgba(59, 130, 246, 0.28)',
    orbB: 'rgba(139, 92, 246, 0.22)',
    primary: '#3b82f6',
    secondary: '#38bdf8',
    glow: 'rgba(59, 130, 246, 0.5)',
    particle: '147, 197, 253',
    artStops: ['#2563eb', '#0ea5e9'] as const,
  };
}

/**
 * Full-Canvas Animated Audiogram Renderer (shared 1:1 between live ExportView preview
 * and offline/MediaRecorder WebM export in WebAudioBackend).
 */
export function renderAudiogramFrame(p: AudiogramFrameParams): void {
  const { ctx: g, width, height, aspect, theme, style, freqData, peakCaps, particles, elapsedSec } = p;
  const pal = getThemePalette(theme);
  const scale = width / 720;

  // Compute live bass & average spectral energy [0..1]
  let bassSum = 0;
  const bassBins = Math.max(1, Math.min(8, Math.floor(freqData.length * 0.16)));
  for (let i = 0; i < bassBins; i++) bassSum += freqData[i] / 255;
  const bassEnergy = bassSum / bassBins;

  let totalSum = 0;
  for (let i = 0; i < freqData.length; i++) totalSum += freqData[i] / 255;
  const avgEnergy = totalSum / Math.max(1, freqData.length);

  // 1. Deep Animated Gradient Background
  const bgGrad = g.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, pal.bgStops[0]);
  bgGrad.addColorStop(0.55, pal.bgStops[1]);
  bgGrad.addColorStop(1, pal.bgStops[2]);
  g.fillStyle = bgGrad;
  g.fillRect(0, 0, width, height);

  // 2. Drifting Audio-Reactive Ambient Aurora Orbs
  const orb1X = width * (0.28 + 0.14 * Math.sin(elapsedSec * 0.7));
  const orb1Y = height * (0.26 + 0.08 * Math.cos(elapsedSec * 0.55));
  const orb1R = width * (0.42 + bassEnergy * 0.16);
  const radA = g.createRadialGradient(orb1X, orb1Y, 0, orb1X, orb1Y, orb1R);
  radA.addColorStop(0, pal.orbA);
  radA.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = radA;
  g.fillRect(0, 0, width, height);

  const orb2X = width * (0.74 + 0.12 * Math.cos(elapsedSec * 0.6));
  const orb2Y = height * (0.72 + 0.09 * Math.sin(elapsedSec * 0.45));
  const orb2R = width * (0.4 + avgEnergy * 0.18);
  const radB = g.createRadialGradient(orb2X, orb2Y, 0, orb2X, orb2Y, orb2R);
  radB.addColorStop(0, pal.orbB);
  radB.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = radB;
  g.fillRect(0, 0, width, height);

  // 3. Floating Bokeh Particles (boosted gently by audio energy)
  for (let i = 0; i < particles.length; i++) {
    const pt = particles[i];
    const px = ((pt.x + pt.vx * elapsedSec) % 1 + 1) % 1;
    const py = ((pt.y + pt.vy * elapsedSec) % 1 + 1) % 1;
    const pulse = 0.75 + 0.25 * Math.sin(elapsedSec * 2.4 + pt.phase) + bassEnergy * 0.55;
    const r = pt.radius * scale * pulse;
    g.fillStyle = `rgba(${pal.particle}, ${Math.min(0.65, pt.alpha + avgEnergy * 0.2)})`;
    g.beginPath();
    g.arc(px * width, py * height, r, 0, Math.PI * 2);
    g.fill();
  }

  // Layout geometry
  const isVertical = aspect === '9:16';
  const artBase = (isVertical ? 286 : 194) * scale;
  const artPulse = 1 + bassEnergy * 0.045;
  const artSize = artBase * artPulse;
  const artCenterX = width / 2;
  const artCenterY = (isVertical ? 345 : 210) * scale;
  const artX = artCenterX - artSize / 2;
  const artY = artCenterY - artSize / 2;

  // 4. Radial Halo Visualizer (drawn behind/around cover art when style === 'radial')
  if (style === 'radial') {
    const spokes = 56;
    const baseR = artBase * 0.64;
    g.save();
    g.translate(artCenterX, artCenterY);
    for (let i = 0; i < spokes; i++) {
      const angle = (i / spokes) * Math.PI * 2 - Math.PI / 2 + elapsedSec * 0.22;
      const bin = Math.floor((i / spokes) * (freqData.length * 0.72));
      const v = freqData[bin] / 255;
      const spokeLen = (14 + v * (isVertical ? 115 : 82)) * scale;
      const x1 = Math.cos(angle) * baseR;
      const y1 = Math.sin(angle) * baseR;
      const x2 = Math.cos(angle) * (baseR + spokeLen);
      const y2 = Math.sin(angle) * (baseR + spokeLen);

      g.strokeStyle = i / spokes <= p.progress ? pal.primary : pal.secondary;
      g.globalAlpha = 0.45 + v * 0.55;
      g.lineWidth = Math.max(2, 4.5 * scale);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    }
    g.restore();
  }

  // 5. Pulsing Aura Halo + Rounded Cover Art Card
  g.save();
  g.shadowColor = pal.glow;
  g.shadowBlur = (26 + bassEnergy * 34) * scale;
  g.beginPath();
  g.roundRect(artX, artY, artSize, artSize, 26 * scale);
  g.fillStyle = pal.artStops[0];
  g.fill();
  g.restore();

  g.save();
  g.beginPath();
  g.roundRect(artX, artY, artSize, artSize, 26 * scale);
  g.clip();
  if (p.coverImg) {
    g.drawImage(p.coverImg, artX, artY, artSize, artSize);
  } else {
    const artGrad = g.createLinearGradient(artX, artY, artX + artSize, artY + artSize);
    artGrad.addColorStop(0, pal.artStops[0]);
    artGrad.addColorStop(1, pal.artStops[1]);
    g.fillStyle = artGrad;
    g.fillRect(artX, artY, artSize, artSize);

    // Subtle concentric vinyl/soundwave emblem inside default art
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.lineWidth = 2 * scale;
    for (let r = 1; r <= 3; r++) {
      g.beginPath();
      g.arc(artCenterX, artCenterY, (28 + r * 26 + bassEnergy * 8) * scale, 0, Math.PI * 2);
      g.stroke();
    }

    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.font = `700 ${Math.round(64 * scale)}px "Plus Jakarta Sans", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('SW', artCenterX, artCenterY + 3 * scale);
  }
  g.restore();

  // Crisp subtle glass border around art
  g.strokeStyle = 'rgba(255,255,255,0.22)';
  g.lineWidth = 2 * scale;
  g.beginPath();
  g.roundRect(artX, artY, artSize, artSize, 26 * scale);
  g.stroke();

  // 6. Title & Artist Typography
  const textY = artCenterY + artBase / 2 + (style === 'radial' ? 86 : 64) * scale;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#f8fafc';
  g.font = `700 ${Math.round((isVertical ? 36 : 30) * scale)}px "Plus Jakarta Sans", sans-serif`;
  g.fillText((p.title || 'NTK StudioWave Clip').slice(0, 28), width / 2, textY);

  g.fillStyle = 'rgba(226, 232, 240, 0.72)';
  g.font = `500 ${Math.round((isVertical ? 22 : 19) * scale)}px "DM Sans", sans-serif`;
  g.fillText((p.artist || 'NTK StudioWave Audio').slice(0, 34), width / 2, textY + 36 * scale);

  // 7. Lower Animated Audio Visualizer (Pulse Bars, Smooth Ribbon Wave, or Minimal Companion for Radial)
  const waveCenterY = height - (isVertical ? 285 : 152) * scale;
  const padX = 56 * scale;
  const usableW = width - padX * 2;

  if (style === 'bars') {
    const bars = Math.min(peakCaps.length, 44);
    const step = usableW / bars;
    const maxH = (isVertical ? 205 : 124) * scale;

    const barGrad = g.createLinearGradient(padX, waveCenterY - maxH / 2, padX + usableW, waveCenterY + maxH / 2);
    barGrad.addColorStop(0, pal.primary);
    barGrad.addColorStop(1, pal.secondary);

    for (let i = 0; i < bars; i++) {
      // Symmetrical frequency layout feels musical and balanced
      const normIdx = Math.abs((i / (bars - 1)) * 2 - 1);
      const bin = Math.floor(normIdx * (freqData.length * 0.65));
      const rawVal = freqData[bin] / 255;
      // Smooth peak-hold cap decay
      const prevCap = peakCaps[i] ?? 0;
      const nextCap = rawVal >= prevCap ? rawVal : Math.max(rawVal, prevCap - 0.028);
      peakCaps[i] = nextCap;

      const barH = Math.max(10 * scale, rawVal * maxH);
      const x = padX + i * step + 2 * scale;
      const barW = Math.max(3 * scale, step - 5 * scale);
      const played = i / bars <= p.progress;

      g.fillStyle = played ? barGrad : 'rgba(148, 163, 184, 0.32)';
      g.beginPath();
      g.roundRect(x, waveCenterY - barH / 2, barW, barH, Math.min(6 * scale, barW / 2));
      g.fill();

      // Floating glowing peak-hold cap above each bar
      const capY = waveCenterY - Math.max(10 * scale, nextCap * maxH) / 2 - 7 * scale;
      g.fillStyle = played ? '#ffffff' : 'rgba(226, 232, 240, 0.45)';
      g.beginPath();
      g.roundRect(x, capY, barW, 3.5 * scale, 2 * scale);
      g.fill();
    }
  } else if (style === 'wave') {
    // 3 Layered Glowing Audio-Reactive Sine/Ribbon Waves
    const layers = [
      { color: pal.primary, alpha: 0.95, ampMult: 1.0, freqMult: 1.0, speed: 3.1, width: 4.2 },
      { color: pal.secondary, alpha: 0.65, ampMult: 0.72, freqMult: 1.45, speed: -2.4, width: 3.0 },
      { color: '#ffffff', alpha: 0.35, ampMult: 0.45, freqMult: 2.1, speed: 4.0, width: 2.0 },
    ];
    const maxAmp = (isVertical ? 88 : 56) * scale;
    const pts = 72;

    for (const layer of layers) {
      g.save();
      g.strokeStyle = layer.color;
      g.globalAlpha = layer.alpha;
      g.lineWidth = layer.width * scale;
      g.lineCap = 'round';
      g.shadowColor = layer.color;
      g.shadowBlur = 14 * scale;
      g.beginPath();
      for (let i = 0; i <= pts; i++) {
        const u = i / pts;
        const x = padX + u * usableW;
        const envelope = Math.sin(u * Math.PI); // Taper gracefully to zero at edges
        const bin = Math.floor(u * (freqData.length * 0.6));
        const spec = freqData[bin] / 255;
        const timeMod = p.timeData ? ((p.timeData[i % p.timeData.length] - 128) / 128) * 0.45 : 0;
        const yOff =
          (Math.sin(u * Math.PI * 4 * layer.freqMult + elapsedSec * layer.speed) *
            (0.2 + spec * 0.85) +
            timeMod) *
          envelope *
          maxAmp *
          layer.ampMult;
        const y = waveCenterY + yOff;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      g.restore();
    }
  } else {
    // Subtle minimalist live shimmer line beneath text when style === 'radial'
    const bars = 32;
    const step = (usableW * 0.7) / bars;
    const startX = (width - usableW * 0.7) / 2;
    for (let i = 0; i < bars; i++) {
      const bin = Math.floor((i / bars) * (freqData.length * 0.5));
      const v = freqData[bin] / 255;
      const h = (6 + v * 36) * scale;
      g.fillStyle = i / bars <= p.progress ? pal.primary : 'rgba(148,163,184,0.3)';
      g.beginPath();
      g.roundRect(startX + i * step, waveCenterY - h / 2, Math.max(2.5 * scale, step - 4 * scale), h, 3 * scale);
      g.fill();
    }
  }

  // 8. Progress Track + Glowing Playhead + Time Labels
  const pbY = height - (isVertical ? 96 : 58) * scale;
  g.fillStyle = 'rgba(255,255,255,0.16)';
  g.beginPath();
  g.roundRect(padX, pbY, usableW, 8 * scale, 4 * scale);
  g.fill();

  const fillW = Math.max(8 * scale, usableW * p.progress);
  const pbGrad = g.createLinearGradient(padX, pbY, padX + fillW, pbY);
  pbGrad.addColorStop(0, pal.primary);
  pbGrad.addColorStop(1, pal.secondary);
  g.fillStyle = pbGrad;
  g.beginPath();
  g.roundRect(padX, pbY, fillW, 8 * scale, 4 * scale);
  g.fill();

  // Glowing playhead thumb
  g.save();
  g.shadowColor = '#ffffff';
  g.shadowBlur = 10 * scale;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(padX + usableW * p.progress, pbY + 4 * scale, 7 * scale, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // Elapsed / Total Time Stamp
  g.font = `600 ${Math.round(16 * scale)}px "JetBrains Mono", monospace`;
  g.fillStyle = 'rgba(226, 232, 240, 0.75)';
  g.textAlign = 'left';
  g.fillText(formatDuration(Math.min(p.totalDurationSec, elapsedSec), false), padX, pbY + 30 * scale);
  g.textAlign = 'right';
  g.fillText(formatDuration(p.totalDurationSec, false), padX + usableW, pbY + 30 * scale);
}
