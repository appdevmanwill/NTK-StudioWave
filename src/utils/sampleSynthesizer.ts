import type { BookmarkMarker, StarterSoundItem, TranscriptSegment } from '../types/audio';

export const STARTER_SOUND_PACK: StarterSoundItem[] = [
  {
    id: 'bed-lofi',
    name: 'Warm Lo-Fi Rhodes Bed',
    category: 'music',
    durationSec: 20,
    description: 'Gentle Rhodes-style electric piano chords with soft tape warmth for podcasts.',
  },
  {
    id: 'bed-ambient',
    name: 'Soft Studio Ambient Pad',
    category: 'music',
    durationSec: 20,
    description: 'Calm, airy acoustic pad that sits smoothly underneath voiceovers.',
  },
  {
    id: 'bed-upbeat',
    name: 'Acoustic Pulse Underscore',
    category: 'music',
    durationSec: 20,
    description: 'Light plucked pulse ideal for explainers, tutorials, and intros.',
  },
  {
    id: 'sfx-chime',
    name: 'Clean Studio Chime',
    category: 'sfx',
    durationSec: 1.6,
    description: 'Bright two-note bell chime for chapter transitions or tips.',
  },
  {
    id: 'sfx-whoosh',
    name: 'Airy Page Whoosh',
    category: 'sfx',
    durationSec: 0.9,
    description: 'Smooth filtered air sweep for scene or topic changes.',
  },
  {
    id: 'sfx-stinger',
    name: 'Podcast Intro Stinger',
    category: 'sfx',
    durationSec: 2.2,
    description: 'Warm rising triad stinger to open or close a segment.',
  },
  {
    id: 'sfx-pop',
    name: 'Subtle Highlight Pop',
    category: 'sfx',
    durationSec: 0.35,
    description: 'Crisp tactile pop to emphasize a key moment.',
  },
];

/**
 * Helper to synthesize a spoken-syllable vocal formant burst directly into PCM.
 */
function renderVocalPhrase(
  target: Float32Array,
  sampleRate: number,
  startSec: number,
  syllables: Array<{ dur: number; f0: number; f1: number; f2: number; amp: number }>,
  rngSeed: number
) {
  let cursor = Math.floor(startSec * sampleRate);
  let seed = rngSeed;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };

  let phase0 = 0;
  let phase1 = 0;
  let phase2 = 0;

  for (const syl of syllables) {
    const len = Math.floor(syl.dur * sampleRate);
    for (let i = 0; i < len; i++) {
      const idx = cursor + i;
      if (idx >= target.length) break;
      const u = i / Math.max(1, len);
      // Natural syllable envelope with slight attack and decay
      const env =
        Math.sin(Math.PI * Math.pow(u, 0.78)) *
        (0.75 + 0.25 * Math.sin(2 * Math.PI * 3.5 * u));
      // Subtle natural pitch inflection
      const pitch = syl.f0 * (1 + 0.06 * Math.sin(Math.PI * u) - 0.04 * u);
      phase0 += (2 * Math.PI * pitch) / sampleRate;
      phase1 += (2 * Math.PI * syl.f1) / sampleRate;
      phase2 += (2 * Math.PI * syl.f2) / sampleRate;

      // Glottal pulse harmonics shaped by F1 and F2 vocal formants
      const glottal =
        0.55 * Math.sin(phase0) +
        0.28 * Math.sin(phase0 * 2) +
        0.14 * Math.sin(phase0 * 3);
      const formant1 = Math.sin(phase1) * (0.5 + 0.5 * Math.sin(phase0));
      const formant2 = Math.sin(phase2) * (0.4 + 0.6 * Math.sin(phase0 * 2));
      const breath = nextRand() * 0.035;

      target[idx] += (glottal * 0.45 + formant1 * 0.35 + formant2 * 0.2 + breath) * env * syl.amp;
    }
    cursor += len + Math.floor(0.035 * sampleRate);
  }
}

/**
 * Generates a realistic 15-second "Try-It Sample Recording" 100% offline:
 * - Contains realistic vocal formant phrases
 * - Subtle 60Hz room hum + light room hiss (so Studio Voice Polish / Noise Cleanup makes a clear difference)
 * - 3 awkward long pauses (so Smart Silence Removal immediately finds pauses & saves seconds)
 * - 1 intentionally repeated phrase (so Repetition & Retake Removal flags it in purple immediately!)
 * - Matching starter bookmarks and transcript with filler words ("um", "uh").
 */
export function createTryItSampleRecording(ctx: BaseAudioContext): {
  buffer: AudioBuffer;
  title: string;
  bookmarks: BookmarkMarker[];
  transcript: TranscriptSegment[];
} {
  const sampleRate = ctx.sampleRate || 44100;
  const durationSec = 15.0;
  const totalSamples = Math.floor(sampleRate * durationSec);
  const buffer = ctx.createBuffer(1, totalSamples, sampleRate);
  const data = buffer.getChannelData(0);

  // 1. Add subtle 60Hz AC room hum + gentle air-conditioner floor hiss
  let noiseSeed = 1337;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    noiseSeed = (noiseSeed * 1664525 + 1013904223) >>> 0;
    const white = (noiseSeed / 0xffffffff) * 2 - 1;
    const hum =
      0.011 * Math.sin(2 * Math.PI * 60 * t) +
      0.005 * Math.sin(2 * Math.PI * 120 * t);
    const roomFloor = white * 0.006;
    data[i] = hum + roomFloor;
  }

  // Phrase A (0.35s - 1.55s): Short crisp intro greeting (distinct cadence from Phrase B/C)
  renderVocalPhrase(
    data,
    sampleRate,
    0.35,
    [
      { dur: 0.42, f0: 210, f1: 360, f2: 2350, amp: 0.34 },
      { dur: 0.16, f0: 195, f1: 820, f2: 1120, amp: 0.26 },
      { dur: 0.48, f0: 125, f1: 420, f2: 1980, amp: 0.38 },
    ],
    101
  );

  // Awkward Pause #1: ~2.35s to 4.10s (1.75s of room hum)

  // Phrase B (4.10s - 6.05s): Repeated Take #1 (false start — identical syllable profile to Phrase C)
  const repeatedSyllables = [
    { dur: 0.26, f0: 158, f1: 640, f2: 1520, amp: 0.44 },
    { dur: 0.22, f0: 172, f1: 410, f2: 2050, amp: 0.48 },
    { dur: 0.30, f0: 166, f1: 540, f2: 1760, amp: 0.46 },
    { dur: 0.25, f0: 150, f1: 720, f2: 1180, amp: 0.42 },
    { dur: 0.34, f0: 160, f1: 480, f2: 1880, amp: 0.47 },
    { dur: 0.30, f0: 142, f1: 590, f2: 1400, amp: 0.40 },
  ];
  renderVocalPhrase(data, sampleRate, 4.1, repeatedSyllables, 202);

  // Awkward Pause #2: ~6.05s to 7.45s (1.4s pause before retaking the line)

  // Phrase C (7.45s - 9.40s): Repeated Take #2 (cleaner, slightly stronger retake)
  renderVocalPhrase(data, sampleRate, 7.45, repeatedSyllables, 202);

  // Awkward Pause #3: ~9.40s to 11.45s (2.05s awkward silence)

  // Phrase D (11.45s - 14.35s): Confident closing statement
  renderVocalPhrase(
    data,
    sampleRate,
    11.45,
    [
      { dur: 0.28, f0: 165, f1: 490, f2: 1820, amp: 0.50 },
      { dur: 0.24, f0: 180, f1: 620, f2: 1480, amp: 0.52 },
      { dur: 0.30, f0: 174, f1: 390, f2: 2140, amp: 0.54 },
      { dur: 0.26, f0: 158, f1: 700, f2: 1220, amp: 0.48 },
      { dur: 0.32, f0: 168, f1: 520, f2: 1740, amp: 0.50 },
      { dur: 0.28, f0: 154, f1: 440, f2: 1960, amp: 0.46 },
      { dur: 0.36, f0: 144, f1: 580, f2: 1460, amp: 0.45 },
      { dur: 0.42, f0: 132, f1: 480, f2: 1620, amp: 0.42 },
    ],
    404
  );

  // Soft limiter so sample never clips
  for (let i = 0; i < totalSamples; i++) {
    data[i] = Math.tanh(data[i] * 1.15);
  }

  return {
    buffer,
    title: '15-Second Try-It Sample',
    bookmarks: [
      { id: 'bm-intro', time: 0.35, label: 'Intro Hook', starred: true },
      { id: 'bm-outro', time: 11.45, label: 'Clean Take Outro', starred: true },
    ],
    transcript: [
      {
        id: 'tr-1',
        start: 0.35,
        end: 2.35,
        text: 'Welcome to, um, NTK StudioWave — your shared office audio studio.',
      },
      {
        id: 'tr-2',
        start: 4.1,
        end: 6.05,
        text: 'Uh, today we will show how fast you can clean pauses and retakes.',
      },
      {
        id: 'tr-3',
        start: 7.45,
        end: 9.4,
        text: 'Today we will show how fast you can clean pauses and retakes.',
      },
      {
        id: 'tr-4',
        start: 11.45,
        end: 14.35,
        text: 'Hit Studio Polish, shrink the long silences, and export in seconds!',
      },
    ],
  };
}

/**
 * Synthesize any item from STARTER_SOUND_PACK into a stereo AudioBuffer 100% offline.
 */
export function synthesizeStarterSound(ctx: BaseAudioContext, itemId: string): AudioBuffer {
  const sr = ctx.sampleRate || 44100;
  const item = STARTER_SOUND_PACK.find((i) => i.id === itemId);
  const dur = item?.durationSec ?? 2.0;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(2, len, sr);
  const left = buf.getChannelData(0);
  const right = buf.getChannelData(1);

  if (itemId === 'bed-lofi') {
    // Warm Lo-Fi electric piano chord progression: Fmaj7 -> Em7 -> Dm7 -> Cmaj7
    const chords = [
      [174.61, 220.0, 261.63, 329.63],
      [164.81, 196.0, 246.94, 293.66],
      [146.83, 174.61, 220.0, 261.63],
      [130.81, 164.81, 196.0, 246.94],
    ];
    const barDur = dur / chords.length;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const barIdx = Math.min(chords.length - 1, Math.floor(t / barDur));
      const barT = t - barIdx * barDur;
      const env = Math.min(1, barT / 0.12) * Math.exp(-barT * 0.45);
      const chord = chords[barIdx];
      let l = 0;
      let r = 0;
      for (let n = 0; n < chord.length; n++) {
        const f = chord[n];
        const w = Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-barT * 1.4);
        const pan = (n / (chord.length - 1)) * 0.6 - 0.3;
        l += w * (0.5 - pan * 0.5);
        r += w * (0.5 + pan * 0.5);
      }
      // Subtle gentle bass pulse
      const bass = Math.sin(2 * Math.PI * (chord[0] / 2) * t) * 0.25 * env;
      left[i] = (l * 0.16 * env + bass) * 0.7;
      right[i] = (r * 0.16 * env + bass) * 0.7;
    }
    return buf;
  }

  if (itemId === 'bed-ambient') {
    const freqs = [130.81, 196.0, 246.94, 293.66, 392.0];
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const fadeIn = Math.min(1, t / 1.5);
      const fadeOut = Math.min(1, (dur - t) / 1.5);
      const master = fadeIn * fadeOut;
      let l = 0;
      let r = 0;
      for (let k = 0; k < freqs.length; k++) {
        const lfo = 0.65 + 0.35 * Math.sin(2 * Math.PI * (0.12 + k * 0.05) * t + k);
        l += Math.sin(2 * Math.PI * (freqs[k] * 0.998) * t) * lfo;
        r += Math.sin(2 * Math.PI * (freqs[k] * 1.002) * t) * lfo;
      }
      left[i] = l * 0.075 * master;
      right[i] = r * 0.075 * master;
    }
    return buf;
  }

  if (itemId === 'bed-upbeat') {
    const notes = [261.63, 329.63, 392.0, 329.63, 293.66, 349.23, 440.0, 392.0];
    const step = 0.5;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const stepIdx = Math.floor(t / step);
      const stepT = t - stepIdx * step;
      const f = notes[stepIdx % notes.length];
      const pluck = Math.min(1, stepT / 0.01) * Math.exp(-stepT * 5.5);
      const sig =
        (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 2 * t)) * pluck * 0.25;
      const pad = Math.sin(2 * Math.PI * 130.81 * t) * 0.1;
      left[i] = sig * 0.85 + pad;
      right[i] = sig * 0.75 + pad;
    }
    return buf;
  }

  if (itemId === 'sfx-chime') {
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const n1 = Math.sin(2 * Math.PI * 659.25 * t) * Math.exp(-t * 3.8) * 0.4;
      const n2 =
        t > 0.16
          ? Math.sin(2 * Math.PI * 987.77 * (t - 0.16)) * Math.exp(-(t - 0.16) * 2.8) * 0.45
          : 0;
      const shimmer = Math.sin(2 * Math.PI * 1975.53 * t) * Math.exp(-t * 6.0) * 0.12;
      left[i] = n1 + n2 * 0.9 + shimmer;
      right[i] = n1 * 0.9 + n2 + shimmer;
    }
    return buf;
  }

  if (itemId === 'sfx-whoosh') {
    let seed = 98765;
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const u = i / len;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const white = (seed / 0xffffffff) * 2 - 1;
      const env = Math.sin(Math.PI * u);
      const cutoff = 0.02 + 0.35 * env * env;
      lp += cutoff * (white - lp);
      left[i] = lp * env * 0.65;
      right[i] = lp * env * 0.65 * (0.8 + 0.2 * u);
    }
    return buf;
  }

  if (itemId === 'sfx-stinger') {
    const notes = [
      { start: 0.0, f: 261.63 },
      { start: 0.18, f: 329.63 },
      { start: 0.36, f: 392.0 },
      { start: 0.56, f: 523.25 },
    ];
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      let sum = 0;
      for (const n of notes) {
        if (t >= n.start) {
          const dt = t - n.start;
          const env = Math.min(1, dt / 0.015) * Math.exp(-dt * 2.4);
          sum += (Math.sin(2 * Math.PI * n.f * dt) + 0.35 * Math.sin(2 * Math.PI * n.f * 2 * dt)) * env * 0.26;
        }
      }
      left[i] = sum;
      right[i] = sum * 0.96;
    }
    return buf;
  }

  // Default: sfx-pop
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const freq = 520 * Math.exp(-t * 14) + 140;
    const env = Math.min(1, t / 0.004) * Math.exp(-t * 18);
    const val = Math.sin(2 * Math.PI * freq * t) * env * 0.55;
    left[i] = val;
    right[i] = val;
  }
  return buf;
}
