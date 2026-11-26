import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TRACK_EQ,
  NoiseGateStateMachine,
  applyDynamicsProcessorPCM,
  applyNaturalPacingPCM,
  applyNoiseGatePCM,
  calculateBitrateForTargetSize,
  calculateTimeSaved,
  clampTrackEq,
  countFillerWords,
  cutRangePCM,
  dbToLinear,
  detectRepetitions,
  detectSilences,
  encodeFlacPCM,
  encodeWavPCM,
  estimateFileSizeBytes,
  formatDuration,
  formatSrtCaptions,
  hashPin,
  isTrackEqActive,
  removeSilencesPCM,
  snapToZeroCrossing,
} from './audioDsp';
import { VAD_SENSITIVITY_PRESETS, VadStateMachine } from '../services/vadService';
import {
  applyAutoTunePCM,
  computeTrackPlaybackParams,
  detectPitchFFT,
  freqToMidi,
  snapMidiToScale,
} from './pitchCorrection';
import { applySpectralSubtractionPCM, estimateNoiseProfileFFT } from './spectralDenoise';
import { analyzeForMastering, applyMasteringChainPCM } from './masteringEngine';
import {
  DEFAULT_SOUND_BALANCE,
  computeAutoDuckingCurve,
  normalizeSteadyVolumePCM,
  rebalanceSoundElementsPCM,
  transformAudioRegionPCM,
} from './ruleBasedEditorDsp';
import {
  applyAutomationCurvePCM,
  computeSpectrogramGrid,
  deClickAndDePlosivePCM,
  deReverbPCM,
  eraseSpectralBoxPCM,
} from './spectralRepairDsp';

function makeSine(sampleRate: number, durationSec: number, freqHz: number, amp = 0.5): Float32Array {
  const len = Math.floor(sampleRate * durationSec);
  const arr = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    arr[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amp;
  }
  return arr;
}

function concatArrays(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

test('detectSilences locates pauses accurately and calculates time saved', () => {
  const sr = 8000;
  // 1s voice -> 1.5s silence -> 1s voice -> 1.2s silence -> 1s voice
  const pcm = concatArrays([
    makeSine(sr, 1.0, 220, 0.4),
    new Float32Array(Math.floor(sr * 1.5)),
    makeSine(sr, 1.0, 330, 0.4),
    new Float32Array(Math.floor(sr * 1.2)),
    makeSine(sr, 1.0, 260, 0.4),
  ]);

  const { regions } = detectSilences(pcm, sr, { thresholdDb: -36, minSilenceSec: 0.5 });
  assert.equal(regions.length, 2);
  assert.ok(regions[0].duration >= 1.4 && regions[0].duration <= 1.6);
  assert.ok(regions[1].duration >= 1.1 && regions[1].duration <= 1.3);

  const saved = calculateTimeSaved(regions, 0.35);
  assert.ok(saved > 1.8 && saved < 2.2);

  const reduced = removeSilencesPCM([pcm], sr, regions, 0.35, 15);
  assert.ok(reduced.savedSec > 1.8);
  assert.ok(reduced.channels[0].length < pcm.length);
  // Ensure no NaN samples after crossfade
  for (let i = 0; i < reduced.channels[0].length; i += 97) {
    assert.ok(Number.isFinite(reduced.channels[0][i]));
  }
});

test('detectRepetitions identifies adjacent repeated phrases via acoustic fingerprints', () => {
  const sr = 8000;
  // Create a distinctive modulated phrase
  const makePhrase = (freqA: number, freqB: number) => {
    const len = Math.floor(sr * 1.1);
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.sin((Math.PI * i) / len) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 5 * t));
      const f = i < len / 2 ? freqA : freqB;
      out[i] = Math.sin(2 * Math.PI * f * t) * 0.45 * env;
    }
    return out;
  };

  const repeatedPhrase = makePhrase(210, 340);
  const differentPhrase = makePhrase(480, 140);
  const gap = new Float32Array(Math.floor(sr * 0.6));

  const pcm = concatArrays([
    repeatedPhrase,
    gap,
    repeatedPhrase, // repeat of phrase 1!
    gap,
    differentPhrase,
  ]);

  const reps = detectRepetitions(pcm, sr, { thresholdDb: -34, similarityThreshold: 0.88 });
  assert.ok(reps.length >= 1, 'Expected at least 1 repeated take to be detected');
  assert.ok(reps[0].start < 0.25 && reps[0].end <= 1.35);
  assert.ok(reps[0].similarity >= 0.9);
});

test('snapToZeroCrossing snaps onto a quiet zero-crossing point', () => {
  const sr = 8000;
  const pcm = makeSine(sr, 0.5, 200, 0.5);
  const snapped = snapToZeroCrossing(pcm, sr, 0.25, 0.02);
  const idx = Math.round(snapped * sr);
  assert.ok(Math.abs(pcm[idx]) < 0.15);
});

test('cutRangePCM removes a region smoothly without NaN values', () => {
  const sr = 8000;
  const pcm = makeSine(sr, 2.0, 250, 0.4);
  const out = cutRangePCM([pcm], sr, 0.5, 1.0, 15);
  assert.ok(out[0].length < pcm.length);
  assert.ok(Math.abs(out[0].length / sr - 1.5) < 0.05);
});

test('encodeWavPCM produces valid RIFF WAVE 16-bit PCM header and payload', () => {
  const sr = 16000;
  const pcm = makeSine(sr, 0.25, 440, 0.5);
  const wav = encodeWavPCM([pcm], sr);
  assert.equal(String.fromCharCode(wav[0], wav[1], wav[2], wav[3]), 'RIFF');
  assert.equal(String.fromCharCode(wav[8], wav[9], wav[10], wav[11]), 'WAVE');
  assert.equal(wav.length, 44 + pcm.length * 2);
});

test('encodeFlacPCM produces valid fLaC magic bytes and RFC 9639 STREAMINFO', () => {
  const sr = 44100;
  const pcm = makeSine(sr, 0.1, 440, 0.5);
  const flac = encodeFlacPCM([pcm], sr);
  assert.equal(String.fromCharCode(flac[0], flac[1], flac[2], flac[3]), 'fLaC');
  assert.equal(flac[4], 0x80); // Last metadata block + STREAMINFO
  assert.ok(flac.length > 42 + pcm.length * 2);
});

test('bitrate and target file size calculators fit within budget', () => {
  const calc = calculateBitrateForTargetSize({
    durationSec: 300, // 5 minutes
    targetSizeMb: 5,
    format: 'mp3',
    channels: 1,
  });
  assert.ok(calc.recommendedBitrateKbps >= 96 && calc.recommendedBitrateKbps <= 160);
  const est = estimateFileSizeBytes({
    durationSec: 300,
    format: 'mp3',
    bitrateKbps: calc.recommendedBitrateKbps,
    sampleRate: 44100,
    channels: 1,
  });
  assert.ok(est <= 5 * 1024 * 1024);
});

test('captions formatting, filler word counting, and local PIN hashing work deterministically', () => {
  const srt = formatSrtCaptions([
    { id: '1', start: 0, end: 2.5, text: 'Welcome to, um, StudioWave.' },
  ]);
  assert.ok(srt.includes('00:00:00,000 --> 00:00:02,500'));
  assert.equal(countFillerWords('So, um, like, uh, welcome basically!'), 4);
  assert.equal(formatDuration(125.4, true), '02:05.4');
  assert.equal(hashPin('1234'), hashPin('1234'));
  assert.notEqual(hashPin('1234'), hashPin('4321'));
});

test('Natural Pacing shrinks gaps > 0.5s to exact 0.3s with 15ms linear crossfade and preserves short gaps', () => {
  const sr = 10000; // 10 samples per ms -> 15ms = 150 samples exact
  // 1.0s tone -> 1.5s silence (>0.5s, must shrink to 0.3s) -> 1.0s tone -> 0.4s silence (<0.5s, keep intact) -> 1.0s tone
  const pcm = concatArrays([
    makeSine(sr, 1.0, 220, 0.5),
    new Float32Array(Math.floor(sr * 1.5)),
    makeSine(sr, 1.0, 330, 0.5),
    new Float32Array(Math.floor(sr * 0.4)),
    makeSine(sr, 1.0, 440, 0.5),
  ]);

  const result = applyNaturalPacingPCM([pcm], sr, {
    thresholdDb: -36,
    minSilenceSec: 0.5,
    targetGapSec: 0.3,
    crossfadeMs: 15,
  });

  // Only the 1.5s gap should be detected (> 0.5s); the 0.4s gap is untouched
  assert.equal(result.regions.length, 1);

  // Expected total length: 1.0 + 0.3 + 1.0 + 0.4 + 1.0 = 3.70s (within ±0.02s frame quantization)
  const resultingSec = result.channels[0].length / sr;
  assert.ok(
    Math.abs(resultingSec - 3.7) <= 0.025,
    `Expected ~3.70s after shrinking 1.5s gap to 0.3s, got ${resultingSec.toFixed(4)}s`
  );
  assert.ok(Math.abs(result.savedSec - 1.2) <= 0.025);
});

test('VadStateMachine pauses after 2 seconds below threshold and resumes immediately on speech', () => {
  const vad = new VadStateMachine({
    thresholdDb: VAD_SENSITIVITY_PRESETS.medium.thresholdDb, // -40 dB
    silenceHoldMs: 2000,
  });

  // Speaking at t=0
  let res = vad.evaluate(-22, 0);
  assert.equal(res.state, 'speaking');
  assert.equal(res.shouldPause, false);

  // Drops below threshold at t=1000ms -> waiting, not paused yet
  res = vad.evaluate(-55, 1000);
  assert.equal(res.state, 'waiting');
  assert.equal(res.shouldPause, false);

  // Still silent at t=2900ms (1.9s elapsed) -> still waiting
  res = vad.evaluate(-58, 2900);
  assert.equal(res.state, 'waiting');
  assert.equal(res.shouldPause, false);

  // Crosses 2.0s silence at t=3000ms -> auto-pause triggers!
  res = vad.evaluate(-58, 3000);
  assert.equal(res.state, 'paused');
  assert.equal(res.shouldPause, true);

  // Remains paused while still silent
  res = vad.evaluate(-56, 3500);
  assert.equal(res.state, 'paused');
  assert.equal(res.shouldPause, false);

  // Speech returns above threshold -> auto-resumes immediately!
  res = vad.evaluate(-25, 4000);
  assert.equal(res.state, 'speaking');
  assert.equal(res.shouldResume, true);
});

test('NoiseGateStateMachine opens above threshold, holds briefly, closes below threshold, and bypasses when disabled', () => {
  const gate = new NoiseGateStateMachine({
    thresholdDb: -35,
    hysteresisDb: 2.5,
    holdMs: 80,
    floorGain: 0.02,
  });

  // Starts closed below threshold
  let state = gate.evaluate(-50, 0, true);
  assert.equal(state.isOpen, false);
  assert.equal(state.targetGain, 0.02);

  // Opens immediately when signal exceeds threshold
  state = gate.evaluate(-20, 50, true);
  assert.equal(state.isOpen, true);
  assert.equal(state.targetGain, 1.0);

  // Brief dip below threshold during hold window keeps gate open
  state = gate.evaluate(-50, 100, true);
  assert.equal(state.isOpen, true);
  assert.equal(state.targetGain, 1.0);

  // Once hold time (80ms) elapses below close threshold, gate closes cleanly
  state = gate.evaluate(-50, 140, true);
  assert.equal(state.isOpen, false);
  assert.equal(state.targetGain, 0.02);

  // When disabled, bypasses to unity gain even on quiet noise floor
  state = gate.evaluate(-65, 200, false);
  assert.equal(state.isOpen, true);
  assert.equal(state.targetGain, 1.0);
});

test('applyNoiseGatePCM reduces quiet background noise floor while preserving active vocal signal', () => {
  const sr = 10000;
  // 0.8s active tone (~-9 dBFS) -> 1.0s low-level room hum (~-46 dBFS) -> 0.8s active tone
  const voice = makeSine(sr, 0.8, 300, 0.5);
  const roomHum = makeSine(sr, 1.0, 60, 0.007);
  const input = concatArrays([voice, roomHum, voice]);

  const [gated] = applyNoiseGatePCM([input], sr, {
    thresholdDb: -35,
    floorGain: 0.02,
    attackSec: 0.008,
    holdMs: 60,
    releaseSec: 0.05,
  });

  const rmsSlice = (arr: Float32Array, startSec: number, endSec: number) => {
    const s = Math.floor(startSec * sr);
    const e = Math.floor(endSec * sr);
    let sumSq = 0;
    for (let i = s; i < e; i++) sumSq += arr[i] * arr[i];
    return Math.sqrt(sumSq / Math.max(1, e - s));
  };

  // Middle of first active section should remain nearly untouched (> 90% amplitude)
  const rawVoiceRms = rmsSlice(input, 0.2, 0.6);
  const gatedVoiceRms = rmsSlice(gated, 0.2, 0.6);
  assert.ok(
    gatedVoiceRms / rawVoiceRms > 0.9,
    `Expected active voice to stay preserved, ratio=${(gatedVoiceRms / rawVoiceRms).toFixed(3)}`
  );

  // Middle of background noise section should be heavily attenuated (< 10% of raw hum RMS)
  const rawHumRms = rmsSlice(input, 1.25, 1.65);
  const gatedHumRms = rmsSlice(gated, 1.25, 1.65);
  assert.ok(
    gatedHumRms / rawHumRms < 0.1,
    `Expected background hum to be heavily attenuated, ratio=${(gatedHumRms / rawHumRms).toFixed(3)}`
  );

  // Ensure finite output everywhere
  for (let i = 0; i < gated.length; i += 53) {
    assert.ok(Number.isFinite(gated[i]));
  }
});

test('detectPitchFFT accurately estimates monophonic fundamental frequency via Radix-2 FFT + HPS', () => {
  const sr = 16000;
  const len = 2048;
  // Synthesize vocal-like harmonic waveform at 220 Hz (A3) with 2nd & 3rd harmonics
  const signal = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    signal[i] =
      0.5 * Math.sin(2 * Math.PI * 220 * t) +
      0.3 * Math.sin(2 * Math.PI * 440 * t) +
      0.15 * Math.sin(2 * Math.PI * 660 * t);
  }

  const res = detectPitchFFT(signal, sr);
  assert.equal(res.voiced, true);
  assert.ok(
    Math.abs(res.frequencyHz - 220) < 3.0,
    `Expected ~220 Hz, got ${res.frequencyHz.toFixed(2)} Hz`
  );
});

test('snapMidiToScale snaps out-of-scale notes to nearest semitone in chosen musical scale', () => {
  // MIDI 58.2 (slightly sharp A#3) in C Major (no A#) must snap to B3 (MIDI 59)
  const snapC = snapMidiToScale(58.2, 'C', 'major');
  assert.equal(snapC.targetMidi, 59);
  assert.equal(snapC.targetNote, 'B3');
  assert.ok(snapC.shiftSemitones > 0.7 && snapC.shiftSemitones < 0.9);

  // MIDI 57.9 (slightly flat A#3) in Chromatic snaps to A#3 (MIDI 58)
  const snapChromatic = snapMidiToScale(57.9, 'C', 'chromatic');
  assert.equal(snapChromatic.targetMidi, 58);
  assert.equal(snapChromatic.targetNote, 'A#3');
});

test('applyAutoTunePCM shifts out-of-tune monophonic vocal tone onto nearest scale semitone', () => {
  const sr = 16000;
  // 238 Hz is between A#3 (233.08 Hz) and B3 (246.94 Hz) -> nearest note in C Major is B3 (246.94 Hz)
  const input = makeSine(sr, 0.7, 238, 0.45);
  const [tuned] = applyAutoTunePCM([input], sr, {
    key: 'C',
    scale: 'major',
    strength: 100,
  });

  assert.equal(tuned.length, input.length);
  // Analyze middle steady-state slice after retune ramp settles
  const slice = tuned.subarray(Math.floor(sr * 0.25), Math.floor(sr * 0.25) + 2048);
  const pitchAfter = detectPitchFFT(slice, sr);
  assert.equal(pitchAfter.voiced, true);
  const targetB3 = 246.94;
  assert.ok(
    Math.abs(pitchAfter.frequencyHz - targetB3) < 5.5,
    `Expected Auto-Tune to shift 238 Hz -> ~246.94 Hz (B3), got ${pitchAfter.frequencyHz.toFixed(2)} Hz (MIDI ${freqToMidi(pitchAfter.frequencyHz).toFixed(2)})`
  );
});

test('computeTrackPlaybackParams enforces DAW Solo/Mute routing and clamps Gain/Pan', () => {
  const routing = computeTrackPlaybackParams([
    { id: 't1', gain: 1.0, pan: -0.5, muted: false, solo: false },
    { id: 't2', gain: 0.8, pan: 0.75, muted: false, solo: true },
    { id: 't3', gain: 2.0, pan: 1.8, muted: true, solo: true },
  ]);

  // Because t2 is soloed, non-soloed t1 must be silenced
  assert.equal(routing.t1.audible, false);
  assert.equal(routing.t1.effectiveGain, 0);

  // Soloed and unmuted t2 is audible with exact gain and pan
  assert.equal(routing.t2.audible, true);
  assert.equal(routing.t2.effectiveGain, 0.8);
  assert.equal(routing.t2.pan, 0.75);

  // Mute overrides Solo on t3, and pan is clamped to +1
  assert.equal(routing.t3.audible, false);
  assert.equal(routing.t3.effectiveGain, 0);
  assert.equal(routing.t3.pan, 1);
});

test('Track 3-band parametric EQ helpers clamp bounds safely and detect flat vs active EQ', () => {
  assert.equal(isTrackEqActive(DEFAULT_TRACK_EQ), false);
  const adjusted = clampTrackEq({
    enabled: true,
    lowGainDb: 25, // clamps to +12
    lowFreqHz: 20, // clamps to 60
    midGainDb: -4.5,
    midFreqHz: 1800,
    midQ: 10, // clamps to 4.0
    highGainDb: 3.0,
    highFreqHz: 22000, // clamps to 14000
  });
  assert.equal(adjusted.lowGainDb, 12);
  assert.equal(adjusted.lowFreqHz, 60);
  assert.equal(adjusted.midQ, 4.0);
  assert.equal(adjusted.highFreqHz, 14000);
  assert.equal(isTrackEqActive(adjusted), true);
  assert.equal(isTrackEqActive({ ...adjusted, enabled: false }), false);
});

test('applyDynamicsProcessorPCM evens out quiet/loud volume levels and strictly prevents clipping', () => {
  const sr = 10000;
  // 0.6s quiet speech (0.08 amp) -> 0.6s loud shouting (0.85 amp) -> 0.4s clipping transient (1.65 amp!)
  const quiet = makeSine(sr, 0.6, 240, 0.08);
  const loud = makeSine(sr, 0.6, 240, 0.85);
  const clipped = makeSine(sr, 0.4, 240, 1.65);
  const input = concatArrays([quiet, loud, clipped]);

  const ceilingDb = -0.3;
  const ceilingLin = dbToLinear(ceilingDb);

  const res = applyDynamicsProcessorPCM([input], sr, {
    thresholdDb: -18,
    kneeDb: 8,
    ratio: 5.0,
    attackSec: 0.005,
    releaseSec: 0.1,
    makeupGainDb: 5.0,
    limiterCeilingDb: ceilingDb,
  });

  const out = res.channels[0];
  const rmsSlice = (arr: Float32Array, sSec: number, eSec: number) => {
    const s = Math.floor(sSec * sr);
    const e = Math.floor(eSec * sr);
    let sum = 0;
    for (let i = s; i < e; i++) sum += arr[i] * arr[i];
    return Math.sqrt(sum / Math.max(1, e - s));
  };

  // Input loud/quiet ratio is 0.85 / 0.08 = 10.6x; compressed ratio should be dramatically smaller
  const rawRatio = rmsSlice(input, 0.8, 1.1) / rmsSlice(input, 0.15, 0.45);
  const compRatio = rmsSlice(out, 0.8, 1.1) / rmsSlice(out, 0.15, 0.45);
  assert.ok(
    compRatio < rawRatio * 0.55,
    `Expected dynamics processor to even out levels (raw=${rawRatio.toFixed(2)}x, comp=${compRatio.toFixed(2)}x)`
  );

  // Strict brickwall limiter check: NO sample may exceed ceilingLin!
  let maxPeak = 0;
  for (let i = 0; i < out.length; i++) {
    assert.ok(Number.isFinite(out[i]));
    const a = Math.abs(out[i]);
    if (a > maxPeak) maxPeak = a;
  }
  assert.ok(
    maxPeak <= ceilingLin + 1e-4,
    `Expected peak <= ${ceilingLin.toFixed(4)} (${ceilingDb} dBFS), got ${maxPeak.toFixed(4)}`
  );
  assert.ok(res.maxReductionDb < -4, `Expected active gain reduction, got ${res.maxReductionDb.toFixed(1)} dB`);
});

test('estimateNoiseProfileFFT & applySpectralSubtractionPCM surgically remove static hiss and AC hum while preserving vocal tone', () => {
  const sr = 16000;
  const totalSec = 2.0;
  const len = Math.floor(sr * totalSec);
  const pcm = new Float32Array(len);

  // Deterministic pseudo-random static hiss + 60 Hz & 120 Hz AC hum across the whole recording
  let seed = 1337;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };

  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const acHum = 0.045 * Math.sin(2 * Math.PI * 60 * t) + 0.025 * Math.sin(2 * Math.PI * 120 * t);
    const hiss = 0.03 * nextRand();
    // Active clear vocal formant region between 0.8s and 1.5s (440 Hz + 880 Hz harmonics)
    const vocal =
      t >= 0.8 && t <= 1.5
        ? 0.42 * Math.sin(2 * Math.PI * 440 * t) + 0.2 * Math.sin(2 * Math.PI * 880 * t)
        : 0;
    pcm[i] = acHum + hiss + vocal;
  }

  // Capture noise profile from the quiet noise-only intro [0.05s .. 0.65s]
  const profile = estimateNoiseProfileFFT([pcm], sr, { startSec: 0.05, endSec: 0.65, fftSize: 1024 });
  assert.ok(profile.frameCount >= 4);
  assert.ok(
    profile.dominantHumHz !== null && Math.abs(profile.dominantHumHz - 60) <= 20,
    `Expected dominant AC hum near 60 Hz, got ${profile.dominantHumHz}`
  );

  const denoised = applySpectralSubtractionPCM([pcm], sr, profile, {
    reductionStrength: 85,
    vocalProtection: 85,
    spectralFloorDb: -26,
  });
  const out = denoised.channels[0];
  assert.equal(out.length, pcm.length);

  const rmsWindow = (arr: Float32Array, sSec: number, eSec: number) => {
    const s = Math.floor(sSec * sr);
    const e = Math.floor(eSec * sr);
    let sum = 0;
    for (let i = s; i < e; i++) sum += arr[i] * arr[i];
    return Math.sqrt(sum / Math.max(1, e - s));
  };

  const noiseBefore = rmsWindow(pcm, 0.1, 0.6);
  const noiseAfter = rmsWindow(out, 0.1, 0.6);
  const vocalBefore = rmsWindow(pcm, 0.9, 1.4);
  const vocalAfter = rmsWindow(out, 0.9, 1.4);

  const noiseDropDb = 20 * Math.log10(noiseBefore / Math.max(1e-6, noiseAfter));
  assert.ok(
    noiseDropDb > 10,
    `Expected spectral subtraction to reduce background hiss/hum by > 10 dB, got ${noiseDropDb.toFixed(1)} dB`
  );
  // Vocal clarity preserved (>80% of vocal RMS retained)
  assert.ok(
    vocalAfter > vocalBefore * 0.8,
    `Expected vocal clarity preserved (before=${vocalBefore.toFixed(3)}, after=${vocalAfter.toFixed(3)})`
  );
});

test('analyzeForMastering computes multiband, stereo enhancer, and brickwall limiter settings tailored to audio', () => {
  const sr = 22050;
  // Quiet, bass-light mono speech-like signal
  const quietVoice = makeSine(sr, 1.2, 650, 0.09);
  const plan = analyzeForMastering([quietVoice], sr, 'podcast');

  assert.equal(plan.target, 'podcast');
  assert.equal(plan.targetLufs, -16);
  assert.equal(plan.analysis.isMonoSource, true);
  assert.ok(plan.limiter.driveDb > 2, `Expected positive drive for quiet track, got ${plan.limiter.driveDb}`);
  assert.ok(plan.limiter.ceilingDb <= -0.9 && plan.limiter.ceilingDb >= -1.1);
  assert.ok(plan.multiband.low.ratio >= 1.5 && plan.multiband.mid.ratio >= 1.5);
  assert.ok(plan.stereoEnhancer.enabled && plan.stereoEnhancer.width > 1.0);
  assert.ok(plan.recommendations.length >= 3);
});

test('applyMasteringChainPCM boosts loudness, widens stereo safely, and strictly prevents clipping below ceiling', () => {
  const sr = 22050;
  const len = Math.floor(sr * 1.2);
  const raw = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    // Unmastered dynamic signal (~-20 LUFS body) with bass (110 Hz), vocal mid (520 Hz), high sheen (4800 Hz), and a hot 1.35 clipping spike
    const env = t > 0.55 && t < 0.62 ? 1.35 : 0.12;
    raw[i] =
      env *
      (0.35 * Math.sin(2 * Math.PI * 110 * t) +
        0.5 * Math.sin(2 * Math.PI * 520 * t) +
        0.2 * Math.sin(2 * Math.PI * 4800 * t));
  }

  const plan = analyzeForMastering([raw], sr, 'streaming');
  const res = applyMasteringChainPCM([raw], sr, plan);

  // Stereo enhancer promotes mono source into stereo output cleanly
  assert.equal(res.channels.length, 2);
  assert.equal(res.channels[0].length, len);
  assert.equal(res.channels[1].length, len);

  const ceilingLin = dbToLinear(plan.limiter.ceilingDb);
  let maxPeak = 0;
  for (const ch of res.channels) {
    for (let i = 0; i < ch.length; i++) {
      assert.ok(Number.isFinite(ch[i]));
      const a = Math.abs(ch[i]);
      if (a > maxPeak) maxPeak = a;
    }
  }
  assert.ok(
    maxPeak <= ceilingLin + 1e-4,
    `Expected brickwall master ceiling <= ${ceilingLin.toFixed(4)}, got ${maxPeak.toFixed(4)}`
  );
  assert.ok(
    res.afterAnalysis.integratedLufs > plan.analysis.integratedLufs,
    `Expected Pro Master to increase loudness (before=${plan.analysis.integratedLufs}, after=${res.afterAnalysis.integratedLufs})`
  );
});

test('rebalanceSoundElementsPCM preserves unity bit-accurately and isolates/adjusts voice, drums, backup, and keys', () => {
  const sr = 22050;
  const len = Math.floor(sr * 1.0);
  const left = new Float32Array(len);
  const right = new Float32Array(len);

  for (let i = 0; i < len; i++) {
    const t = i / sr;
    // Center sustained Lead Voice (650 Hz)
    const leadVoice = 0.25 * Math.sin(2 * Math.PI * 650 * t);
    // Wide panned Stereo Backup / Keys (900 Hz inverted in R)
    const wideSide = 0.18 * Math.sin(2 * Math.PI * 900 * t);
    // Sharp percussive Drum hit at t = 0.50s (15ms burst)
    const drumHit = t >= 0.5 && t <= 0.515 ? 0.75 * Math.sin(2 * Math.PI * 140 * t) : 0;
    left[i] = leadVoice + wideSide + drumHit;
    right[i] = leadVoice - wideSide + drumHit;
  }

  // 1. Unity reconstruction invariant
  const unity = rebalanceSoundElementsPCM([left, right], sr, DEFAULT_SOUND_BALANCE);
  let maxDiff = 0;
  for (let i = 0; i < len; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(unity[0][i] - left[i]), Math.abs(unity[1][i] - right[i]));
  }
  assert.ok(maxDiff < 1e-5, `Expected exact unity reconstruction, maxDiff=${maxDiff}`);

  // 2. Removing Drums reduces transient drum burst peak measurably while keeping sustained voice
  const noDrums = rebalanceSoundElementsPCM([left, right], sr, {
    ...DEFAULT_SOUND_BALANCE,
    drums: 0,
    muted: { ...DEFAULT_SOUND_BALANCE.muted, drums: true },
  });
  let rawDrumPeak = 0;
  let reducedDrumPeak = 0;
  for (let i = Math.floor(0.5 * sr); i < Math.floor(0.52 * sr); i++) {
    rawDrumPeak = Math.max(rawDrumPeak, Math.abs(left[i]));
    reducedDrumPeak = Math.max(reducedDrumPeak, Math.abs(noDrums[0][i]));
  }
  assert.ok(
    reducedDrumPeak < rawDrumPeak * 0.75,
    `Expected muting drums to attenuate drum transient (raw=${rawDrumPeak.toFixed(3)}, after=${reducedDrumPeak.toFixed(3)})`
  );

  // 3. Boosting Lead Voice increases center vocal RMS
  const boostVoice = rebalanceSoundElementsPCM([left, right], sr, {
    ...DEFAULT_SOUND_BALANCE,
    leadVoice: 1.8,
  });
  const rmsRange = (arr: Float32Array, a: number, b: number) => {
    let s = 0;
    for (let i = a; i < b; i++) s += arr[i] * arr[i];
    return Math.sqrt(s / (b - a));
  };
  const beforeVoiceRms = rmsRange(left, Math.floor(0.1 * sr), Math.floor(0.4 * sr));
  const afterVoiceRms = rmsRange(boostVoice[0], Math.floor(0.1 * sr), Math.floor(0.4 * sr));
  assert.ok(
    afterVoiceRms > beforeVoiceRms * 1.25,
    `Expected leadVoice boost to increase RMS (before=${beforeVoiceRms.toFixed(3)}, after=${afterVoiceRms.toFixed(3)})`
  );
});

test('normalizeSteadyVolumePCM evens out fluctuating quiet/loud voice while keeping silence quiet and preventing clipping', () => {
  const sr = 22050;
  const len = Math.floor(sr * 2.4);
  const sig = new Float32Array(len);

  for (let i = 0; i < len; i++) {
    const t = i / sr;
    // 0.0-0.8s: quiet mumbled speech (~-31 dBFS)
    // 0.8-1.4s: room silence pause (~-62 dBFS)
    // 1.4-2.4s: loud shout (~-5 dBFS)
    let amp = 0.0008;
    if (t < 0.8) amp = 0.04;
    else if (t >= 1.4) amp = 0.72;
    sig[i] = amp * Math.sin(2 * Math.PI * 440 * t);
  }

  const res = normalizeSteadyVolumePCM([sig], sr, {
    mode: 'steady',
    targetLufs: -16,
    ceilingDb: -1.0,
    maxBoostDb: 18,
    noiseFloorDb: -44,
  });

  // Dramatic reduction in volume fluctuation spread
  assert.ok(
    res.stats.beforeRangeDb > 12,
    `Expected large initial fluctuation range, got ${res.stats.beforeRangeDb}`
  );
  assert.ok(
    res.stats.afterRangeDb < res.stats.beforeRangeDb * 0.55,
    `Expected steady voice normalizer to cut volume swing in half (before=${res.stats.beforeRangeDb} dB, after=${res.stats.afterRangeDb} dB)`
  );

  // Silence gap stays quiet (noise-floor guard does not pump room hum)
  let silencePeak = 0;
  for (let i = Math.floor(0.95 * sr); i < Math.floor(1.25 * sr); i++) {
    silencePeak = Math.max(silencePeak, Math.abs(res.channels[0][i]));
  }
  assert.ok(silencePeak < 0.01, `Expected silence pause to stay quiet, got peak=${silencePeak.toFixed(4)}`);

  // Strict ceiling protection
  const ceilingLin = dbToLinear(-1.0);
  let maxPeak = 0;
  for (let i = 0; i < res.channels[0].length; i++) {
    maxPeak = Math.max(maxPeak, Math.abs(res.channels[0][i]));
  }
  assert.ok(maxPeak <= ceilingLin + 1e-4, `Expected peak <= ${ceilingLin.toFixed(4)}, got ${maxPeak.toFixed(4)}`);
});

test('transformAudioRegionPCM shifts pitch & speed on any selected part while keeping outside audio untouched', () => {
  const sr = 22050;
  const raw = makeSine(sr, 1.2, 330, 0.35);

  // 1. Pitch shift +4 semitones ONLY on [0.3s .. 0.8s] — preserves exact total duration
  const pitched = transformAudioRegionPCM([raw], sr, {
    startSec: 0.3,
    endSec: 0.8,
    pitchSemitones: 4,
    speedRate: 1.0,
    preservePitch: true,
    gainDb: 0,
  });
  assert.equal(pitched[0].length, raw.length);
  // Prefix before 0.28s stays untouched
  for (let i = 0; i < Math.floor(0.25 * sr); i += 100) {
    assert.ok(Math.abs(pitched[0][i] - raw[i]) < 1e-6);
  }
  // Middle region pitch actually shifted up from 330 Hz toward ~415 Hz
  const beforePitch = detectPitchFFT(raw.subarray(Math.floor(0.4 * sr), Math.floor(0.6 * sr)), sr);
  const afterPitch = detectPitchFFT(pitched[0].subarray(Math.floor(0.4 * sr), Math.floor(0.6 * sr)), sr);
  assert.ok(
    afterPitch.frequencyHz > beforePitch.frequencyHz * 1.15,
    `Expected shifted pitch > 380 Hz, before=${beforePitch.frequencyHz.toFixed(1)}, after=${afterPitch.frequencyHz.toFixed(1)}`
  );

  // 2. Speed up ONLY [0.2s .. 0.8s] (0.6s slice) by 1.5x -> slice becomes 0.4s -> total becomes ~1.0s
  const sped = transformAudioRegionPCM([raw], sr, {
    startSec: 0.2,
    endSec: 0.8,
    speedRate: 1.5,
    preservePitch: true,
    gainDb: 3,
  });
  const expectedLen = Math.round(sr * 1.0);
  assert.ok(
    Math.abs(sped[0].length - expectedLen) < sr * 0.03,
    `Expected region speed-up total length ~${expectedLen}, got ${sped[0].length}`
  );
  for (let i = 0; i < sped[0].length; i += 200) {
    assert.ok(Number.isFinite(sped[0][i]));
  }
});

test('computeAutoDuckingCurve creates smooth envelope-following gain automation that ducks on speech and releases on pauses', () => {
  const sr = 22050;
  const len = Math.floor(sr * 2.5);
  const voice = new Float32Array(len);
  // 0.0-0.6s: silence | 0.6-1.4s: active speech | 1.4-2.5s: silence pause
  for (let i = Math.floor(0.6 * sr); i < Math.floor(1.4 * sr); i++) {
    voice[i] = 0.35 * Math.sin((2 * Math.PI * 520 * i) / sr);
  }

  const baseVol = 0.4;
  const duckDb = -14;
  const { gainCurve, pointsPerSec, maxDuckDb } = computeAutoDuckingCurve([voice], sr, {
    baseVolume: baseVol,
    duckAmountDb: duckDb,
    thresholdDb: -34,
    attackMs: 40,
    holdMs: 140,
    releaseMs: 260,
    lookAheadMs: 40,
    pointsPerSec: 50,
  });

  const silenceGain = gainCurve[Math.floor(0.2 * pointsPerSec)];
  const speechGain = gainCurve[Math.floor(1.0 * pointsPerSec)];
  const releasedGain = gainCurve[Math.floor(2.3 * pointsPerSec)];

  assert.ok(
    Math.abs(silenceGain - baseVol) < 0.02,
    `Expected full music volume during initial silence (${silenceGain.toFixed(3)} vs ${baseVol})`
  );
  assert.ok(
    speechGain < baseVol * 0.35,
    `Expected strong smooth ducking during speech (${speechGain.toFixed(3)} vs base ${baseVol})`
  );
  assert.ok(
    releasedGain > baseVol * 0.85,
    `Expected smooth musical release back up in pause (${releasedGain.toFixed(3)} vs base ${baseVol})`
  );
  assert.ok(maxDuckDb >= 10, `Expected maxDuckDb >= 10 dB, got ${maxDuckDb}`);
});

test('deClickAndDePlosivePCM repairs sharp impulse clicks and tames sub-140Hz plosive mic pops', () => {
  const sr = 22050;
  const len = Math.floor(sr * 0.8);
  const sig = makeSine(sr, 0.8, 440, 0.22);

  // Inject two sharp 1-sample mouth/vinyl clicks
  sig[Math.floor(0.2 * sr)] = 0.96;
  sig[Math.floor(0.4 * sr)] = -0.94;
  // Inject a heavy 60 Hz plosive air blast ("P" pop) from 0.55s to 0.62s
  for (let i = Math.floor(0.55 * sr); i < Math.floor(0.62 * sr); i++) {
    sig[i] += 0.65 * Math.sin((2 * Math.PI * 65 * i) / sr);
  }

  const res = deClickAndDePlosivePCM([sig], sr, {
    sensitivity: 75,
    removePlosives: true,
    plosiveStrength: 80,
  });

  assert.ok(res.clicksRepaired >= 2, `Expected >=2 clicks repaired, got ${res.clicksRepaired}`);
  assert.ok(
    Math.abs(res.channels[0][Math.floor(0.2 * sr)]) < 0.35,
    `Expected repaired click sample to drop cleanly, got ${res.channels[0][Math.floor(0.2 * sr)]}`
  );
  assert.ok(res.plosivesTamed >= 1, `Expected >=1 plosive burst tamed, got ${res.plosivesTamed}`);

  // Verify plosive window energy decreased while untouched vocal region stayed intact
  const rmsRange = (arr: Float32Array, a: number, b: number) => {
    let s = 0;
    for (let i = a; i < b; i++) s += arr[i] * arr[i];
    return Math.sqrt(s / Math.max(1, b - a));
  };
  const plosiveBefore = rmsRange(sig, Math.floor(0.56 * sr), Math.floor(0.62 * sr));
  const plosiveAfter = rmsRange(res.channels[0], Math.floor(0.56 * sr), Math.floor(0.62 * sr));
  assert.ok(
    plosiveAfter < plosiveBefore * 0.82,
    `Expected plosive energy reduced (before=${plosiveBefore.toFixed(3)}, after=${plosiveAfter.toFixed(3)})`
  );
});

test('deReverbPCM attenuates trailing room echo tails while preserving direct speech attacks', () => {
  const sr = 22050;
  const len = Math.floor(sr * 1.2);
  const sig = new Float32Array(len);

  // Direct vocal pulse [0.10..0.30s] + artificial decaying room tail [0.30..0.95s]
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const tone = Math.sin(2 * Math.PI * 520 * t) + 0.5 * Math.sin(2 * Math.PI * 1040 * t);
    if (t >= 0.1 && t < 0.3) {
      sig[i] = 0.45 * tone;
    } else if (t >= 0.3 && t < 0.95) {
      const decay = Math.exp(-(t - 0.3) / 0.22);
      sig[i] = 0.22 * decay * tone;
    }
  }

  const res = deReverbPCM([sig], sr, { strength: 75, decaySec: 0.25 });
  const rmsRange = (arr: Float32Array, a: number, b: number) => {
    let s = 0;
    for (let i = a; i < b; i++) s += arr[i] * arr[i];
    return Math.sqrt(s / Math.max(1, b - a));
  };
  const tailBefore = rmsRange(sig, Math.floor(0.45 * sr), Math.floor(0.85 * sr));
  const tailAfter = rmsRange(res.channels[0], Math.floor(0.45 * sr), Math.floor(0.85 * sr));
  assert.ok(
    tailAfter < tailBefore * 0.72,
    `Expected reverb tail attenuated (before=${tailBefore.toFixed(3)}, after=${tailAfter.toFixed(3)})`
  );
  // Direct vocal onset remains strong
  const directAfter = rmsRange(res.channels[0], Math.floor(0.12 * sr), Math.floor(0.24 * sr));
  assert.ok(directAfter > 0.18, `Expected direct voice attack preserved, got ${directAfter.toFixed(3)}`);
});

test('computeSpectrogramGrid & eraseSpectralBoxPCM surgically erase an unwanted tone inside a time-freq box', () => {
  const sr = 22050;
  const len = Math.floor(sr * 1.2);
  const sig = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    // Continuous low voice (350 Hz) + annoying phone beep (2600 Hz) ONLY from 0.4s to 0.8s
    const voice = 0.3 * Math.sin(2 * Math.PI * 350 * t);
    const beep = t >= 0.4 && t <= 0.8 ? 0.45 * Math.sin(2 * Math.PI * 2600 * t) : 0;
    sig[i] = voice + beep;
  }

  const grid = computeSpectrogramGrid([sig], sr, { maxCols: 64, maxHz: 6000 });
  assert.equal(grid.cols, 64);
  assert.ok(grid.rows > 16 && grid.data.length === grid.cols * grid.rows);

  const erased = eraseSpectralBoxPCM([sig], sr, {
    startSec: 0.38,
    endSec: 0.82,
    minHz: 2200,
    maxHz: 3000,
    reductionDb: -36,
  });

  // Check energy inside [0.45..0.75s] at 2600 Hz dropped dramatically while 350 Hz voice stayed intact
  const goertzelMag = (arr: Float32Array, a: number, b: number, freq: number) => {
    let re = 0;
    let im = 0;
    const n = b - a;
    for (let i = a; i < b; i++) {
      const ang = (2 * Math.PI * freq * (i - a)) / sr;
      re += arr[i] * Math.cos(ang);
      im -= arr[i] * Math.sin(ang);
    }
    return Math.hypot(re, im) / n;
  };

  const sA = Math.floor(0.48 * sr);
  const sB = Math.floor(0.72 * sr);
  const beepBefore = goertzelMag(sig, sA, sB, 2600);
  const beepAfter = goertzelMag(erased[0], sA, sB, 2600);
  const voiceBefore = goertzelMag(sig, sA, sB, 350);
  const voiceAfter = goertzelMag(erased[0], sA, sB, 350);

  assert.ok(
    beepAfter < beepBefore * 0.15,
    `Expected 2600 Hz beep surgically erased (before=${beepBefore.toFixed(4)}, after=${beepAfter.toFixed(4)})`
  );
  assert.ok(
    voiceAfter > voiceBefore * 0.85,
    `Expected 350 Hz voice outside frequency box preserved (before=${voiceBefore.toFixed(4)}, after=${voiceAfter.toFixed(4)})`
  );
});

test('applyAutomationCurvePCM smoothly applies hand-drawn volume fade and stereo pan keyframes', () => {
  const sr = 22050;
  const raw = makeSine(sr, 1.0, 440, 0.4);

  const out = applyAutomationCurvePCM([raw], sr, {
    volumePoints: [
      { id: 'v1', timeSec: 0, value: -24 },
      { id: 'v2', timeSec: 0.5, value: 0 },
      { id: 'v3', timeSec: 1.0, value: -24 },
    ],
    panPoints: [
      { id: 'p1', timeSec: 0, value: -1 }, // Hard Left at start
      { id: 'p2', timeSec: 1.0, value: 1 }, // Hard Right at end
    ],
  });

  // Mono automatically promoted to Stereo when Pan automation is active
  assert.equal(out.length, 2);
  const rmsRange = (arr: Float32Array, a: number, b: number) => {
    let s = 0;
    for (let i = a; i < b; i++) s += arr[i] * arr[i];
    return Math.sqrt(s / Math.max(1, b - a));
  };
  const startMidRms = rmsRange(out[0], 0, Math.floor(0.1 * sr));
  const centerRms = rmsRange(out[0], Math.floor(0.45 * sr), Math.floor(0.55 * sr));
  assert.ok(centerRms > startMidRms * 2.5, `Expected fade-in curve to peak at 0.5s`);

  // End is panned hard right: Right channel >> Left channel
  const endLeft = rmsRange(out[0], Math.floor(0.88 * sr), Math.floor(0.98 * sr));
  const endRight = rmsRange(out[1], Math.floor(0.88 * sr), Math.floor(0.98 * sr));
  assert.ok(endRight > endLeft * 4, `Expected right channel dominant at pan=+1 (L=${endLeft.toFixed(4)}, R=${endRight.toFixed(4)})`);
});

test('workspaceConfig presets enforce Recorder-Only mode, granular visibility, and safe route/tab fallbacks', async () => {
  const {
    getPresetConfig,
    getVisibleSteps,
    resolveSafeStep,
    getVisibleEditorTabs,
    resolveSafeEditorTab,
    isRecorderOnlyConfig,
  } = await import('./workspaceConfig.ts');

  const recOnly = getPresetConfig('recorder-only');
  assert.equal(isRecorderOnlyConfig(recOnly), true, 'recorder-only preset must report isRecorderOnlyConfig=true');
  assert.deepEqual(getVisibleSteps(recOnly), ['record'], 'recorder-only shows strictly record screen');
  assert.equal(resolveSafeStep('edit', recOnly), 'record', 'hidden edit screen safely redirects to record');
  assert.equal(resolveSafeStep('library', recOnly), 'record', 'hidden library screen safely redirects to record');

  const novice = getPresetConfig('novice-office');
  assert.equal(isRecorderOnlyConfig(novice), false);
  assert.deepEqual(getVisibleSteps(novice), ['record', 'edit', 'export', 'library']);
  assert.equal(novice.enableCloudAiApi, false);
  assert.equal(novice.showNoviceHints, true);
  assert.equal(resolveSafeEditorTab('mastering', novice), 'cleanup', 'hidden pro tab falls back cleanly to cleanup');

  const aiOffice = getPresetConfig('ai-office');
  assert.equal(aiOffice.enableCloudAiApi, true);

  const pro = getPresetConfig('full-pro');
  assert.equal(pro.enableCloudAiApi, false);
  assert.deepEqual(getVisibleSteps(pro), ['record', 'edit', 'export', 'library', 'batch']);
  assert.equal(getVisibleEditorTabs(pro).length, 8, 'full-pro enables all 8 studio editor tabs');

  // Customizing: disabling every single editor tab still guarantees at least 1 safe fallback tab
  const noneCustom = {
    ...novice,
    editorShowEasyFixes: false,
    editorShowSoundPitch: false,
    editorShowAudioRepair: false,
    editorShowTracksAutomation: false,
    editorShowVoiceEffects: false,
    editorShowMastering: false,
    editorShowMusicMixer: false,
    editorShowTranscript: false,
  };
  assert.deepEqual(getVisibleEditorTabs(noneCustom), ['cleanup']);
});






