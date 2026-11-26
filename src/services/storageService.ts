import type { AutoSaveSession, LibraryRecording } from '../types/audio';

const DB_NAME = 'studiowave_db_v1';
const DB_VERSION = 1;
const AUTOSAVE_META_STORE = 'AutoSaveMeta';
const AUTOSAVE_CHUNKS_STORE = 'AutoSaveStore';
const LIBRARY_STORE = 'LibraryStore';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUTOSAVE_META_STORE)) {
        db.createObjectStore(AUTOSAVE_META_STORE, { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains(AUTOSAVE_CHUNKS_STORE)) {
        const chunkStore = db.createObjectStore(AUTOSAVE_CHUNKS_STORE, {
          keyPath: 'id',
          autoIncrement: true,
        });
        chunkStore.createIndex('sessionId', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains(LIBRARY_STORE)) {
        db.createObjectStore(LIBRARY_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// =========================================================================
// 1-SECOND APPEND-ONLY AUTO-SAVE & CRASH RECOVERY
// =========================================================================

export async function startAutoSaveSession(session: AutoSaveSession): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUTOSAVE_META_STORE, 'readwrite');
    tx.objectStore(AUTOSAVE_META_STORE).put(session);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function appendAutoSaveChunk(
  sessionId: string,
  chunkBlob: Blob,
  durationSec: number,
  chunkCount: number
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([AUTOSAVE_CHUNKS_STORE, AUTOSAVE_META_STORE], 'readwrite');
    tx.objectStore(AUTOSAVE_CHUNKS_STORE).add({
      sessionId,
      blob: chunkBlob,
      timestamp: Date.now(),
    });
    const metaStore = tx.objectStore(AUTOSAVE_META_STORE);
    const getReq = metaStore.get(sessionId);
    getReq.onsuccess = () => {
      const existing = getReq.result as AutoSaveSession | undefined;
      if (existing) {
        metaStore.put({
          ...existing,
          updatedAt: Date.now(),
          durationSec,
          chunkCount,
        });
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getUnfinalizedAutoSave(): Promise<AutoSaveSession | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(AUTOSAVE_META_STORE, 'readonly');
      const req = tx.objectStore(AUTOSAVE_META_STORE).getAll();
      req.onsuccess = () => {
        const list = (req.result as AutoSaveSession[]).filter((s) => s.chunkCount > 0);
        if (list.length === 0) {
          resolve(null);
          return;
        }
        list.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(list[0]);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function recoverAutoSaveBlob(sessionId: string): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([AUTOSAVE_CHUNKS_STORE, AUTOSAVE_META_STORE], 'readonly');
    const metaReq = tx.objectStore(AUTOSAVE_META_STORE).get(sessionId);
    const index = tx.objectStore(AUTOSAVE_CHUNKS_STORE).index('sessionId');
    const chunksReq = index.getAll(sessionId);

    tx.oncomplete = () => {
      const meta = metaReq.result as AutoSaveSession | undefined;
      const rows = (chunksReq.result as Array<{ blob: Blob }>) ?? [];
      if (rows.length === 0) {
        resolve(null);
        return;
      }
      const mimeType = meta?.mimeType || rows[0].blob.type || 'audio/webm';
      resolve(new Blob(rows.map((r) => r.blob), { type: mimeType }));
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAutoSaveSession(sessionId?: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([AUTOSAVE_CHUNKS_STORE, AUTOSAVE_META_STORE], 'readwrite');
    const metaStore = tx.objectStore(AUTOSAVE_META_STORE);
    const chunkStore = tx.objectStore(AUTOSAVE_CHUNKS_STORE);

    if (!sessionId) {
      metaStore.clear();
      chunkStore.clear();
    } else {
      metaStore.delete(sessionId);
      const index = chunkStore.index('sessionId');
      const req = index.openCursor(sessionId);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// =========================================================================
// LIBRARY & 30-DAY TRASH BIN
// =========================================================================

export async function listLibraryRecordings(): Promise<LibraryRecording[]> {
  try {
    const db = await openDB();
    const all: LibraryRecording[] = await new Promise((resolve, reject) => {
      const tx = db.transaction(LIBRARY_STORE, 'readonly');
      const req = tx.objectStore(LIBRARY_STORE).getAll();
      req.onsuccess = () => resolve((req.result as LibraryRecording[]) ?? []);
      req.onerror = () => reject(req.error);
    });

    // Auto-purge trash items older than 30 days
    const now = Date.now();
    const expired = all.filter((r) => r.deletedAt !== null && now - r.deletedAt > THIRTY_DAYS_MS);
    if (expired.length > 0) {
      await Promise.all(expired.map((r) => permanentlyDeleteRecording(r.id)));
    }

    return all
      .filter((r) => r.deletedAt === null || now - r.deletedAt <= THIRTY_DAYS_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function saveLibraryRecording(recording: LibraryRecording): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LIBRARY_STORE, 'readwrite');
    tx.objectStore(LIBRARY_STORE).put(recording);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function moveRecordingToTrash(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LIBRARY_STORE, 'readwrite');
    const store = tx.objectStore(LIBRARY_STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      const item = req.result as LibraryRecording | undefined;
      if (item) {
        store.put({ ...item, deletedAt: Date.now(), updatedAt: Date.now() });
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function restoreRecordingFromTrash(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LIBRARY_STORE, 'readwrite');
    const store = tx.objectStore(LIBRARY_STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      const item = req.result as LibraryRecording | undefined;
      if (item) {
        store.put({ ...item, deletedAt: null, updatedAt: Date.now() });
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function permanentlyDeleteRecording(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LIBRARY_STORE, 'readwrite');
    tx.objectStore(LIBRARY_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function emptyTrashBin(): Promise<void> {
  const all = await listLibraryRecordings();
  const trashed = all.filter((r) => r.deletedAt !== null);
  await Promise.all(trashed.map((r) => permanentlyDeleteRecording(r.id)));
}

export async function getStorageSummary(): Promise<{
  libraryBytes: number;
  trashBytes: number;
  quotaBytes: number;
  wavCount: number;
  wavBytes: number;
}> {
  const all = await listLibraryRecordings();
  let libraryBytes = 0;
  let trashBytes = 0;
  let wavCount = 0;
  let wavBytes = 0;

  for (const r of all) {
    const sz = r.sizeBytes || r.blob?.size || 0;
    if (r.deletedAt === null) {
      libraryBytes += sz;
      if (r.format.toLowerCase() === 'wav') {
        wavCount++;
        wavBytes += sz;
      }
    } else {
      trashBytes += sz;
    }
  }

  let quotaBytes = 500 * 1024 * 1024; // sensible 500 MB default display
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est.quota && est.quota > 0) quotaBytes = est.quota;
    }
  } catch {
    // ignore
  }

  return { libraryBytes, trashBytes, quotaBytes, wavCount, wavBytes };
}
