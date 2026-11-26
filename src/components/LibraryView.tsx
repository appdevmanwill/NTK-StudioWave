import {
  Check,
  Edit3,
  Folder,
  HardDrive,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  Star,
  Trash2,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AudioCategory, LibraryRecording } from '../types/audio';
import { audioBackend } from '../services/audioBackend';
import {
  emptyTrashBin,
  getStorageSummary,
  moveRecordingToTrash,
  permanentlyDeleteRecording,
  restoreRecordingFromTrash,
  saveLibraryRecording,
} from '../services/storageService';
import { formatDuration, formatFileSize } from '../utils/audioDsp';

interface LibraryViewProps {
  recordings: LibraryRecording[];
  onRefresh: () => Promise<void>;
  onOpenInEditor: (item: LibraryRecording) => Promise<void>;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
  showNoviceHints?: boolean;
}

const CATEGORIES: Array<'All' | 'Favorites' | Exclude<AudioCategory, 'Private'> | 'Trash'> = [
  'All',
  'Favorites',
  'Work',
  'Meetings',
  'Podcast',
  'Ideas',
  'Music',
  'Trash',
];

const OPEN_FOLDERS: Array<Exclude<AudioCategory, 'Private'>> = [
  'Work',
  'Meetings',
  'Podcast',
  'Ideas',
  'Music',
];

export function LibraryView({
  recordings,
  onRefresh,
  onOpenInEditor,
  onNotify,
  showNoviceHints = true,
}: LibraryViewProps) {
  const [filter, setFilter] = useState<(typeof CATEGORIES)[number]>('All');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [compressing, setCompressing] = useState(false);

  const [storage, setStorage] = useState({
    libraryBytes: 0,
    trashBytes: 0,
    quotaBytes: 500 * 1024 * 1024,
    wavCount: 0,
    wavBytes: 0,
  });

  useEffect(() => {
    getStorageSummary().then(setStorage).catch(() => {});
  }, [recordings]);

  // All files on this office machine are openly accessible — no locks or private restrictions
  const filteredRecordings = useMemo(() => {
    const q = search.trim().toLowerCase();
    return recordings.filter((r) => {
      if (filter === 'Trash') {
        if (r.deletedAt === null) return false;
      } else {
        if (r.deletedAt !== null) return false;
        if (filter === 'Favorites' && !r.favorite) return false;
        if (filter !== 'All' && filter !== 'Favorites') {
          const normalizedCat = r.category === 'Private' ? 'Work' : r.category;
          if (normalizedCat !== filter) return false;
        }
      }
      if (q && !r.title.toLowerCase().includes(q) && !r.category.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [filter, recordings, search]);

  const trashCount = recordings.filter((r) => r.deletedAt !== null).length;

  const handleToggleFavorite = async (item: LibraryRecording) => {
    await saveLibraryRecording({ ...item, favorite: !item.favorite, updatedAt: Date.now() });
    await onRefresh();
  };

  const handleChangeCategory = async (item: LibraryRecording, category: AudioCategory) => {
    await saveLibraryRecording({ ...item, category, updatedAt: Date.now() });
    await onRefresh();
    onNotify(`Moved "${item.title}" to ${category}.`, 'info');
  };

  const handleCommitRename = async (item: LibraryRecording) => {
    const trimmed = renameText.trim();
    if (trimmed) {
      await saveLibraryRecording({ ...item, title: trimmed, updatedAt: Date.now() });
      await onRefresh();
    }
    setEditingId(null);
  };

  const handleMoveToTrash = async (item: LibraryRecording) => {
    await moveRecordingToTrash(item.id);
    await onRefresh();
    onNotify(`Moved "${item.title}" to 30-Day Trash Bin.`, 'info');
  };

  const handleRestore = async (item: LibraryRecording) => {
    await restoreRecordingFromTrash(item.id);
    await onRefresh();
    onNotify(`Restored "${item.title}" to Shared Files!`, 'success');
  };

  const handleEmptyTrash = async () => {
    await emptyTrashBin();
    await onRefresh();
    onNotify('Trash Bin emptied.', 'info');
  };

  const handleCompressWavsToMp3 = async () => {
    const wavs = recordings.filter(
      (r) => r.deletedAt === null && r.format.toLowerCase() === 'wav'
    );
    if (wavs.length === 0) {
      onNotify('No uncompressed WAV files found in shared files.', 'info');
      return;
    }
    setCompressing(true);
    let savedBytes = 0;
    try {
      for (const rec of wavs) {
        const audioBuf = await audioBackend.decodeAudioData(await rec.blob.arrayBuffer());
        const encoded = await audioBackend.encodeAudio(audioBuf, {
          format: 'mp3',
          qualityMode: 'bitrate',
          bitrateKbps: 128,
          targetSizeMb: 10,
          sampleRate: audioBuf.sampleRate,
          channels: audioBuf.numberOfChannels > 1 ? 2 : 1,
          metadata: {
            title: rec.title,
            artist: rec.artist || '',
            album: rec.album || '',
            coverDataUrl: null,
          },
        });
        savedBytes += Math.max(0, rec.sizeBytes - encoded.blob.size);
        await saveLibraryRecording({
          ...rec,
          blob: encoded.blob,
          format: 'mp3',
          sizeBytes: encoded.blob.size,
          updatedAt: Date.now(),
        });
      }
      await onRefresh();
      onNotify(
        `Compressed ${wavs.length} WAV file(s) to MP3 — freed ${formatFileSize(savedBytes)}!`,
        'success'
      );
    } catch {
      onNotify('Could not compress WAV files.', 'error');
    } finally {
      setCompressing(false);
    }
  };

  const totalUsed = storage.libraryBytes + storage.trashBytes;
  const usagePct = Math.min(100, (totalUsed / Math.max(1, storage.quotaBytes)) * 100);

  return (
    <div className="mx-auto max-w-6xl space-y-5" data-testid="shared-library-view">
      {/* Shared Office Storage Dashboard */}
      <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-2 flex-1">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4.5 w-4.5 text-blue-600 dark:text-blue-400" />
            <h1 className="font-display text-lg font-bold text-slate-900 dark:text-white">
              Shared Office Files &amp; Storage
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2.5 text-xs text-slate-500 dark:text-slate-400">
            <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
              <Users className="h-3.5 w-3.5" />
              Open to every coworker — no login or private locks
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">Files: {formatFileSize(storage.libraryBytes)}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">Trash: {formatFileSize(storage.trashBytes)}</span>
          </div>
          <div className="h-2 max-w-md overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div
              className="h-full bg-blue-600 transition-all"
              style={{ width: `${Math.max(1.5, usagePct)}%` }}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={compressing || storage.wavCount === 0}
            onClick={handleCompressWavsToMp3}
            className="min-h-[44px] inline-flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-4 py-2 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
          >
            <Sparkles className="h-4 w-4 text-blue-500" />
            <span>
              {compressing
                ? 'Compressing WAVs...'
                : `Compress old WAVs to MP3 (${storage.wavCount})`}
            </span>
          </button>
        </div>
      </section>

      {showNoviceHints && (
        <p className="text-xs text-slate-600 dark:text-slate-400 px-1">
          Tip: Anyone using this computer can open, rename, or edit any saved recording below. Deleted clips stay safely in Trash for 30 days.
        </p>
      )}

      {/* Folder Tabs + Search Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setFilter(cat)}
              className={`min-h-[40px] inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                filter === cat
                  ? cat === 'Trash'
                    ? 'bg-rose-600 text-white'
                    : 'bg-blue-600 text-white'
                  : 'border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {cat === 'Trash' && <Trash2 className="h-3.5 w-3.5" />}
              <span>{cat === 'Trash' ? `Trash (${trashCount})` : cat}</span>
            </button>
          ))}
        </div>

        <div className="relative w-full md:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            aria-label="Search shared office recordings"
            placeholder="Search recordings..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full min-h-[44px] sm:min-h-[40px] rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] pl-9 pr-3 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Open Shared List */}
      <section className="space-y-3">
        {filter === 'Trash' && trashCount > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-500/30 bg-rose-500/8 px-4 py-3 text-xs">
            <span className="text-slate-700 dark:text-slate-200">
              Items in Trash are automatically removed after 30 days.
            </span>
            <button
              type="button"
              onClick={handleEmptyTrash}
              className="min-h-[38px] rounded-lg bg-rose-600 px-3 py-1.5 font-semibold text-white hover:bg-rose-700"
            >
              Empty Trash
            </button>
          </div>
        )}

        {filteredRecordings.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-10 text-center space-y-2">
            <Folder className="mx-auto h-8 w-8 text-slate-400" />
            <div className="font-display text-sm font-bold text-slate-900 dark:text-white">
              {filter === 'Trash' ? 'Trash Bin is empty' : 'No shared recordings here yet'}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {filter === 'Trash'
                ? 'Deleted recordings stay safely recoverable here for 30 days.'
                : 'Save any recording from the Recorder or Editor so any office team member can open it anytime.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-slate-800 overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822]">
            {filteredRecordings.map((item) => {
              const displayCat = item.category === 'Private' ? 'Work' : item.category;
              return (
                <div
                  key={item.id}
                  className="min-h-[64px] flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 sm:px-5 py-3.5 hover:bg-slate-50/70 dark:hover:bg-slate-900/40 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {filter !== 'Trash' && (
                      <button
                        type="button"
                        aria-label={item.favorite ? `Unstar ${item.title}` : `Star ${item.title}`}
                        onClick={() => handleToggleFavorite(item)}
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                          item.favorite
                            ? 'text-amber-500 bg-amber-50 dark:bg-amber-500/10'
                            : 'text-slate-400 hover:text-amber-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                        }`}
                      >
                        <Star className={`h-4 w-4 ${item.favorite ? 'fill-current' : ''}`} />
                      </button>
                    )}

                    <div className="min-w-0">
                      {editingId === item.id ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            autoFocus
                            value={renameText}
                            onChange={(e) => setRenameText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleCommitRename(item);
                            }}
                            className="rounded-lg border border-blue-500 bg-white dark:bg-slate-900 px-2.5 py-1 text-sm font-semibold text-slate-900 dark:text-white"
                          />
                          <button
                            type="button"
                            aria-label="Save name"
                            onClick={() => handleCommitRename(item)}
                            className="flex h-9 w-9 items-center justify-center rounded-lg text-emerald-600 hover:bg-emerald-50"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="font-semibold text-sm text-slate-900 dark:text-white truncate">
                          {item.title}
                        </div>
                      )}

                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                        <span>{formatDuration(item.duration, true)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{item.format.toUpperCase()}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatFileSize(item.sizeBytes)}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-sans">
                          {new Date(item.updatedAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {filter === 'Trash' ? (
                      <>
                        <button
                          type="button"
                          onClick={() => handleRestore(item)}
                          className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          <span>Restore</span>
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            await permanentlyDeleteRecording(item.id);
                            await onRefresh();
                          }}
                          className="min-h-[40px] inline-flex items-center gap-1 rounded-xl border border-rose-500/40 px-3 py-1.5 text-xs font-semibold text-rose-500 hover:bg-rose-500/10"
                        >
                          Delete Forever
                        </button>
                      </>
                    ) : (
                      <>
                        <select
                          aria-label={`Folder for ${item.title}`}
                          value={displayCat}
                          onChange={(e) => handleChangeCategory(item, e.target.value as AudioCategory)}
                          className="min-h-[40px] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-xs text-slate-700 dark:text-slate-300"
                        >
                          {OPEN_FOLDERS.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>

                        <button
                          type="button"
                          aria-label={`Rename ${item.title}`}
                          onClick={() => {
                            setEditingId(item.id);
                            setRenameText(item.title);
                          }}
                          className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-900 dark:hover:text-white"
                        >
                          <Edit3 className="h-4 w-4" />
                        </button>

                        <button
                          type="button"
                          onClick={() => onOpenInEditor(item)}
                          className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                        >
                          <Play className="h-3.5 w-3.5" />
                          <span>Open</span>
                        </button>

                        <button
                          type="button"
                          aria-label={`Move ${item.title} to trash`}
                          onClick={() => handleMoveToTrash(item)}
                          className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-500"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
