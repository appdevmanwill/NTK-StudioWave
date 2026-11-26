import type { NtkCrashSession, NtkMomentFlag, NtkRecordingItem } from '../types';
import { createZipBlob, type ZipInputFile } from '../utils/zipBuilder';
import { formatRecordingMarkdown, formatTranscriptSRT, formatTranscriptTXT } from '../utils/ntkAudioUtils';

const DB_NAME = 'ntk_reorder_suite_db';
const DB_VERSION = 1;
const STORE_RECORDINGS = 'recordings';
const STORE_CRASH_META = 'crash_sessions';
const STORE_CRASH_CHUNKS = 'crash_chunks';

interface CrashChunkRow {
  key: string;
  sessionId: string;
  index: number;
  blob: Blob;
  savedAt: number;
}

function openNtkDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
        db.createObjectStore(STORE_RECORDINGS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CRASH_META)) {
        db.createObjectStore(STORE_CRASH_META, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CRASH_CHUNKS)) {
        const chunkStore = db.createObjectStore(STORE_CRASH_CHUNKS, { keyPath: 'key' });
        chunkStore.createIndex('bySession', 'sessionId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listNtkRecordings(): Promise<NtkRecordingItem[]> {
  const db = await openNtkDb();
  const tx = db.transaction(STORE_RECORDINGS, 'readonly');
  const rows = (await reqPromise(tx.objectStore(STORE_RECORDINGS).getAll())) as NtkRecordingItem[];
  db.close();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveNtkRecording(item: NtkRecordingItem): Promise<void> {
  const db = await openNtkDb();
  const tx = db.transaction(STORE_RECORDINGS, 'readwrite');
  await reqPromise(tx.objectStore(STORE_RECORDINGS).put(item));
  db.close();
}

export async function deleteNtkRecordingPermanently(id: string): Promise<void> {
  const db = await openNtkDb();
  const tx = db.transaction(STORE_RECORDINGS, 'readwrite');
  await reqPromise(tx.objectStore(STORE_RECORDINGS).delete(id));
  db.close();
}

/**
 * Applies 7-day trash purge AND optional shared-PC retention cleanup (24h / 7d / manual).
 */
export async function runNtkRetentionCleanup(policy: '24h' | '7d' | 'manual'): Promise<number> {
  const all = await listNtkRecordings();
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 3600 * 1000;
  const policyMs = policy === '24h' ? 24 * 3600 * 1000 : policy === '7d' ? sevenDaysMs : 0;

  let removed = 0;
  for (const item of all) {
    if (item.deletedAt !== null && now - item.deletedAt >= sevenDaysMs) {
      await deleteNtkRecordingPermanently(item.id);
      removed++;
      continue;
    }
    if (policyMs > 0 && item.deletedAt === null && now - item.createdAt >= policyMs) {
      // Move expired active recordings into soft-delete trash rather than silent permanent wipe
      await saveNtkRecording({ ...item, deletedAt: now, updatedAt: now });
      removed++;
    }
  }
  return removed;
}

/**
 * 3-Second Crash-Proof Chunk Streaming
 */
export async function appendCrashChunk(
  session: NtkCrashSession,
  chunkBlob: Blob,
  chunkIndex: number
): Promise<void> {
  const db = await openNtkDb();
  const tx = db.transaction([STORE_CRASH_META, STORE_CRASH_CHUNKS], 'readwrite');
  tx.objectStore(STORE_CRASH_META).put({
    ...session,
    chunkCount: chunkIndex + 1,
    updatedAt: Date.now(),
  });
  const row: CrashChunkRow = {
    key: `${session.id}_${String(chunkIndex).padStart(6, '0')}`,
    sessionId: session.id,
    index: chunkIndex,
    blob: chunkBlob,
    savedAt: Date.now(),
  };
  tx.objectStore(STORE_CRASH_CHUNKS).put(row);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function updateCrashSessionFlags(
  sessionId: string,
  flags: NtkMomentFlag[],
  durationSec: number
): Promise<void> {
  const db = await openNtkDb();
  const tx = db.transaction(STORE_CRASH_META, 'readwrite');
  const existing = (await reqPromise(tx.objectStore(STORE_CRASH_META).get(sessionId))) as
    | NtkCrashSession
    | undefined;
  if (existing) {
    tx.objectStore(STORE_CRASH_META).put({
      ...existing,
      flags,
      durationSec,
      updatedAt: Date.now(),
    });
  }
  db.close();
}

export async function getLatestCrashSession(): Promise<NtkCrashSession | null> {
  const db = await openNtkDb();
  const tx = db.transaction(STORE_CRASH_META, 'readonly');
  const sessions = (await reqPromise(tx.objectStore(STORE_CRASH_META).getAll())) as NtkCrashSession[];
  db.close();
  const valid = sessions.filter((s) => s.chunkCount > 0).sort((a, b) => b.updatedAt - a.updatedAt);
  return valid[0] ?? null;
}

export async function recoverCrashSessionBlob(sessionId: string): Promise<{
  session: NtkCrashSession;
  blob: Blob;
} | null> {
  const db = await openNtkDb();
  const tx = db.transaction([STORE_CRASH_META, STORE_CRASH_CHUNKS], 'readonly');
  const session = (await reqPromise(tx.objectStore(STORE_CRASH_META).get(sessionId))) as
    | NtkCrashSession
    | undefined;
  if (!session) {
    db.close();
    return null;
  }
  const index = tx.objectStore(STORE_CRASH_CHUNKS).index('bySession');
  const rows = (await reqPromise(index.getAll(IDBKeyRange.only(sessionId)))) as CrashChunkRow[];
  db.close();
  rows.sort((a, b) => a.index - b.index);
  if (rows.length === 0) return null;
  const blob = new Blob(
    rows.map((r) => r.blob),
    { type: session.mimeType || 'audio/webm' }
  );
  return { session, blob };
}

export async function clearCrashSession(sessionId?: string): Promise<void> {
  const db = await openNtkDb();
  const tx = db.transaction([STORE_CRASH_META, STORE_CRASH_CHUNKS], 'readwrite');
  if (!sessionId) {
    tx.objectStore(STORE_CRASH_META).clear();
    tx.objectStore(STORE_CRASH_CHUNKS).clear();
  } else {
    tx.objectStore(STORE_CRASH_META).delete(sessionId);
    const idx = tx.objectStore(STORE_CRASH_CHUNKS).index('bySession');
    const keys = await reqPromise(idx.getAllKeys(IDBKeyRange.only(sessionId)));
    for (const k of keys) {
      tx.objectStore(STORE_CRASH_CHUNKS).delete(k);
    }
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function resetAllNtkStorage(): Promise<void> {
  const db = await openNtkDb();
  const tx = db.transaction([STORE_RECORDINGS, STORE_CRASH_META, STORE_CRASH_CHUNKS], 'readwrite');
  tx.objectStore(STORE_RECORDINGS).clear();
  tx.objectStore(STORE_CRASH_META).clear();
  tx.objectStore(STORE_CRASH_CHUNKS).clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/**
 * Bundles every active recording + its transcript (TXT, SRT) + formatted Markdown notes + index JSON into a standard `.zip`.
 */
export async function exportAllNtkRecordingsZip(): Promise<{ blob: Blob; count: number }> {
  const all = (await listNtkRecordings()).filter((r) => r.deletedAt === null);
  const encoder = new TextEncoder();
  const files: ZipInputFile[] = [];

  const manifest = all.map((r) => ({
    id: r.id,
    title: r.title,
    speakerName: r.speakerName,
    createdAt: new Date(r.createdAt).toISOString(),
    durationSec: r.durationSec,
    flagsCount: r.flags.length,
    hasTranscript: Boolean(r.transcriptText || r.transcript.length),
    aiNotesCount: r.aiNotes.length,
  }));
  files.push({
    name: 'ntk-reorder-suite-index.json',
    data: encoder.encode(JSON.stringify({ exportedAt: new Date().toISOString(), recordings: manifest }, null, 2)),
  });

  for (let i = 0; i < all.length; i++) {
    const rec = all[i];
    const safeTitle = (rec.title || `recording_${i + 1}`)
      .replace(/[^a-z0-9-_]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 42);
    const folder = `${String(i + 1).padStart(2, '0')}_${safeTitle || 'recording'}`;
    const ext = /wav/i.test(rec.mimeType)
      ? 'wav'
      : /mp3|mpeg/i.test(rec.mimeType)
      ? 'mp3'
      : /mp4|m4a/i.test(rec.mimeType)
      ? 'm4a'
      : 'webm';
    const audioBytes = new Uint8Array(await rec.audioBlob.arrayBuffer());
    files.push({
      name: `${folder}/${safeTitle || 'audio'}.${ext}`,
      data: audioBytes,
      modifiedAt: new Date(rec.createdAt),
    });

    files.push({
      name: `${folder}/notes.md`,
      data: encoder.encode(formatRecordingMarkdown(rec)),
      modifiedAt: new Date(rec.updatedAt),
    });

    if (rec.transcript.length > 0) {
      files.push({
        name: `${folder}/transcript.txt`,
        data: encoder.encode(formatTranscriptTXT(rec.transcript)),
      });
      files.push({
        name: `${folder}/transcript.srt`,
        data: encoder.encode(formatTranscriptSRT(rec.transcript)),
      });
    }
  }

  return { blob: createZipBlob(files), count: all.length };
}
