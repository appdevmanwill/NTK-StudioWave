import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppStep,
  AutoSaveSession,
  BookmarkMarker,
  EffectSettings,
  ImportedVideoRef,
  LibraryRecording,
  MixerState,
  OopsMarker,
  OverlayTrack,
  ProjectSnapshot,
  ThemeMode,
  ThemePreference,
  TranscriptSegment,
  UserMode,
} from './types/audio';
import type { MainTrackControlState } from './components/TrackManagerPanel';
import {
  DEFAULT_EFFECTS,
  audioBackend,
  extractChannels,
} from './services/audioBackend';
import {
  clearAutoSaveSession,
  getUnfinalizedAutoSave,
  listLibraryRecordings,
  recoverAutoSaveBlob,
  saveLibraryRecording,
} from './services/storageService';
import { DEFAULT_TRACK_EQ, encodeWavPCM } from './utils/audioDsp';
import {
  exitAndroidApp,
  isAndroidNative,
  saveBlobToDevice,
  syncNativeSystemTheme,
} from './utils/platformFileSave';
import { buildStudioProjectBlob } from './utils/projectFile';
import { createTryItSampleRecording } from './utils/sampleSynthesizer';
import {
  getPresetConfig,
  isRecorderOnlyConfig,
  loadWorkspaceConfig,
  resolveSafeStep,
  saveWorkspaceConfig,
  type WorkspaceConfig,
} from './utils/workspaceConfig';
import { BatchStudioView } from './components/BatchStudioView';
import { CrashRecoveryModal } from './components/CrashRecoveryModal';
import { EditorView } from './components/EditorView';
import { ExportView } from './components/ExportView';
import { Header } from './components/Header';
import { LibraryView } from './components/LibraryView';
import { MobileNavBar } from './components/MobileNavBar';
import { RecorderView } from './components/RecorderView';
import { WorkspaceCustomizerDrawer } from './components/WorkspaceCustomizerDrawer';
import { NtkReorderSuite } from './ntk-voice/components/NtkReorderSuite';
import { OfflineIndicator } from './ntk-voice/components/PWAInstallBanner';

interface ToastItem {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'warning' | 'error';
}

const DEFAULT_MIXER: MixerState = {
  voiceVolume: 1.0,
  voiceMuted: false,
  musicVolume: 0.25,
  musicMuted: false,
  musicTrackId: null,
  musicTrackName: null,
  musicBuffer: null,
  autoDucking: true,
  duckAmountDb: -12,
  sfxVolume: 0.85,
  sfxMuted: false,
  sfxPlacements: [],
};

const DEFAULT_MAIN_TRACK_CONTROL: MainTrackControlState = {
  gain: 1.0,
  pan: 0,
  muted: false,
  solo: false,
  eq: { ...DEFAULT_TRACK_EQ },
};

export default function App() {
  // Adaptive System / Light / Dark theming (defaults to OS System preference)
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    try {
      const savedPref = localStorage.getItem('studiowave_theme_pref');
      if (savedPref === 'system' || savedPref === 'light' || savedPref === 'dark') {
        return savedPref;
      }
      const legacy = localStorage.getItem('studiowave_theme');
      if (legacy === 'light' || legacy === 'dark') return legacy;
    } catch {
      // Ignore storage access errors
    }
    return 'system';
  });
  const [systemDark, setSystemDark] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  const theme: ThemeMode =
    themePreference === 'system' ? (systemDark ? 'dark' : 'light') : themePreference;

  const [workspaceConfig, setWorkspaceConfig] = useState<WorkspaceConfig>(() =>
    loadWorkspaceConfig()
  );
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const [openNtkManageOnMount, setOpenNtkManageOnMount] = useState(
    () => typeof window !== 'undefined' && window.location.hash.toLowerCase() === '#manage'
  );
  const [activeStep, setActiveStep] = useState<AppStep>(() =>
    typeof window !== 'undefined' && window.location.hash.toLowerCase() === '#manage'
      ? 'ntk-suite'
      : 'record'
  );
  const [userMode, setUserMode] = useState<UserMode>(() =>
    loadWorkspaceConfig().presetId === 'full-pro' ? 'pro' : 'simple'
  );
  const [ecoMode, setEcoMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('studiowave_eco_mode');
    if (saved === '1') return true;
    if (saved === '0') return false;
    const nav = navigator as unknown as { deviceMemory?: number };
    return typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 2;
  });
  const [isRecording, setIsRecording] = useState(false);

  // Active project audio state (with non-destructive history stack & raw original preserved)
  const [title, setTitle] = useState('Untitled Recording');
  const [originalBuffer, setOriginalBuffer] = useState<AudioBuffer | null>(null);
  const [history, setHistory] = useState<AudioBuffer[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [snapshots, setSnapshots] = useState<ProjectSnapshot[]>([]);
  const [bookmarks, setBookmarks] = useState<BookmarkMarker[]>([]);
  const [oopsMarkers, setOopsMarkers] = useState<OopsMarker[]>([]);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [effects, setEffects] = useState<EffectSettings>(DEFAULT_EFFECTS);
  const [mixer, setMixer] = useState<MixerState>(DEFAULT_MIXER);
  const [overlayTracks, setOverlayTracks] = useState<OverlayTrack[]>([]);
  const [mainTrackControl, setMainTrackControl] = useState<MainTrackControlState>(
    DEFAULT_MAIN_TRACK_CONTROL
  );
  const [importedVideo, setImportedVideo] = useState<ImportedVideoRef | null>(null);
  const [activeAutoSaveId, setActiveAutoSaveId] = useState<string | null>(null);
  const [hasUnsavedEdits, setHasUnsavedEdits] = useState(false);
  const [showWhatNextBar, setShowWhatNextBar] = useState(false);

  // Library & Crash Recovery
  const [libraryRecordings, setLibraryRecordings] = useState<LibraryRecording[]>([]);
  const [pendingRecovery, setPendingRecovery] = useState<AutoSaveSession | null>(null);
  const [isRestoringRecovery, setIsRestoringRecovery] = useState(false);

  // Toasts
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(1);

  // Global keyboard shortcut refs
  const recorderShortcutsRef = useRef<{
    toggleRecord: () => void;
    dropBookmark: () => void;
    oopsRetry: () => void;
  } | null>(null);
  const editorPlayShortcutRef = useRef<(() => void) | null>(null);

  const currentBuffer = historyIndex >= 0 ? history[historyIndex] ?? null : null;

  const notify = useCallback(
    (message: string, tone: ToastItem['tone'] = 'info') => {
      const id = toastIdRef.current++;
      setToasts((prev) => [...prev.slice(-1), { id, message, tone }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3600);
    },
    []
  );

  // Sync theme class on <html>
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash.toLowerCase() === '#manage') {
        setActiveStep('ntk-suite');
        setOpenNtkManageOnMount(true);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.dataset.theme = themePreference;
    try {
      localStorage.setItem('studiowave_theme_pref', themePreference);
      localStorage.setItem('studiowave_theme', theme);
    } catch {
      // Ignore storage access errors
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', theme === 'dark' ? '#0B0E14' : '#F7F8FA');
    }
    syncNativeSystemTheme(theme === 'dark', themePreference);
  }, [theme, themePreference]);

  // Android hardware/gesture Back navigation: close drawer -> return to Record -> double-press exit
  const lastAndroidBackRef = useRef<number>(0);
  useEffect(() => {
    if (!isAndroidNative()) return;
    const onAndroidBack = () => {
      if (customizerOpen) {
        setCustomizerOpen(false);
        return;
      }
      if (activeStep !== 'record') {
        setActiveStep('record');
        return;
      }
      const now = Date.now();
      if (now - lastAndroidBackRef.current < 2200) {
        exitAndroidApp();
      } else {
        lastAndroidBackRef.current = now;
        notify('Press Back again to exit NTK StudioWave.', 'info');
      }
    };
    window.addEventListener('ntk-android-back', onAndroidBack);
    return () => window.removeEventListener('ntk-android-back', onAndroidBack);
  }, [activeStep, customizerOpen, notify]);

  useEffect(() => {
    saveWorkspaceConfig(workspaceConfig);
    setActiveStep((prev) => resolveSafeStep(prev, workspaceConfig));
    if (workspaceConfig.presetId === 'full-pro') {
      setUserMode('pro');
    } else if (
      workspaceConfig.presetId === 'novice-office' ||
      workspaceConfig.presetId === 'recorder-only' ||
      workspaceConfig.presetId === 'ai-office'
    ) {
      setUserMode('simple');
    }
  }, [workspaceConfig]);

  const handleToggleUserMode = useCallback((mode: UserMode) => {
    setUserMode(mode);
    setWorkspaceConfig(getPresetConfig(mode === 'pro' ? 'full-pro' : 'novice-office'));
  }, []);

  useEffect(() => {
    localStorage.setItem('studiowave_eco_mode', ecoMode ? '1' : '0');
    // Immediately trim old undo copies in memory when switching into Lite Mode
    if (ecoMode) {
      setHistory((prev) => {
        const cap = 4;
        if (prev.length <= cap) return prev;
        const drop = prev.length - cap;
        setHistoryIndex((idx) => Math.max(0, idx - drop));
        return prev.slice(drop);
      });
    }
  }, [ecoMode]);

  // Refresh Library from IndexedDB + Check for Crash Recovery Backup on startup
  const refreshLibrary = useCallback(async () => {
    const list = await listLibraryRecordings();
    setLibraryRecordings(list);
  }, []);

  useEffect(() => {
    refreshLibrary();
    getUnfinalizedAutoSave().then((session) => {
      if (session) setPendingRecovery(session);
    });
  }, [refreshLibrary]);

  // Register beforeunload guard when recording is active or unsaved edits exist
  useEffect(() => {
    if (!isRecording && !hasUnsavedEdits) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isRecording, hasUnsavedEdits]);

  // Load a new AudioBuffer into the Studio session
  const loadAudioSession = useCallback(
    (payload: {
      buffer: AudioBuffer;
      title: string;
      bookmarks?: BookmarkMarker[];
      oopsMarkers?: OopsMarker[];
      transcript?: TranscriptSegment[];
      autoSaveSessionId?: string;
      importedVideo?: ImportedVideoRef | null;
      showWhatNext?: boolean;
    }) => {
      setTitle(payload.title);
      setOriginalBuffer(payload.buffer);
      setHistory([payload.buffer]);
      setHistoryIndex(0);
      setSnapshots([
        {
          id: `snap-raw-${Date.now()}`,
          name: 'Raw Original',
          createdAt: Date.now(),
          duration: payload.buffer.duration,
          buffer: payload.buffer,
        },
      ]);
      setBookmarks(payload.bookmarks ?? []);
      setOopsMarkers(payload.oopsMarkers ?? []);
      setTranscript(payload.transcript ?? []);
      setEffects(DEFAULT_EFFECTS);
      setMixer(DEFAULT_MIXER);
      setOverlayTracks([]);
      setMainTrackControl(DEFAULT_MAIN_TRACK_CONTROL);
      setImportedVideo(payload.importedVideo ?? null);
      setActiveAutoSaveId(payload.autoSaveSessionId ?? null);
      setHasUnsavedEdits(true);
      setShowWhatNextBar(Boolean(payload.showWhatNext));
      if (workspaceConfig.showEditScreen) {
        setActiveStep('edit');
      } else if (workspaceConfig.showExportScreen) {
        setActiveStep('export');
      } else {
        setActiveStep('record');
      }
    },
    [workspaceConfig.showEditScreen, workspaceConfig.showExportScreen]
  );

  // Load the built-in offline 15-Second Try-It Sample Recording
  const handleLoadSample = useCallback(() => {
    const ctx = audioBackend.getAudioContext();
    const sample = createTryItSampleRecording(ctx);
    loadAudioSession({
      buffer: sample.buffer,
      title: sample.title,
      bookmarks: sample.bookmarks,
      transcript: sample.transcript,
      showWhatNext: true,
    });
    notify(
      'Loaded 15-Second Sample with background hum, 3 pauses, and 1 repeated take — try Polish Voice or Shrink Pauses!',
      'success'
    );
  }, [loadAudioSession, notify]);

  // Commit non-destructive edit onto bounded Undo/Redo stack (keeps RAM lightweight even on 1GB PCs)
  const handleCommitBuffer = useCallback(
    (next: AudioBuffer, _actionLabel: string) => {
      const maxHistory = ecoMode ? 4 : 8;
      setHistory((prev) => {
        const sliced = [...prev.slice(0, historyIndex + 1), next];
        if (sliced.length > maxHistory) {
          return sliced.slice(sliced.length - maxHistory);
        }
        return sliced;
      });
      setHistoryIndex((idx) => Math.min(maxHistory - 1, idx + 1));
      setHasUnsavedEdits(true);
    },
    [ecoMode, historyIndex]
  );

  const handleUndo = useCallback(() => {
    setHistoryIndex((idx) => Math.max(0, idx - 1));
  }, []);

  const handleRedo = useCallback(() => {
    setHistoryIndex((idx) => Math.min(history.length - 1, idx + 1));
  }, [history.length]);

  const handleSaveSnapshot = useCallback(
    (name: string) => {
      if (!currentBuffer) return;
      setSnapshots((prev) => [
        ...prev,
        {
          id: `snap-${Date.now()}`,
          name,
          createdAt: Date.now(),
          duration: currentBuffer.duration,
          buffer: currentBuffer,
        },
      ]);
      notify(`Saved snapshot "${name}".`, 'info');
    },
    [currentBuffer, notify]
  );

  const handleRestoreSnapshot = useCallback(
    (id: string) => {
      const snap = snapshots.find((s) => s.id === id);
      if (!snap) return;
      handleCommitBuffer(snap.buffer, `Restored snapshot ${snap.name}`);
      notify(`Switched to "${snap.name}".`, 'info');
    },
    [handleCommitBuffer, notify, snapshots]
  );

  // Save current project to Local IndexedDB Library & auto-clean temporary crash recovery chunks
  const handleSaveToLibrary = useCallback(async () => {
    if (!currentBuffer) return;
    try {
      const wavBytes = encodeWavPCM(extractChannels(currentBuffer), currentBuffer.sampleRate);
      const blob = new Blob([wavBytes.buffer as ArrayBuffer], { type: 'audio/wav' });
      const item: LibraryRecording = {
        id: `lib-${Date.now()}`,
        title: title.trim() || 'Untitled Recording',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        duration: currentBuffer.duration,
        sizeBytes: blob.size,
        format: 'wav',
        sampleRate: currentBuffer.sampleRate,
        channels: currentBuffer.numberOfChannels,
        category: 'Podcast',
        favorite: false,
        deletedAt: null,
        blob,
        bookmarks,
        transcript,
      };
      await saveLibraryRecording(item);
      if (activeAutoSaveId) {
        await clearAutoSaveSession(activeAutoSaveId);
        setActiveAutoSaveId(null);
      }
      setHasUnsavedEdits(false);
      await refreshLibrary();
      notify(`Saved "${item.title}" to your Local Library!`, 'success');
    } catch {
      notify('Could not save recording to local storage.', 'error');
    }
  }, [activeAutoSaveId, bookmarks, currentBuffer, notify, refreshLibrary, title, transcript]);

  const handleOpenLibraryItem = useCallback(
    async (item: LibraryRecording) => {
      try {
        const audioBuf = await audioBackend.decodeAudioData(await item.blob.arrayBuffer());
        loadAudioSession({
          buffer: audioBuf,
          title: item.title,
          bookmarks: item.bookmarks ?? [],
          transcript: item.transcript ?? [],
          showWhatNext: false,
        });
        setHasUnsavedEdits(false);
        notify(`Opened "${item.title}" in Editor.`, 'info');
      } catch {
        notify('Could not open recording from Library.', 'error');
      }
    },
    [loadAudioSession, notify]
  );

  // Crash Recovery handlers
  const handleRestoreCrashBackup = async () => {
    if (!pendingRecovery) return;
    setIsRestoringRecovery(true);
    try {
      const blob = await recoverAutoSaveBlob(pendingRecovery.sessionId);
      if (!blob) throw new Error('Empty backup');
      const audioBuf = await audioBackend.decodeAudioData(await blob.arrayBuffer());
      loadAudioSession({
        buffer: audioBuf,
        title: `${pendingRecovery.title} (Recovered)`,
        autoSaveSessionId: pendingRecovery.sessionId,
        showWhatNext: true,
      });
      setPendingRecovery(null);
      notify('Recovered your unfinished recording into the editor!', 'success');
    } catch {
      notify('Backup chunks were incomplete and could not be decoded.', 'warning');
      await clearAutoSaveSession(pendingRecovery.sessionId);
      setPendingRecovery(null);
    } finally {
      setIsRestoringRecovery(false);
    }
  };

  const handleDiscardCrashBackup = async () => {
    if (!pendingRecovery) return;
    await clearAutoSaveSession(pendingRecovery.sessionId);
    setPendingRecovery(null);
    notify('Discarded temporary recovery backup.', 'info');
  };

  // Global Keyboard Shortcuts (Space, R, M, Backspace during recording, Ctrl+Z, Ctrl+Y)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (!isInput && historyIndex > 0) {
          e.preventDefault();
          handleUndo();
        }
        return;
      }
      if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')
      ) {
        if (!isInput && historyIndex < history.length - 1) {
          e.preventDefault();
          handleRedo();
        }
        return;
      }

      if (isInput) return;

      if (e.code === 'Space' && activeStep === 'edit') {
        e.preventDefault();
        editorPlayShortcutRef.current?.();
      } else if (e.key.toLowerCase() === 'r' && activeStep === 'record') {
        e.preventDefault();
        recorderShortcutsRef.current?.toggleRecord();
      } else if (e.key.toLowerCase() === 'm' && isRecording) {
        e.preventDefault();
        recorderShortcutsRef.current?.dropBookmark();
      } else if (e.key === 'Backspace' && isRecording) {
        e.preventDefault();
        recorderShortcutsRef.current?.oopsRetry();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeStep, handleRedo, handleUndo, history.length, historyIndex, isRecording]);

  const activeLibraryCount = libraryRecordings.filter((r) => r.deletedAt === null).length;

  // Estimate live Float32 AudioBuffer RAM footprint in MB (helps verify lightweight 1GB PC operation)
  const estimatedRamMb = (() => {
    const seen = new Set<AudioBuffer>();
    let totalBytes = 0;
    const addBuf = (b: AudioBuffer | null | undefined) => {
      if (!b || seen.has(b)) return;
      seen.add(b);
      totalBytes += b.length * b.numberOfChannels * 4;
    };
    addBuf(originalBuffer);
    history.forEach(addBuf);
    overlayTracks.forEach((t) => addBuf(t.buffer));
    addBuf(mixer.musicBuffer);
    return totalBytes / (1024 * 1024);
  })();

  const handleQuickDownloadWav = useCallback(async () => {
    if (!currentBuffer) return;
    const wavBytes = encodeWavPCM(extractChannels(currentBuffer), currentBuffer.sampleRate);
    const copy = new Uint8Array(wavBytes.byteLength);
    copy.set(wavBytes);
    const blob = new Blob([copy], { type: 'audio/wav' });
    const safe = (title || 'office-recording').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 48);
    const res = await saveBlobToDevice(blob, `${safe}.wav`);
    if (res.saved) {
      notify(
        res.location ? `Saved to ${res.location}` : `Downloaded "${safe}.wav" to your device.`,
        'success'
      );
    }
  }, [currentBuffer, notify, title]);

  const recorderOnly = isRecorderOnlyConfig(workspaceConfig);

  return (
    <div className="min-h-screen flex flex-col bg-[#F7F8FA] text-slate-900 dark:bg-[#0B0E14] dark:text-slate-100 transition-colors">
      <Header
        activeStep={activeStep}
        onSelectStep={setActiveStep}
        userMode={userMode}
        onToggleUserMode={handleToggleUserMode}
        workspaceConfig={workspaceConfig}
        onOpenCustomizer={() => setCustomizerOpen(true)}
        ecoMode={ecoMode}
        onToggleEcoMode={() => {
          setEcoMode((v) => {
            const next = !v;
            notify(
              next
                ? 'Lite Mode ON — optimized for 1GB RAM / older PCs (lower meter FPS & minimal undo memory).'
                : 'Lite Mode OFF — full smooth studio visuals restored.',
              'info'
            );
            return next;
          });
        }}
        estimatedRamMb={estimatedRamMb}
        theme={theme}
        themePreference={themePreference}
        onChangeThemePreference={setThemePreference}
        hasAudioLoaded={Boolean(currentBuffer)}
        libraryCount={activeLibraryCount}
        isRecording={isRecording}
      />

      <main
        className={`flex-1 px-4 sm:px-6 py-5 sm:py-8 ${
          recorderOnly ? 'pb-8' : 'pb-24 md:pb-8'
        }`}
      >
        {activeStep === 'record' && (
          <RecorderView
            userMode={userMode}
            onToggleUserMode={handleToggleUserMode}
            workspaceConfig={workspaceConfig}
            onOpenCustomizer={() => setCustomizerOpen(true)}
            quickSavedClip={
              currentBuffer
                ? {
                    title,
                    duration: currentBuffer.duration,
                    onDownloadWav: handleQuickDownloadWav,
                  }
                : null
            }
            ecoMode={ecoMode}
            theme={theme}
            onRecordingComplete={(payload) =>
              loadAudioSession({
                ...payload,
                showWhatNext: payload.fromRecorder ?? true,
              })
            }
            onLoadSample={handleLoadSample}
            onRecordingStateChange={setIsRecording}
            onNotify={notify}
            registerShortcuts={(handlers) => {
              recorderShortcutsRef.current = handlers;
            }}
          />
        )}

        {activeStep === 'edit' && workspaceConfig.showEditScreen && (
          <EditorView
            userMode={userMode}
            onToggleUserMode={handleToggleUserMode}
            workspaceConfig={workspaceConfig}
            onOpenCustomizer={() => setCustomizerOpen(true)}
            ecoMode={ecoMode}
            theme={theme}
            title={title}
            onChangeTitle={setTitle}
            originalBuffer={originalBuffer}
            currentBuffer={currentBuffer}
            onCommitBuffer={handleCommitBuffer}
            canUndo={historyIndex > 0}
            canRedo={historyIndex >= 0 && historyIndex < history.length - 1}
            onUndo={handleUndo}
            onRedo={handleRedo}
            snapshots={snapshots}
            onSaveSnapshot={handleSaveSnapshot}
            onRestoreSnapshot={handleRestoreSnapshot}
            bookmarks={bookmarks}
            onChangeBookmarks={setBookmarks}
            oopsMarkers={oopsMarkers}
            onChangeOopsMarkers={setOopsMarkers}
            transcript={transcript}
            onChangeTranscript={setTranscript}
            effects={effects}
            onChangeEffects={setEffects}
            mixer={mixer}
            onChangeMixer={setMixer}
            overlayTracks={overlayTracks}
            onChangeOverlayTracks={setOverlayTracks}
            mainTrackControl={mainTrackControl}
            onChangeMainTrackControl={setMainTrackControl}
            importedVideo={importedVideo}
            showWhatNextBar={showWhatNextBar}
            onDismissWhatNext={() => setShowWhatNextBar(false)}
            onSaveToLibrary={handleSaveToLibrary}
            onSaveProjectFile={async () => {
              if (!currentBuffer) return;
              const blob = buildStudioProjectBlob({
                title,
                channels: extractChannels(currentBuffer),
                sampleRate: currentBuffer.sampleRate,
                bookmarks,
                transcript,
                effects,
              });
              const safe = (title || 'studiowave-project').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 48);
              const res = await saveBlobToDevice(blob, `${safe}.swproj`);
              if (res.saved) {
                notify(
                  res.location
                    ? `Saved project to ${res.location}`
                    : `Saved "${safe}.swproj" to your device — reopen anytime in Record.`,
                  'success'
                );
              }
            }}
            onGoToExport={() => {
              if (workspaceConfig.showExportScreen) setActiveStep('export');
              else handleQuickDownloadWav();
            }}
            onGoToRecord={() => setActiveStep('record')}
            onLoadSample={handleLoadSample}
            libraryRecordings={libraryRecordings}
            onNotify={notify}
            registerPlayShortcut={(fn) => {
              editorPlayShortcutRef.current = fn;
            }}
          />
        )}

        {activeStep === 'export' && workspaceConfig.showExportScreen && (
          <ExportView
            userMode={userMode}
            onToggleUserMode={handleToggleUserMode}
            workspaceConfig={workspaceConfig}
            onOpenCustomizer={() => setCustomizerOpen(true)}
            ecoMode={ecoMode}
            buffer={currentBuffer}
            effects={effects}
            overlayTracks={overlayTracks}
            mainTrackControl={mainTrackControl}
            title={title}
            onChangeTitle={setTitle}
            importedVideo={importedVideo}
            onSaveProjectFile={async () => {
              if (!currentBuffer) return;
              const blob = buildStudioProjectBlob({
                title,
                channels: extractChannels(currentBuffer),
                sampleRate: currentBuffer.sampleRate,
                bookmarks,
                transcript,
                effects,
              });
              const safe = (title || 'studiowave-project').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 48);
              const res = await saveBlobToDevice(blob, `${safe}.swproj`);
              if (res.saved) {
                notify(
                  res.location
                    ? `Saved project to ${res.location}`
                    : `Saved project "${safe}.swproj" to your device.`,
                  'success'
                );
              }
            }}
            onGoToRecord={() => setActiveStep('record')}
            onLoadSample={handleLoadSample}
            onNotify={notify}
          />
        )}

        {activeStep === 'library' && workspaceConfig.showLibraryScreen && (
          <LibraryView
            recordings={libraryRecordings}
            onRefresh={refreshLibrary}
            onOpenInEditor={handleOpenLibraryItem}
            onNotify={notify}
            showNoviceHints={workspaceConfig.showNoviceHints}
          />
        )}

        {activeStep === 'batch' && workspaceConfig.showBatchScreen && (
          <BatchStudioView onNotify={notify} />
        )}

        {activeStep === 'ntk-suite' && (
          <NtkReorderSuite
            onNotify={notify}
            openManageOnMount={openNtkManageOnMount}
            onManageHashHandled={() => setOpenNtkManageOnMount(false)}
          />
        )}
      </main>

      <OfflineIndicator />

      {/* Native Mobile Fixed Bottom Navigation Bar */}
      <MobileNavBar
        activeStep={activeStep}
        onSelectStep={setActiveStep}
        workspaceConfig={workspaceConfig}
        onOpenCustomizer={() => setCustomizerOpen(true)}
        libraryCount={activeLibraryCount}
      />

      {/* Full Workspace Customization Drawer / Mobile Bottom Sheet */}
      <WorkspaceCustomizerDrawer
        open={customizerOpen}
        config={workspaceConfig}
        themePreference={themePreference}
        onChangeThemePreference={setThemePreference}
        onChange={(next) => {
          setWorkspaceConfig(next);
          if (next.presetId === 'recorder-only') {
            notify('Switched to Recorder Only mode — only the recorder & timer are shown.', 'info');
          } else if (next.presetId === 'novice-office') {
            notify('Switched to Novice Office layout.', 'info');
          } else if (next.presetId === 'ai-office') {
            notify('Switched to Office + Cloud AI API layout.', 'info');
          } else if (next.presetId === 'full-pro') {
            notify('Switched to Full Pro Studio layout.', 'info');
          }
        }}
        onClose={() => setCustomizerOpen(false)}
      />

      {/* Crash Recovery Modal */}
      {pendingRecovery && (
        <CrashRecoveryModal
          session={pendingRecovery}
          onRestore={handleRestoreCrashBackup}
          onDiscard={handleDiscardCrashBackup}
          isRestoring={isRestoringRecovery}
        />
      )}

      {/* Subtle Toast Stack (clears mobile bottom tab bar; sits bottom-right on desktop) */}
      <div
        aria-live="polite"
        className={`pointer-events-none fixed ${
          recorderOnly ? 'bottom-5' : 'bottom-20 md:bottom-5'
        } right-3 left-3 sm:left-auto sm:right-5 z-50 flex flex-col gap-2 sm:max-w-xs sm:w-full`}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border px-4 py-3 text-xs font-medium shadow-lg backdrop-blur-md ${
              t.tone === 'success'
                ? 'border-emerald-500/40 bg-white/95 dark:bg-slate-900/95 text-emerald-800 dark:text-emerald-200'
                : t.tone === 'warning'
                ? 'border-amber-500/40 bg-white/95 dark:bg-slate-900/95 text-amber-800 dark:text-amber-200'
                : t.tone === 'error'
                ? 'border-rose-500/40 bg-white/95 dark:bg-slate-900/95 text-rose-800 dark:text-rose-200'
                : 'border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 text-slate-800 dark:text-slate-100'
            }`}
          >
            {t.tone === 'success' ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
            ) : t.tone === 'warning' || t.tone === 'error' ? (
              <AlertCircle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            ) : (
              <Info className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
            )}
            <span className="flex-1 leading-relaxed">{t.message}</span>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
              className="text-slate-400 hover:text-slate-700 dark:hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
