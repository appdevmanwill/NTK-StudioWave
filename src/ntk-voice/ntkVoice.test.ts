import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NtkVoiceRouter, ProviderCallError } from '../../server/ntkVoiceRouter';
import {
  NtkVoiceStore,
  maskSecret,
  validateExternalHttpsUrl,
} from '../../server/ntkVoiceStore';
import type { NtkAudioChunkPayload, NtkStoredKey } from '../../server/ntkVoiceTypes';
import { applyLocalConfigPatch } from './services/ntkLocalConfig';
import { pickSupportedMimeType } from './services/ntkAudioEngine';
import { isNativeApp, sanitizeFilename } from '../utils/platformFileSave';
import {
  DEFAULT_NTK_LIVE_CONSOLE,
  NTK_7BAND_EQ_SPECS,
  NTK_STUDIO_PRESETS,
  applyPresetToConsole,
  formatRecordingMarkdown,
  formatTranscriptSRT,
  formatTranscriptTXT,
  formatTranscriptVTT,
  mixTwoTracksPCM,
  planAudioChunksForApi,
  searchRecordingsByKeyword,
  splitFourStemsRuleBasedPCM,
  trimAndCutSilencesPCM,
} from './utils/ntkAudioUtils';
import { buildZipBytes } from './utils/zipBuilder';

function makeTestKey(overrides: Partial<NtkStoredKey>): NtkStoredKey {
  return {
    id: overrides.id || `k-${Math.random().toString(36).slice(2, 6)}`,
    pool: overrides.pool || 'stt',
    provider: overrides.provider || 'groq',
    label: overrides.label || 'Groq Key',
    apiKey: overrides.apiKey || 'gsk_test_secret_123456789',
    model: overrides.model || 'whisper-large-v3-turbo',
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 1,
    status: 'ready',
    cooldownUntil: 0,
    dailyExhaustedUntil: 0,
    consecutiveErrors: 0,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    lastError: null,
    lastLatencyMs: null,
    lastUsedAt: null,
    ...overrides,
  };
}

test('Round-Robin load balances evenly across multiple keys of the same provider', async () => {
  const store = new NtkVoiceStore(false);
  const data = store.getData();
  data.sttStrategy = 'round_robin';
  data.keys = [
    makeTestKey({ id: 'g1', label: 'Groq #1', priority: 1 }),
    makeTestKey({ id: 'g2', label: 'Groq #2', priority: 2 }),
    makeTestKey({ id: 'g3', label: 'Groq #3', priority: 3 }),
  ];

  const router = new NtkVoiceRouter(store);
  const usedOrder: string[] = [];
  for (let i = 0; i < 6; i++) {
    const { key } = await router.executeWithFailover('stt', async (k) => {
      usedOrder.push(k.id);
      return 'ok';
    });
    assert.ok(key.id);
  }
  assert.deepEqual(usedOrder, ['g1', 'g2', 'g3', 'g1', 'g2', 'g3']);
});

test('Priority Failover rotates silently on 429/401/5xx and tracks Retry-After cooldown', async () => {
  const store = new NtkVoiceStore(false);
  const data = store.getData();
  data.sttStrategy = 'priority_failover';
  data.keys = [
    makeTestKey({ id: 'groq-1', provider: 'groq', label: 'Groq #1', priority: 1 }),
    makeTestKey({ id: 'dg-1', provider: 'deepgram', label: 'Deepgram #1', priority: 2 }),
    makeTestKey({ id: 'gem-1', provider: 'gemini', label: 'Gemini #1', priority: 3 }),
  ];

  const router = new NtkVoiceRouter(store);
  const res = await router.executeWithFailover('stt', async (k) => {
    if (k.id === 'groq-1') {
      throw new ProviderCallError('Rate limit exceeded', 429, { retryAfterSec: 45 });
    }
    if (k.id === 'dg-1') {
      throw new ProviderCallError('Invalid auth token', 401);
    }
    return `transcribed-by-${k.id}`;
  });

  assert.equal(res.result, 'transcribed-by-gem-1');
  assert.equal(res.failovers, 2);
  assert.equal(data.keys[0].status, 'cooldown');
  assert.ok(data.keys[0].cooldownUntil > Date.now() + 30000);
  assert.equal(data.keys[1].status, 'error');
  assert.equal(data.keys[2].status, 'ready');
});

test('Seamless mid-recording chunk handover stitches timestamps across providers on rate limit', async () => {
  const store = new NtkVoiceStore(false);
  const data = store.getData();
  data.sttStrategy = 'priority_failover';
  data.keys = [
    makeTestKey({ id: 'groq-a', provider: 'groq', label: 'Groq A', priority: 1 }),
    makeTestKey({ id: 'cf-b', provider: 'cloudflare', label: 'Cloudflare B', priority: 2 }),
  ];

  const router = new NtkVoiceRouter(store);
  const chunks: NtkAudioChunkPayload[] = [
    { chunkIndex: 0, offsetSeconds: 0, durationSeconds: 180, audioBase64: 'AAAA', mimeType: 'audio/wav' },
    { chunkIndex: 1, offsetSeconds: 180, durationSeconds: 120, audioBase64: 'BBBB', mimeType: 'audio/wav' },
  ];

  const out = await router.transcribeChunks(chunks, 'en', async (key, chunk) => {
    if (chunk.chunkIndex === 1 && key.id === 'groq-a') {
      throw new ProviderCallError('429 Too Many Requests', 429, { retryAfterSec: 60 });
    }
    return {
      text: chunk.chunkIndex === 0 ? 'First half completed.' : 'Second half handed over cleanly.',
      segments: [
        {
          id: `s-${chunk.chunkIndex}`,
          start: chunk.offsetSeconds,
          end: chunk.offsetSeconds + 10,
          text: chunk.chunkIndex === 0 ? 'First half completed.' : 'Second half handed over cleanly.',
        },
      ],
      provider: key.provider,
      keyId: key.id,
      keyLabel: key.label,
    };
  });

  assert.equal(out.failovers, 1);
  assert.deepEqual(out.providersUsed, ['groq', 'cloudflare']);
  assert.equal(out.segments.length, 2);
  assert.equal(out.segments[0].start, 0);
  assert.equal(out.segments[1].start, 180);
  assert.match(out.text, /First half completed.*Second half handed over cleanly/);
});

test('SSRF validator blocks private/loopback/metadata URLs and raw keys are never exposed in public snapshot', () => {
  assert.equal(validateExternalHttpsUrl('https://api.example.com/v1').valid, true);
  assert.equal(validateExternalHttpsUrl('http://api.example.com/v1').valid, false);
  assert.equal(validateExternalHttpsUrl('https://127.0.0.1/admin').valid, false);
  assert.equal(validateExternalHttpsUrl('https://localhost:8080/v1').valid, false);
  assert.equal(validateExternalHttpsUrl('https://169.254.169.254/latest/meta-data').valid, false);
  assert.equal(validateExternalHttpsUrl('https://192.168.1.10/api').valid, false);
  assert.equal(validateExternalHttpsUrl('https://10.0.0.5/api').valid, false);

  const store = new NtkVoiceStore(false);
  store.getData().keys = [
    makeTestKey({ id: 'secret-check', apiKey: 'gsk_super_secret_token_987654' }),
  ];
  const snapJson = JSON.stringify(store.getPublicSnapshot());
  assert.equal(snapJson.includes('gsk_super_secret_token_987654'), false);
  assert.equal(maskSecret('gsk_super_secret_token_987654'), 'gsk_••••7654');
});

test('7-band EQ specs, studio presets, and >15MB automatic audio chunker work deterministically', () => {
  assert.equal(NTK_7BAND_EQ_SPECS.length, 7);
  assert.deepEqual(
    NTK_7BAND_EQ_SPECS.map((b) => b.freqHz),
    [60, 150, 400, 1000, 2500, 6000, 12000]
  );

  const radio = applyPresetToConsole(DEFAULT_NTK_LIVE_CONSOLE, 'broadcast-radio');
  assert.equal(radio.presetId, 'broadcast-radio');
  assert.deepEqual(radio.eqBandsDb, NTK_STUDIO_PRESETS['broadcast-radio'].eqBandsDb);

  // 20 minutes at 16 kHz mono = 19,200,000 samples (~38.4 MB raw WAV) -> must slice into multiple <12 MB chunks
  const plan = planAudioChunksForApi(16000 * 60 * 20, 16000, 12 * 1024 * 1024);
  assert.ok(plan.length >= 4);
  assert.equal(plan[0].offsetSeconds, 0);
  for (const c of plan) {
    assert.ok(c.estimatedBytes <= 12 * 1024 * 1024);
  }
});

test('Non-destructive waveform trim, silence cutter, two-track mix, transcript formats & ZIP builder succeed', () => {
  const sr = 8000;
  // 1s tone + 1.5s silence + 1s tone = 3.5s
  const ch = new Float32Array(sr * 3.5);
  for (let i = 0; i < sr; i++) ch[i] = 0.4 * Math.sin((2 * Math.PI * 300 * i) / sr);
  for (let i = sr * 2.5; i < sr * 3.5; i++) ch[i] = 0.4 * Math.sin((2 * Math.PI * 300 * i) / sr);

  const trimmed = trimAndCutSilencesPCM([ch], sr, {
    trimStartSec: 0,
    trimEndSec: 3.5,
    cutSilences: true,
    silenceThresholdDb: -35,
    minSilenceSec: 0.6,
    keepPaddingSec: 0.1,
  });
  assert.ok(trimmed.removedSilenceSec > 0.8);
  assert.ok(trimmed.durationSec < 2.8);

  const mixed = mixTwoTracksPCM([new Float32Array(sr).fill(0.3)], [new Float32Array(sr / 2).fill(0.4)], sr, 0.25, 0.8);
  assert.equal(mixed[0].length, sr);
  assert.ok(mixed[0][Math.floor(sr * 0.3)] > 0.55);

  const segs = [
    { id: '1', start: 0.5, end: 2.5, text: 'Quarterly office update ready.', speaker: 'Speaker 1' },
    { id: '2', start: 3.0, end: 5.5, text: 'Action item: ship NTK Reorder Suite.', speaker: 'Speaker 2' },
  ];
  assert.match(formatTranscriptTXT(segs), /\[00:00\] Speaker 1: Quarterly/);
  assert.match(formatTranscriptSRT(segs), /00:00:00,500 --> 00:00:02,500/);
  assert.match(formatTranscriptVTT(segs), /^WEBVTT/);

  const dummyRec = {
    id: 'r1',
    title: 'Weekly Sync',
    speakerName: 'Alex',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    durationSec: 12,
    mimeType: 'audio/wav',
    audioBlob: new Blob(['test']),
    flags: [{ id: 'f1', timeSec: 3.0, note: 'Key deadline', createdAt: Date.now() }],
    transcript: segs,
    transcriptText: 'Quarterly office update ready. Action item: ship NTK Reorder Suite.',
    aiNotes: [{ id: 'n1', buttonId: 'b1', label: 'Summary', text: '- Ship suite', provider: 'groq', model: 'llama', createdAt: Date.now() }],
    deletedAt: null,
  };
  assert.match(formatRecordingMarkdown(dummyRec), /## Moment Flags/);
  assert.equal(searchRecordingsByKeyword([dummyRec], 'deadline').length, 1);
  assert.equal(searchRecordingsByKeyword([dummyRec], 'nonexistent').length, 0);

  const zip = buildZipBytes([
    { name: 'notes.txt', data: new TextEncoder().encode('Hello NTK Reorder Suite') },
  ]);
  // Standard PKZIP local file header signature 0x50 0x4B 0x03 0x04
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  assert.equal(zip[2], 0x03);
  assert.equal(zip[3], 0x04);
});

test('AI features and API keys are strictly optional and OFF by default with zero-key support', () => {
  const store = new NtkVoiceStore(false);
  store.getData().keys = []; // Explicitly zero API keys configured
  const snap = store.getPublicSnapshot();
  assert.equal(snap.visibility.aiFeaturesEnabled, false);
  assert.equal(snap.visibility.aiStemMixer, true);
  assert.equal(snap.summary.sttTotal, 0);
  assert.equal(snap.summary.llmTotal, 0);
  assert.equal(snap.summary.sttReady, 0);
  assert.equal(snap.summary.llmReady, 0);
  assert.equal(snap.visibility.liveEqConsole, true);
  assert.equal(snap.visibility.waveformTrimmer, true);
  assert.equal(snap.visibility.momentFlags, true);
  assert.equal(snap.visibility.multiFormatExport, true);
});

test('splitFourStemsRuleBasedPCM separates synthetic audio into 4 finite stems completely offline', () => {
  const sr = 22050;
  const len = Math.floor(sr * 1.0);
  const left = new Float32Array(len);
  const right = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const vocal = 0.3 * Math.sin(2 * Math.PI * 620 * t);
    const bass = 0.25 * Math.sin(2 * Math.PI * 80 * t);
    const keys = 0.15 * Math.sin(2 * Math.PI * 1200 * t);
    const drum = t >= 0.45 && t <= 0.47 ? 0.65 * Math.sin(2 * Math.PI * 140 * t) : 0;
    left[i] = vocal + bass + keys + drum;
    right[i] = vocal + bass - keys + drum;
  }

  const stems = splitFourStemsRuleBasedPCM([left, right], sr);
  for (const key of ['vocals', 'drums', 'bass', 'other'] as const) {
    assert.equal(stems[key].length, 2, `${key} stem preserves stereo channels`);
    assert.equal(stems[key][0].length, len, `${key} stem preserves sample count`);
    let maxAbs = 0;
    for (let i = 0; i < len; i++) {
      assert.ok(Number.isFinite(stems[key][0][i]));
      maxAbs = Math.max(maxAbs, Math.abs(stems[key][0][i]));
    }
    assert.ok(maxAbs > 0.01, `${key} stem should contain extracted audio energy`);
  }
});

test('NtkVoiceStore persists settings across restarts with zero env API keys or secrets', () => {
  const prevGemini = process.env.GEMINI_API_KEY;
  const prevStoreSecret = process.env.NTK_VOICE_STORE_SECRET;
  delete process.env.GEMINI_API_KEY;
  delete process.env.NTK_VOICE_STORE_SECRET;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntk-voice-store-test-'));
  try {
    const store1 = new NtkVoiceStore(true, tmpDir);
    store1.getData().workstation.suiteName = 'Office Room B Suite';
    store1.getData().visibility.waveformTrimmer = false;
    store1.save();

    const store2 = new NtkVoiceStore(true, tmpDir);
    const snap2 = store2.getPublicSnapshot();
    assert.equal(snap2.workstation.suiteName, 'Office Room B Suite');
    assert.equal(snap2.visibility.waveformTrimmer, false);
    assert.equal(snap2.visibility.aiFeaturesEnabled, false);
    assert.equal(snap2.summary.sttTotal, 0);
  } finally {
    if (prevGemini !== undefined) process.env.GEMINI_API_KEY = prevGemini;
    if (prevStoreSecret !== undefined) process.env.NTK_VOICE_STORE_SECRET = prevStoreSecret;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('applyLocalConfigPatch updates offline non-secret suite settings without mutating inputs', () => {
  const store = new NtkVoiceStore(false);
  const baseSnap = store.getPublicSnapshot();
  const patched = applyLocalConfigPatch(baseSnap, {
    visibility: { momentFlags: false, liveEqConsole: false },
    workstation: { suiteName: 'Offline Field Recorder', maxRecordingMinutes: 90 },
  });
  assert.equal(baseSnap.workstation.suiteName, 'NTK Reorder Suite');
  assert.equal(baseSnap.visibility.momentFlags, true);
  assert.equal(patched.workstation.suiteName, 'Offline Field Recorder');
  assert.equal(patched.workstation.maxRecordingMinutes, 90);
  assert.equal(patched.visibility.momentFlags, false);
  assert.equal(patched.visibility.liveEqConsole, false);
  assert.equal(patched.visibility.aiFeaturesEnabled, false);
});

test('sanitizeFilename, isNativeApp, pickSupportedMimeType, and NTK_DATA_DIR work safely offline', () => {
  assert.equal(sanitizeFilename('My <Test>: Clip/1?.wav'), 'My__Test___Clip_1_.wav');
  assert.equal(sanitizeFilename('   '), 'NTK-StudioWave-Audio.wav');
  assert.equal(isNativeApp(), false);
  assert.equal(pickSupportedMimeType(), 'audio/webm');

  const prevDataDir = process.env.NTK_DATA_DIR;
  const prevGemini = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntk-data-dir-env-'));
  process.env.NTK_DATA_DIR = customDir;
  try {
    const store1 = new NtkVoiceStore(true);
    store1.getData().workstation.suiteName = 'Env Data Dir Suite';
    store1.save();

    const store2 = new NtkVoiceStore(true);
    assert.equal(store2.getPublicSnapshot().workstation.suiteName, 'Env Data Dir Suite');
    assert.ok(fs.existsSync(path.join(customDir, 'ntk-voice-store.enc.json')));
  } finally {
    if (prevDataDir !== undefined) process.env.NTK_DATA_DIR = prevDataDir;
    else delete process.env.NTK_DATA_DIR;
    if (prevGemini !== undefined) process.env.GEMINI_API_KEY = prevGemini;
    fs.rmSync(customDir, { recursive: true, force: true });
  }
});

