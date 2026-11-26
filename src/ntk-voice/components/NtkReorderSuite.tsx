import {
  AlertTriangle,
  Archive,
  Check,
  CheckCircle2,
  Download,
  Edit3,
  Flag,
  FolderArchive,
  Loader2,
  Mic,
  MonitorSpeaker,
  Pause,
  Play,
  RotateCcw,
  Search,
  Settings,
  Share2,
  Sliders,
  Sparkles,
  Square,
  Trash2,
  Upload,
  User,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAndroidNative } from '../../utils/platformFileSave';
import { createTryItSampleRecording } from '../../utils/sampleSynthesizer';
import type {
  NtkCrashSession,
  NtkCustomAiButton,
  NtkLiveConsoleSettings,
  NtkMomentFlag,
  NtkRecordingItem,
  NtkVoiceConfigSnapshot,
} from '../types';
import {
  NtkLiveCaptureEngine,
  decodeBlobToAudioBuffer,
  encodeAudioBufferToWavBlob,
  isMeetingCaptureSupported,
} from '../services/ntkAudioEngine';
import {
  appendCrashChunk,
  clearCrashSession,
  deleteNtkRecordingPermanently,
  exportAllNtkRecordingsZip,
  getLatestCrashSession,
  listNtkRecordings,
  recoverCrashSessionBlob,
  resetAllNtkStorage,
  runNtkRetentionCleanup,
  saveNtkRecording,
  updateCrashSessionFlags,
} from '../services/ntkIndexedDb';
import { ntkVoiceApi } from '../services/ntkVoiceApi';
import {
  applyLocalConfigPatch,
  hasSavedLocalNtkConfig,
  loadLocalNtkConfig,
  mergeServerWithLocalConfig,
  saveLocalNtkConfig,
} from '../services/ntkLocalConfig';
import {
  DEFAULT_NTK_LIVE_CONSOLE,
  buildApiAudioChunksFromBuffer,
  formatClock,
  searchRecordingsByKeyword,
  triggerFileDownload,
} from '../utils/ntkAudioUtils';
import { LiveEqConsole } from './LiveEqConsole';
import { ManagerConsole } from './ManagerConsole';
import { PWAInstallButton } from './PWAInstallBanner';
import { RecordingDetailSheet } from './RecordingDetailSheet';
import { WaveformTrimmerModal } from './WaveformTrimmerModal';

interface NtkReorderSuiteProps {
  onNotify: (msg: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
  openManageOnMount?: boolean;
  onManageHashHandled?: () => void;
}

const FALLBACK_CONFIG: NtkVoiceConfigSnapshot = {
  sttStrategy: 'round_robin',
  llmStrategy: 'round_robin',
  keys: [],
  visibility: {
    aiFeaturesEnabled: false,
    showAdvancedToggle: true,
    meetingAudioCapture: true,
    liveEqConsole: true,
    aiStemMixer: true,
    waveformTrimmer: true,
    momentFlags: true,
    multiFormatExport: true,
    defaultNoisePolish: true,
    optionalProfiles: false,
    localBrowserWhisperFallback: false,
  },
  aiButtons: [
    {
      id: 'btn-transcribe',
      label: 'Get Text',
      description: 'Turn speech into clickable text with timestamps.',
      kind: 'transcribe',
      prompt: 'Transcribe clearly with natural punctuation.',
      enabled: true,
    },
    {
      id: 'btn-summary',
      label: 'Short Summary',
      description: '3–5 clear bullet points.',
      kind: 'intelligence',
      prompt: 'Summarize this recording into 3–5 clear bullet points.',
      enabled: true,
    },
    {
      id: 'btn-actions',
      label: 'Action Items',
      description: 'Extract tasks and decisions.',
      kind: 'intelligence',
      prompt: 'List concrete action items and decisions.',
      enabled: true,
    },
    {
      id: 'btn-formal-email',
      label: 'Clean Formal Email',
      description: 'Fix grammar into a polished email.',
      kind: 'intelligence',
      prompt: 'Rewrite as a clean formal office email.',
      enabled: true,
    },
  ],
  workstation: {
    suiteName: 'NTK Reorder Suite',
    welcomeMessage: '1. Tap Record • 2. Speak normally • 3. Play, edit, or save',
    defaultLanguage: 'auto',
    maxRecordingMinutes: 60,
    autoStopSilenceSec: 0,
    retentionPolicy: '7d',
    dailyAiRequestCap: 250,
    stemSeparationUrl: '',
  },
  dailyUsageDate: new Date().toISOString().slice(0, 10),
  dailyAiRequests: 0,
  failoverLogs: [],
  catalog: { stt: [], llm: [] },
  summary: { sttReady: 0, sttTotal: 0, llmReady: 0, llmTotal: 0, stemConfigured: false },
};

export function NtkReorderSuite({
  onNotify,
  openManageOnMount = false,
  onManageHashHandled,
}: NtkReorderSuiteProps) {
  const [config, setConfig] = useState<NtkVoiceConfigSnapshot>(() =>
    loadLocalNtkConfig(FALLBACK_CONFIG)
  );
  const [recordings, setRecordings] = useState<NtkRecordingItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Novice Simple Mode vs Advanced Tools switch
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [manageOpen, setManageOpen] = useState(openManageOnMount);
  const [trimmerRecId, setTrimmerRecId] = useState<string | null>(null);

  // Recording session state
  const [titleOrName, setTitleOrName] = useState('');
  const [profileTag, setProfileTag] = useState('Shared Desk');
  const [includeMeetingAudio, setIncludeMeetingAudio] = useState(false);
  const [recState, setRecState] = useState<'idle' | 'recording' | 'paused'>('idle');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [meterPct, setMeterPct] = useState(0);
  const [clipping, setClipping] = useState(false);
  const [gateOpen, setGateOpen] = useState(true);
  const [mutedMicAlert, setMutedMicAlert] = useState(false);
  const [liveFlags, setLiveFlags] = useState<NtkMomentFlag[]>([]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [consoleSettings, setConsoleSettings] =
    useState<NtkLiveConsoleSettings>(DEFAULT_NTK_LIVE_CONSOLE);

  // Crash recovery, Undo soft-delete, AI busy states, Rename
  const [crashSession, setCrashSession] = useState<NtkCrashSession | null>(null);
  const [undoDeleteItem, setUndoDeleteItem] = useState<NtkRecordingItem | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [editingTitleVal, setEditingTitleVal] = useState('');
  const [editingHeader, setEditingHeader] = useState(false);
  const [headerDraft, setHeaderDraft] = useState(() => config.workstation.suiteName);

  const engineRef = useRef<NtkLiveCaptureEngine | null>(null);
  const activeCrashIdRef = useRef<string | null>(null);
  const timerIntervalRef = useRef<number | null>(null);
  const meetingSupported = useMemo(() => isMeetingCaptureSupported(), []);

  const refreshRecordings = useCallback(async () => {
    try {
      const items = await listNtkRecordings();
      setRecordings(items);
    } catch {
      // ignore
    }
  }, []);

  // Load config (local-first with optional backend sync), recordings, crash recovery session, audio devices
  useEffect(() => {
    const localInitial = loadLocalNtkConfig(FALLBACK_CONFIG);
    const hasLocal = hasSavedLocalNtkConfig();

    if (isAndroidNative() || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      runNtkRetentionCleanup(localInitial.workstation.retentionPolicy)
        .then(() => refreshRecordings())
        .catch(() => refreshRecordings());
    } else {
      ntkVoiceApi
        .getConfig()
        .then((snap) => {
          const merged = mergeServerWithLocalConfig(snap, hasLocal, localInitial);
          setConfig(merged);
          setHeaderDraft(merged.workstation.suiteName);
          saveLocalNtkConfig(merged);
          if (hasLocal) {
            // Best-effort sync of local settings up to optional backend
            ntkVoiceApi
              .updateConfig({
                sttStrategy: merged.sttStrategy,
                llmStrategy: merged.llmStrategy,
                visibility: merged.visibility,
                aiButtons: merged.aiButtons,
                workstation: {
                  suiteName: merged.workstation.suiteName,
                  welcomeMessage: merged.workstation.welcomeMessage,
                  defaultLanguage: merged.workstation.defaultLanguage,
                  maxRecordingMinutes: merged.workstation.maxRecordingMinutes,
                  autoStopSilenceSec: merged.workstation.autoStopSilenceSec,
                  retentionPolicy: merged.workstation.retentionPolicy,
                  dailyAiRequestCap: merged.workstation.dailyAiRequestCap,
                  stemSeparationUrl: merged.workstation.stemSeparationUrl,
                },
              })
              .catch(() => undefined);
          }
          runNtkRetentionCleanup(merged.workstation.retentionPolicy)
            .then(() => refreshRecordings())
            .catch(() => refreshRecordings());
        })
        .catch(() => {
          runNtkRetentionCleanup(localInitial.workstation.retentionPolicy)
            .then(() => refreshRecordings())
            .catch(() => refreshRecordings());
        });
    }

    getLatestCrashSession()
      .then((s) => {
        if (s) setCrashSession(s);
      })
      .catch(() => undefined);

    if (navigator.mediaDevices?.enumerateDevices) {
      navigator.mediaDevices
        .enumerateDevices()
        .then((list) => setDevices(list.filter((d) => d.kind === 'audioinput')))
        .catch(() => undefined);
    }
  }, [refreshRecordings]);

  useEffect(() => {
    if (openManageOnMount) {
      setManageOpen(true);
      onManageHashHandled?.();
    }
  }, [openManageOnMount, onManageHashHandled]);

  // Listen for `#manage` hash changes directly inside the suite
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash.toLowerCase() === '#manage') {
        setManageOpen(true);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Keep live console changes synced to running Web Audio engine
  useEffect(() => {
    engineRef.current?.applySettings(consoleSettings);
  }, [consoleSettings]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) window.clearInterval(timerIntervalRef.current);
      if (engineRef.current && recState !== 'idle') {
        engineRef.current.stop().catch(() => undefined);
      }
    };
  }, []);

  const activeRecordings = useMemo(() => {
    const list = recordings.filter((r) =>
      showTrash ? r.deletedAt !== null : r.deletedAt === null && !r.clearedFromScreen
    );
    return searchRecordingsByKeyword(list, searchQuery);
  }, [recordings, showTrash, searchQuery]);

  const trashCount = useMemo(
    () => recordings.filter((r) => r.deletedAt !== null).length,
    [recordings]
  );

  const selectedRecording = useMemo(
    () => recordings.find((r) => r.id === selectedId) ?? null,
    [recordings, selectedId]
  );

  const trimmerRecording = useMemo(
    () => recordings.find((r) => r.id === trimmerRecId) ?? null,
    [recordings, trimmerRecId]
  );

  const handleStopRecording = useCallback(async (reason?: string) => {
    if (!engineRef.current) return;
    if (timerIntervalRef.current) {
      window.clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    const engine = engineRef.current;
    engineRef.current = null;
    const crashId = activeCrashIdRef.current;
    activeCrashIdRef.current = null;

    try {
      const { audioBlob, rawMasterBlob, durationSec, mimeType } = await engine.stop();
      setRecState('idle');
      setMeterPct(0);
      setClipping(false);
      setMutedMicAlert(false);

      const now = Date.now();
      const timeLabel = new Date(now).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      const trimmedTitle = titleOrName.trim();
      const rec: NtkRecordingItem = {
        id: `ntk-rec-${now}`,
        title: trimmedTitle || `Voice Note — ${timeLabel}`,
        speakerName: trimmedTitle ? trimmedTitle : config.visibility.optionalProfiles ? profileTag : '',
        profileTag: config.visibility.optionalProfiles ? profileTag : undefined,
        createdAt: now,
        updatedAt: now,
        durationSec,
        mimeType,
        audioBlob,
        rawMasterBlob: rawMasterBlob ?? (!consoleSettings.bakeEqLive ? audioBlob : undefined),
        eqAppliedNonDestructively: !consoleSettings.bakeEqLive ? { ...consoleSettings } : undefined,
        flags: [...liveFlags],
        transcript: [],
        transcriptText: '',
        aiNotes: [],
        deletedAt: null,
      };

      await saveNtkRecording(rec);
      if (crashId) await clearCrashSession(crashId);
      setLiveFlags([]);
      await refreshRecordings();
      setSelectedId(rec.id);
      onNotify(
        reason || `Saved "${rec.title}" (${formatClock(durationSec)}). Ready to play, edit, or download.`,
        'success'
      );
    } catch {
      setRecState('idle');
      onNotify('Stopped recording.', 'info');
    }
  }, [config.visibility.optionalProfiles, consoleSettings, liveFlags, onNotify, profileTag, refreshRecordings, titleOrName]);

  const handleStartRecording = async () => {
    if (recState !== 'idle') return;
    setMutedMicAlert(false);
    setLiveFlags([]);
    setElapsedSec(0);

    const engine = new NtkLiveCaptureEngine(consoleSettings);
    const sessionId = `crash-${Date.now()}`;
    const crashMeta: NtkCrashSession = {
      id: sessionId,
      title: titleOrName.trim() || `Voice Note (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`,
      speakerName: titleOrName.trim(),
      startedAt: Date.now(),
      updatedAt: Date.now(),
      durationSec: 0,
      mimeType: 'audio/webm',
      chunkCount: 0,
      flags: [],
    };

    try {
      const { mimeType } = await engine.start({
        deviceId: selectedDeviceId || undefined,
        includeMeetingAudio: includeMeetingAudio && config.visibility.meetingAudioCapture,
        defaultNovicePolish: config.visibility.defaultNoisePolish,
        settings: consoleSettings,
        maxRecordingMinutes: config.workstation.maxRecordingMinutes,
        autoStopSilenceSec: config.workstation.autoStopSilenceSec,
        callbacks: {
          onLevel: ({ rmsDb, clipping: isClip, gateOpen: isOpen }) => {
            const pct = Math.max(0, Math.min(100, Math.round(((rmsDb + 60) / 56) * 100)));
            setMeterPct(pct);
            setClipping(isClip);
            setGateOpen(isOpen);
            if (rmsDb > -52) setMutedMicAlert(false);
          },
          onChunk: (chunk, idx) => {
            crashMeta.mimeType = mimeType;
            crashMeta.durationSec = engine.getElapsedSeconds();
            appendCrashChunk(crashMeta, chunk, idx).catch(() => undefined);
          },
          onMutedMicWarning: () => {
            setMutedMicAlert(true);
            onNotify('No sound detected — check if your microphone is muted.', 'warning');
          },
          onProlongedSilenceStop: () => {
            handleStopRecording('Auto-stopped after prolonged silence and saved safely.');
          },
          onMaxDurationStop: () => {
            handleStopRecording('Reached maximum recording duration and saved safely.');
          },
        },
      });

      engineRef.current = engine;
      activeCrashIdRef.current = sessionId;
      setRecState('recording');

      timerIntervalRef.current = window.setInterval(() => {
        if (engineRef.current) {
          setElapsedSec(engineRef.current.getElapsedSeconds());
        }
      }, 150);
    } catch (err) {
      onNotify(
        err instanceof Error && /denied|permission/i.test(err.message)
          ? 'Microphone permission was blocked. Please allow mic access in your browser.'
          : 'Could not start recording. Check that a microphone is connected.',
        'error'
      );
    }
  };

  const handlePauseResume = () => {
    if (!engineRef.current) return;
    if (recState === 'recording') {
      engineRef.current.pause();
      setRecState('paused');
    } else if (recState === 'paused') {
      engineRef.current.resume();
      setRecState('recording');
    }
  };

  const handleDropLiveFlag = () => {
    if (recState === 'idle') return;
    const t = Number(elapsedSec.toFixed(1));
    const flag: NtkMomentFlag = {
      id: `flag-${Date.now()}`,
      timeSec: t,
      note: `Important moment at ${formatClock(t)}`,
      createdAt: Date.now(),
    };
    const next = [...liveFlags, flag];
    setLiveFlags(next);
    if (activeCrashIdRef.current) {
      updateCrashSessionFlags(activeCrashIdRef.current, next, t).catch(() => undefined);
    }
    onNotify(`Flagged moment at ${formatClock(t)}.`, 'info');
  };

  const handleRecoverCrash = async () => {
    if (!crashSession) return;
    try {
      const recovered = await recoverCrashSessionBlob(crashSession.id);
      if (recovered) {
        const now = Date.now();
        const item: NtkRecordingItem = {
          id: `ntk-recovered-${now}`,
          title: `${recovered.session.title} (Recovered)`,
          speakerName: recovered.session.speakerName,
          createdAt: recovered.session.startedAt,
          updatedAt: now,
          durationSec: Math.max(1, recovered.session.durationSec),
          mimeType: recovered.session.mimeType,
          audioBlob: recovered.blob,
          rawMasterBlob: recovered.blob,
          flags: recovered.session.flags ?? [],
          transcript: [],
          transcriptText: '',
          aiNotes: [],
          deletedAt: null,
        };
        await saveNtkRecording(item);
        await clearCrashSession(crashSession.id);
        setCrashSession(null);
        await refreshRecordings();
        setSelectedId(item.id);
        onNotify('Recovered unfinished recording safely!', 'success');
      }
    } catch {
      onNotify('Could not restore crash backup.', 'error');
    }
  };

  const handleLoadSampleNote = async () => {
    try {
      const offlineCtx = new OfflineAudioContext(1, 1, 44100);
      const sample = createTryItSampleRecording(offlineCtx);
      const wavBlob = encodeAudioBufferToWavBlob(sample.buffer);
      const now = Date.now();
      const item: NtkRecordingItem = {
        id: `ntk-sample-${now}`,
        title: titleOrName.trim() || 'Office Standup Sample (15s)',
        speakerName: titleOrName.trim() || 'Shared Office Demo',
        createdAt: now,
        updatedAt: now,
        durationSec: Number(sample.buffer.duration.toFixed(2)),
        mimeType: 'audio/wav',
        audioBlob: wavBlob,
        rawMasterBlob: wavBlob,
        flags: [
          { id: `f-1-${now}`, timeSec: 0.4, note: 'Meeting intro', createdAt: now },
          { id: `f-2-${now}`, timeSec: 7.4, note: 'Key follow-up item', createdAt: now },
        ],
        transcript: sample.transcript.map((s) => ({
          id: s.id,
          start: s.start,
          end: s.end,
          text: s.text,
          provider: 'sample',
        })),
        transcriptText: sample.transcript.map((s) => s.text).join(' '),
        aiNotes: [],
        deletedAt: null,
      };
      await saveNtkRecording(item);
      await refreshRecordings();
      setSelectedId(item.id);
      onNotify('Added 15-second sample recording — try Play, 1.5x speed, Flags, or Trim!', 'success');
    } catch {
      onNotify('Could not generate sample recording.', 'error');
    }
  };

  const handleImportAudioFile = async (file: File) => {
    try {
      const buf = await decodeBlobToAudioBuffer(file);
      const now = Date.now();
      const item: NtkRecordingItem = {
        id: `ntk-import-${now}`,
        title: file.name.replace(/\.[^.]+$/, ''),
        speakerName: titleOrName.trim(),
        createdAt: now,
        updatedAt: now,
        durationSec: Number(buf.duration.toFixed(2)),
        mimeType: file.type || 'audio/wav',
        audioBlob: file,
        rawMasterBlob: file,
        flags: [],
        transcript: [],
        transcriptText: '',
        aiNotes: [],
        deletedAt: null,
      };
      await saveNtkRecording(item);
      await refreshRecordings();
      setSelectedId(item.id);
      onNotify(`Imported "${item.title}" into NTK Reorder Suite.`, 'success');
    } catch {
      onNotify('Could not read that audio file. Try MP3, WAV, M4A, or WebM.', 'error');
    }
  };

  const handleRunAiButton = async (rec: NtkRecordingItem, button: NtkCustomAiButton) => {
    if (!config.visibility.aiFeaturesEnabled) {
      onNotify(
        'Optional AI tools are currently off. Enable them anytime in Manage → Feature Visibility (API keys are optional).',
        'info'
      );
      return;
    }
    const needsStt = button.kind === 'transcribe' || !rec.transcriptText.trim();
    if (needsStt && config.summary.sttTotal === 0) {
      onNotify(
        'API keys are optional — add a free key in Manage → Optional AI & API Keys if you want cloud transcription. Recording, EQ, and export work without keys.',
        'info'
      );
      return;
    }
    if (button.kind === 'intelligence' && config.summary.llmTotal === 0) {
      onNotify(
        'API keys are optional — add a free Text AI key in Manage → Optional AI & API Keys if you want summaries or notes. Recording, EQ, and export work without keys.',
        'info'
      );
      return;
    }
    const actionKey = `${rec.id}:${button.id}`;
    setBusyActionId(actionKey);
    try {
      let currentRec = rec;

      // Run transcription if button is transcribe OR if intelligence button clicked before transcript exists
      if (needsStt) {
        const decoded = await decodeBlobToAudioBuffer(currentRec.audioBlob);
        // Automatic Audio Chunker slices >15MB recordings into clean <12MB chunks with exact timestamps
        const chunks = buildApiAudioChunksFromBuffer(decoded, 12 * 1024 * 1024);
        const sttRes = await ntkVoiceApi.transcribeChunks({
          chunks,
          language: config.workstation.defaultLanguage,
        });
        currentRec = {
          ...currentRec,
          transcript: sttRes.segments,
          transcriptText: sttRes.text,
          transcriptProvider: sttRes.providersUsed.join(', '),
          updatedAt: Date.now(),
        };
        await saveNtkRecording(currentRec);
        await refreshRecordings();

        if (button.kind === 'transcribe') {
          onNotify(
            `Transcript ready via ${sttRes.providersUsed.join(' + ')}${
              sttRes.failovers > 0 ? ` (${sttRes.failovers} silent failover)` : ''
            }.`,
            'success'
          );
          // Refresh config counters
          ntkVoiceApi.getConfig().then(setConfig).catch(() => undefined);
          return;
        }
      }

      const llmRes = await ntkVoiceApi.runIntelligence({
        transcript: currentRec.transcriptText,
        buttonId: button.id,
        prompt: button.prompt,
        targetLanguage: button.targetLanguage,
        buttonLabel: button.label,
      });

      const newNote = {
        id: `note-${Date.now()}`,
        buttonId: button.id,
        label: button.label,
        text: llmRes.text,
        provider: llmRes.provider,
        model: llmRes.model,
        createdAt: Date.now(),
      };
      const updatedRec: NtkRecordingItem = {
        ...currentRec,
        aiNotes: [newNote, ...currentRec.aiNotes.filter((n) => n.buttonId !== button.id)],
        updatedAt: Date.now(),
      };
      await saveNtkRecording(updatedRec);
      await refreshRecordings();
      ntkVoiceApi.getConfig().then(setConfig).catch(() => undefined);
      onNotify(
        `${button.label} ready via ${llmRes.provider}${
          llmRes.failovers > 0 ? ` (${llmRes.failovers} failover)` : ''
        }.`,
        'success'
      );
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'AI request failed. Check Manage → API Key Pool.',
        'error'
      );
    } finally {
      setBusyActionId(null);
    }
  };

  const handleSoftDelete = async (rec: NtkRecordingItem) => {
    const updated = { ...rec, deletedAt: Date.now(), updatedAt: Date.now() };
    await saveNtkRecording(updated);
    if (selectedId === rec.id) setSelectedId(null);
    setUndoDeleteItem(rec);
    await refreshRecordings();
  };

  const handleUndoDelete = async () => {
    if (!undoDeleteItem) return;
    await saveNtkRecording({ ...undoDeleteItem, deletedAt: null, updatedAt: Date.now() });
    setUndoDeleteItem(null);
    await refreshRecordings();
    onNotify('Recording restored.', 'success');
  };

  const handleSaveAndClearScreen = async () => {
    const active = recordings.filter((r) => r.deletedAt === null && !r.clearedFromScreen);
    if (active.length === 0) {
      setTitleOrName('');
      onNotify('Screen is already clear for the next coworker.', 'info');
      return;
    }
    for (const r of active) {
      await saveNtkRecording({ ...r, clearedFromScreen: true, updatedAt: Date.now() });
    }
    setTitleOrName('');
    setSelectedId(null);
    await refreshRecordings();
    onNotify(
      `Cleared ${active.length} item(s) from screen for the next coworker (still backed up in Export All .zip).`,
      'success'
    );
  };

  const handleExportAllZip = async () => {
    try {
      const { blob, count } = await exportAllNtkRecordingsZip();
      if (count === 0) {
        onNotify('No recordings to include in backup yet.', 'info');
        return;
      }
      const dateStr = new Date().toISOString().slice(0, 10);
      triggerFileDownload(blob, `NTK_Reorder_Suite_Backup_${dateStr}.zip`);
      onNotify(`Exported ${count} recording(s) + transcripts & notes as .zip backup.`, 'success');
    } catch {
      onNotify('Could not create .zip backup.', 'error');
    }
  };

  const handleSaveHeaderName = async () => {
    setEditingHeader(false);
    const trimmed = headerDraft.trim();
    if (!trimmed || trimmed === config.workstation.suiteName) return;
    const localNext = applyLocalConfigPatch(config, { workstation: { suiteName: trimmed } });
    saveLocalNtkConfig(localNext);
    setConfig(localNext);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      onNotify(`Suite header updated locally to "${trimmed}".`, 'success');
      return;
    }
    try {
      const next = await ntkVoiceApi.updateConfig({ workstation: { suiteName: trimmed } });
      saveLocalNtkConfig(next);
      setConfig(next);
      onNotify(`Suite header updated to "${trimmed}".`, 'success');
    } catch {
      onNotify(`Suite header updated locally to "${trimmed}".`, 'success');
    }
  };

  const aiReadyCount = config.summary.sttReady + config.summary.llmReady;
  const quickAiButtons = config.aiButtons.filter((b) => b.enabled).slice(0, 3);

  return (
    <div
      data-testid="ntk-reorder-suite"
      className="mx-auto max-w-[1280px] space-y-5 pb-32 md:pb-8"
    >
      {/* Top Calm Suite Bar: Editable Title, Subtle AI Status Pill, Advanced Tools Toggle, Discreet Manage */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] px-4 sm:px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-2.5 min-w-0">
          {editingHeader ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSaveHeaderName();
              }}
              className="flex items-center gap-1.5"
            >
              <input
                type="text"
                autoFocus
                aria-label="Edit suite name"
                value={headerDraft}
                onChange={(e) => setHeaderDraft(e.target.value)}
                onBlur={handleSaveHeaderName}
                className="rounded-lg border border-blue-500 bg-white dark:bg-slate-900 px-2.5 py-1 font-display text-base font-bold text-slate-900 dark:text-white"
              />
              <button
                type="submit"
                aria-label="Save suite name"
                className="rounded-lg bg-blue-600 p-1.5 text-white"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => {
                setHeaderDraft(config.workstation.suiteName);
                setEditingHeader(true);
              }}
              title="Click to rename suite header"
              className="group inline-flex items-center gap-1.5 text-left"
            >
              <h1 className="font-display text-lg sm:text-xl font-bold tracking-tight text-slate-900 dark:text-white">
                {config.workstation.suiteName}
              </h1>
              <Edit3 className="h-3.5 w-3.5 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          )}

          {/* Subtle Optional AI Status Pill (never alarming — AI & keys are 100% optional) */}
          <button
            type="button"
            onClick={() => setManageOpen(true)}
            data-testid="ntk-ai-status-pill"
            title="AI and API keys are optional. Click to adjust settings in Manage."
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${
              config.visibility.aiFeaturesEnabled && aiReadyCount > 0
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-slate-200 dark:border-slate-700 bg-slate-100/80 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                config.visibility.aiFeaturesEnabled && aiReadyCount > 0
                  ? 'bg-emerald-500'
                  : 'bg-slate-400 dark:bg-slate-500'
              }`}
            />
            <span>
              {!config.visibility.aiFeaturesEnabled
                ? 'AI Optional · Off'
                : aiReadyCount > 0
                ? `AI Ready (${config.summary.sttReady} STT · ${config.summary.llmReady} Text)`
                : 'AI Optional · No Keys'}
            </span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="md:hidden">
            <PWAInstallButton compact />
          </span>

          {/* Single Unobtrusive Show Advanced Tools Toggle */}
          {config.visibility.showAdvancedToggle && (
            <button
              type="button"
              role="switch"
              aria-checked={showAdvanced}
              data-testid="ntk-advanced-toggle"
              onClick={() => setShowAdvanced((v) => !v)}
              className={`inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
                showAdvanced
                  ? 'border-blue-500/50 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                  : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300'
              }`}
            >
              <Sliders className="h-3.5 w-3.5" />
              <span>Show Advanced Tools</span>
              <span
                className={`inline-flex h-4 w-7 items-center rounded-full p-0.5 transition-colors ${
                  showAdvanced ? 'bg-blue-600 justify-end' : 'bg-slate-300 dark:bg-slate-700 justify-start'
                }`}
              >
                <span className="h-3 w-3 rounded-full bg-white" />
              </span>
            </button>
          )}

          {/* Discreet No-PIN Manage Launcher */}
          <button
            type="button"
            data-testid="ntk-open-manage-btn"
            onClick={() => setManageOpen(true)}
            title="Open Manager Console (API key pool, visibility matrix, prompts, safety settings)"
            className="inline-flex items-center gap-1 rounded-xl border border-transparent px-2.5 py-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:border-slate-200 dark:hover:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors"
          >
            <Settings className="h-3.5 w-3.5" />
            <span>Manage</span>
          </button>
        </div>
      </div>

      {/* Crash Recovery Banner */}
      {crashSession && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-400/50 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-xs">
          <div className="flex items-center gap-2.5 text-amber-900 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
            <span>
              <strong>Unfinished recording found:</strong> &ldquo;{crashSession.title}&rdquo; (
              {formatClock(crashSession.durationSec)} backed up every 3s).
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRecoverCrash}
              className="rounded-lg bg-amber-600 px-3 py-1.5 font-semibold text-white hover:bg-amber-700"
            >
              Recover Recording
            </button>
            <button
              type="button"
              onClick={async () => {
                await clearCrashSession(crashSession.id);
                setCrashSession(null);
              }}
              className="rounded-lg border border-amber-400/60 px-2.5 py-1.5 font-semibold text-amber-800 dark:text-amber-200"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* 5-Second Muted / Silent Mic Alert */}
      {mutedMicAlert && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-2xl border border-rose-400/50 bg-rose-50 dark:bg-rose-950/30 px-4 py-3 text-xs text-rose-800 dark:text-rose-200"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0" />
            <span>
              <strong>No sound detected</strong> — check if your microphone is muted or pick another input in Advanced Tools.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setMutedMicAlert(false)}
            className="font-semibold underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Soft-Delete Undo Banner */}
      {undoDeleteItem && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-900 text-white px-4 py-2.5 text-xs shadow-sm">
          <span>Moved &ldquo;{undoDeleteItem.title}&rdquo; to 7-day Trash.</span>
          <button
            type="button"
            onClick={handleUndoDelete}
            className="inline-flex items-center gap-1 rounded-lg bg-blue-500 px-3 py-1 font-semibold text-white hover:bg-blue-400"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Undo</span>
          </button>
        </div>
      )}

      {/* Main Responsive Workspace: Recorder + Recordings List (+ Side Detail on Desktop) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left / Primary Column: Calm Recorder Card + Recordings List */}
        <div className={`space-y-5 ${selectedRecording ? 'lg:col-span-7' : 'lg:col-span-12'}`}>
          {/* Calm Novice Recorder Card */}
          <section
            aria-label="Voice Recorder"
            className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 sm:p-6 space-y-5"
          >
            {/* Optional Title / Your Name (+ Optional Profile if Manager enabled it) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="space-y-1 text-xs">
                <span className="font-semibold text-slate-600 dark:text-slate-300">
                  Title / Your Name (optional)
                </span>
                <input
                  type="text"
                  data-testid="ntk-title-input"
                  value={titleOrName}
                  onChange={(e) => setTitleOrName(e.target.value)}
                  placeholder="e.g. Morning Sync — Alex"
                  className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900 px-3.5 py-2.5 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
                />
              </label>

              {config.visibility.optionalProfiles ? (
                <label className="space-y-1 text-xs">
                  <span className="font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1">
                    <User className="h-3.5 w-3.5 text-blue-600" />
                    <span>Optional Profile Tag</span>
                  </span>
                  <input
                    type="text"
                    value={profileTag}
                    onChange={(e) => setProfileTag(e.target.value)}
                    placeholder="Shared Desk"
                    className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900 px-3.5 py-2.5 text-sm text-slate-900 dark:text-white"
                  />
                </label>
              ) : (
                <div className="flex items-end">
                  <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed pb-1">
                    {config.workstation.welcomeMessage}
                  </p>
                </div>
              )}
            </div>

            {/* Optional Online Meeting Audio Capture (Desktop Chrome/Edge ONLY) */}
            {meetingSupported && config.visibility.meetingAudioCapture && (
              <div className="hidden md:flex rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 px-3.5 py-2.5 flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={recState !== 'idle'}
                    checked={includeMeetingAudio}
                    onChange={(e) => setIncludeMeetingAudio(e.target.checked)}
                    className="rounded accent-blue-600"
                  />
                  <MonitorSpeaker className="h-4 w-4 text-blue-600" />
                  <span>Record Online Meeting (Call Audio + My Mic)</span>
                </label>
                {includeMeetingAudio && (
                  <span className="text-[11px] text-amber-700 dark:text-amber-300">
                    Friendly reminder: let meeting participants know before recording.
                  </span>
                )}
              </div>
            )}

            {/* Giant Readable Timer + Calm Volume Meter */}
            <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/60 px-4 py-6 text-center space-y-3">
              <div
                data-testid="ntk-timer-display"
                className="font-mono text-4xl sm:text-5xl font-bold tracking-tight tabular-nums text-slate-900 dark:text-white"
              >
                {formatClock(elapsedSec, true)}
              </div>

              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {recState === 'recording' ? (
                  <span className="inline-flex items-center gap-1.5 text-rose-600 dark:text-rose-400 font-semibold">
                    <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
                    <span>Recording safely (auto-saved every 3s)</span>
                  </span>
                ) : recState === 'paused' ? (
                  <span className="text-amber-600 dark:text-amber-400 font-semibold">
                    Paused — tap Resume to continue or Stop to save
                  </span>
                ) : (
                  <span>
                    Ready to record · Shared office workstation (no login required)
                  </span>
                )}
              </div>

              {/* Calm Level Bar */}
              <div className="w-full max-w-md h-2.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-100 ${
                    clipping
                      ? 'bg-rose-500'
                      : recState === 'recording'
                      ? 'bg-blue-600'
                      : 'bg-slate-400'
                  }`}
                  style={{ width: `${recState === 'idle' ? 0 : Math.max(4, meterPct)}%` }}
                />
              </div>

              {/* Mobile Wake Lock Polite Tip while Recording */}
              {recState === 'recording' && (
                <p className="md:hidden text-[11px] text-slate-500 dark:text-slate-400">
                  Keep screen open while recording (Wake Lock active)
                </p>
              )}

              {/* Desktop Record / Pause / Flag / Stop Controls */}
              <div className="hidden md:flex flex-wrap items-center justify-center gap-3 pt-2">
                {recState === 'idle' ? (
                  <>
                    <button
                      type="button"
                      data-testid="ntk-desktop-record-btn"
                      onClick={handleStartRecording}
                      className="inline-flex items-center gap-2.5 rounded-full bg-rose-600 px-8 py-3.5 text-sm font-bold text-white shadow-md hover:bg-rose-700 transition-colors"
                    >
                      <Mic className="h-4.5 w-4.5" />
                      <span>Start Recording</span>
                    </button>

                    <label className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 cursor-pointer">
                      <Upload className="h-3.5 w-3.5 text-blue-600" />
                      <span>Open Audio File</span>
                      <input
                        type="file"
                        accept="audio/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleImportAudioFile(f);
                          e.target.value = '';
                        }}
                      />
                    </label>

                    <button
                      type="button"
                      data-testid="ntk-try-sample-btn"
                      onClick={handleLoadSampleNote}
                      className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 dark:border-blue-800/70 bg-blue-50/80 dark:bg-blue-950/30 px-4 py-3 text-xs font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-100"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>Try Sample Note</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={handlePauseResume}
                      className="inline-flex items-center gap-2 rounded-full border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-5 py-3 text-sm font-semibold text-slate-800 dark:text-white hover:bg-slate-100"
                    >
                      {recState === 'paused' ? (
                        <>
                          <Play className="h-4 w-4 text-emerald-600" />
                          <span>Resume</span>
                        </>
                      ) : (
                        <>
                          <Pause className="h-4 w-4 text-amber-600" />
                          <span>Pause</span>
                        </>
                      )}
                    </button>

                    {config.visibility.momentFlags && (
                      <button
                        type="button"
                        onClick={handleDropLiveFlag}
                        className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm font-semibold text-amber-800 dark:text-amber-300"
                      >
                        <Flag className="h-4 w-4" />
                        <span>Flag Moment ({liveFlags.length})</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleStopRecording()}
                      className="inline-flex items-center gap-2 rounded-full bg-slate-900 dark:bg-white px-7 py-3 text-sm font-bold text-white dark:text-slate-900 hover:opacity-90"
                    >
                      <Square className="h-4 w-4 fill-current" />
                      <span>Stop &amp; Save</span>
                    </button>
                  </>
                )}
              </div>

              {/* Mobile quick helper row (Open File / Try Sample) when idle */}
              {recState === 'idle' && (
                <div className="flex md:hidden flex-wrap items-center justify-center gap-2 pt-1">
                  <label className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                    <Upload className="h-3.5 w-3.5 text-blue-600" />
                    <span>Open Audio</span>
                    <input
                      type="file"
                      accept="audio/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleImportAudioFile(f);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handleLoadSampleNote}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 px-3 py-2 text-xs font-semibold text-blue-700 dark:text-blue-300"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>Try Sample</span>
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* Live Sound Engineering Console (Revealed ONLY when Advanced Tools is ON) */}
          {showAdvanced && config.visibility.liveEqConsole && (
            <LiveEqConsole
              settings={consoleSettings}
              onChange={setConsoleSettings}
              devices={devices}
              selectedDeviceId={selectedDeviceId}
              onSelectDevice={setSelectedDeviceId}
              clipping={clipping}
              gateOpen={gateOpen}
              isRecording={recState !== 'idle'}
            />
          )}

          {/* Recordings List Section */}
          <section
            aria-label="Saved Recordings"
            className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-4 sm:p-5 space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex items-center gap-2">
                <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                  {showTrash ? `Trash (${trashCount})` : `Recordings (${activeRecordings.length})`}
                </h2>
                <button
                  type="button"
                  onClick={() => setShowTrash((v) => !v)}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                    showTrash
                      ? 'border-blue-600 bg-blue-600 text-white'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {showTrash ? 'Back to Active' : `Trash (${trashCount})`}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleExportAllZip}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100"
                >
                  <FolderArchive className="h-3.5 w-3.5 text-blue-600" />
                  <span>Export All (.zip)</span>
                </button>
                <button
                  type="button"
                  onClick={handleSaveAndClearScreen}
                  title="Hides current list from screen for the next coworker while keeping files in your backup"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100"
                >
                  <Archive className="h-3.5 w-3.5 text-slate-500" />
                  <span>Save &amp; Clear Screen</span>
                </button>
              </div>
            </div>

            {/* Keyword Search Across Titles, Transcripts, Flags & Notes */}
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="search"
                aria-label="Search recordings and transcripts"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by title, speaker, transcript keyword, or flag..."
                className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900 pl-9 pr-3 py-2 text-xs text-slate-900 dark:text-white"
              />
            </div>

            {activeRecordings.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 py-8 px-4 text-center space-y-2">
                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                  {showTrash
                    ? 'Trash is empty (deleted items auto-clear after 7 days)'
                    : 'No recordings on screen yet'}
                </p>
                {!showTrash && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {config.workstation.welcomeMessage}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2.5">
                {activeRecordings.map((rec) => {
                  const isSelected = selectedId === rec.id;
                  return (
                    <div
                      key={rec.id}
                      data-testid={`ntk-recording-row-${rec.id}`}
                      className={`rounded-xl border p-3.5 transition-colors ${
                        isSelected
                          ? 'border-blue-500 bg-blue-50/40 dark:bg-blue-950/25'
                          : 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          {editingTitleId === rec.id ? (
                            <form
                              onSubmit={async (e) => {
                                e.preventDefault();
                                const trimmed = editingTitleVal.trim();
                                if (trimmed) {
                                  await saveNtkRecording({
                                    ...rec,
                                    title: trimmed,
                                    updatedAt: Date.now(),
                                  });
                                  await refreshRecordings();
                                }
                                setEditingTitleId(null);
                              }}
                              className="flex items-center gap-1.5"
                            >
                              <input
                                type="text"
                                autoFocus
                                value={editingTitleVal}
                                onChange={(e) => setEditingTitleVal(e.target.value)}
                                className="rounded-lg border border-blue-500 bg-white dark:bg-slate-900 px-2 py-1 text-xs font-bold text-slate-900 dark:text-white"
                              />
                              <button
                                type="submit"
                                className="rounded-lg bg-blue-600 px-2 py-1 text-xs font-semibold text-white"
                              >
                                Save
                              </button>
                            </form>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setSelectedId(rec.id)}
                              className="text-left group"
                            >
                              <div className="text-sm font-bold text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400">
                                {rec.title}
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                                <span className="font-mono font-semibold text-slate-700 dark:text-slate-300">
                                  {formatClock(rec.durationSec)}
                                </span>
                                <span>·</span>
                                <span>
                                  {new Date(rec.createdAt).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                                </span>
                                {rec.flags.length > 0 && <span>· {rec.flags.length} flag(s)</span>}
                                {rec.transcript.length > 0 && (
                                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                                    · Transcript ready
                                  </span>
                                )}
                                {rec.aiNotes.length > 0 && (
                                  <span className="text-blue-600 dark:text-blue-400 font-semibold">
                                    · {rec.aiNotes.length} AI note(s)
                                  </span>
                                )}
                              </div>
                            </button>
                          )}
                        </div>

                        {/* Row Quick Controls */}
                        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                          {showTrash ? (
                            <>
                              <button
                                type="button"
                                onClick={async () => {
                                  await saveNtkRecording({
                                    ...rec,
                                    deletedAt: null,
                                    updatedAt: Date.now(),
                                  });
                                  await refreshRecordings();
                                  onNotify('Restored recording from Trash.', 'success');
                                }}
                                className="rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white"
                              >
                                Restore
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  await deleteNtkRecordingPermanently(rec.id);
                                  await refreshRecordings();
                                }}
                                className="rounded-lg border border-rose-300 px-2.5 py-1.5 text-xs font-semibold text-rose-600"
                              >
                                Delete Forever
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => setSelectedId(rec.id)}
                                className="inline-flex items-center gap-1 rounded-lg bg-slate-900 dark:bg-white px-3 py-1.5 text-xs font-semibold text-white dark:text-slate-900"
                              >
                                <Play className="h-3 w-3" />
                                <span>Open &amp; Play</span>
                              </button>
                              <button
                                type="button"
                                aria-label={`Rename ${rec.title}`}
                                onClick={() => {
                                  setEditingTitleId(rec.id);
                                  setEditingTitleVal(rec.title);
                                }}
                                className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                                title="Rename"
                              >
                                <Edit3 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                aria-label={`Download ${rec.title}`}
                                onClick={() => {
                                  const safe = rec.title.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40);
                                  const ext = /wav/i.test(rec.mimeType) ? 'wav' : 'webm';
                                  triggerFileDownload(rec.audioBlob, `${safe || 'recording'}.${ext}`);
                                }}
                                className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                                title="Download audio"
                              >
                                <Download className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                aria-label={`Share ${rec.title}`}
                                onClick={async () => {
                                  const safe = rec.title.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40);
                                  const ext = /wav/i.test(rec.mimeType) ? 'wav' : 'webm';
                                  const f = new File([rec.audioBlob], `${safe}.${ext}`, {
                                    type: rec.mimeType || 'audio/webm',
                                  });
                                  if (navigator.canShare && navigator.canShare({ files: [f] })) {
                                    await navigator.share({ title: rec.title, files: [f] }).catch(() => undefined);
                                  } else {
                                    triggerFileDownload(rec.audioBlob, `${safe}.${ext}`);
                                  }
                                }}
                                className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                                title="Share"
                              >
                                <Share2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                aria-label={`Move ${rec.title} to trash`}
                                onClick={() => handleSoftDelete(rec)}
                                className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 hover:text-rose-600"
                                title="Move to 7-day Trash"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Optional 1-Click AI Action Row (hidden when AI is OFF) */}
                      {config.visibility.aiFeaturesEnabled && !showTrash && quickAiButtons.length > 0 && (
                        <div className="mt-3 flex flex-wrap items-center gap-1.5 pt-2.5 border-t border-slate-200/70 dark:border-slate-800">
                          {quickAiButtons.map((btn) => {
                            const busy = busyActionId === `${rec.id}:${btn.id}`;
                            return (
                              <button
                                key={btn.id}
                                type="button"
                                disabled={busyActionId !== null}
                                onClick={() => {
                                  setSelectedId(rec.id);
                                  handleRunAiButton(rec, btn);
                                }}
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:border-blue-400 hover:text-blue-600 disabled:opacity-50"
                              >
                                {busy ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Sparkles className="h-3 w-3 text-blue-600" />
                                )}
                                <span>{btn.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* Right Column on Desktop / Pull-Up Bottom Sheet on Mobile */}
        {selectedRecording && (
          <div className="lg:col-span-5">
            <RecordingDetailSheet
              recording={selectedRecording}
              aiButtons={config.aiButtons}
              visibility={config.visibility}
              showAdvanced={showAdvanced}
              stemConfigured={config.summary.stemConfigured}
              consoleSettings={consoleSettings}
              busyActionId={busyActionId}
              onRunAiButton={handleRunAiButton}
              onUpdateRecording={async (updated) => {
                await saveNtkRecording(updated);
                await refreshRecordings();
              }}
              onOpenTrimmer={() => setTrimmerRecId(selectedRecording.id)}
              onOpenManage={() => setManageOpen(true)}
              onClose={() => setSelectedId(null)}
              onNotify={onNotify}
            />
          </div>
        )}
      </div>

      {/* NATIVE MOBILE STICKY THUMB-FRIENDLY BOTTOM RECORDER DOCK (< 768px) */}
      <div
        data-testid="ntk-mobile-dock"
        className="md:hidden fixed bottom-0 left-0 right-0 z-30 border-t border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#0E131D]/95 backdrop-blur-md px-5 pt-2.5 shadow-2xl"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <div className="mx-auto flex max-w-sm items-center justify-around gap-4">
          {/* Left slot: Pause/Resume when recording, or Recordings sheet trigger when idle */}
          {recState !== 'idle' ? (
            <button
              type="button"
              onClick={handlePauseResume}
              aria-label={recState === 'paused' ? 'Resume recording' : 'Pause recording'}
              className="flex flex-col items-center justify-center min-h-[48px] min-w-[60px] rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-100"
            >
              {recState === 'paused' ? <Play className="h-5 w-5 text-emerald-600" /> : <Pause className="h-5 w-5 text-amber-600" />}
              <span className="text-[10px] font-semibold mt-0.5">
                {recState === 'paused' ? 'Resume' : 'Pause'}
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (activeRecordings[0]) setSelectedId(activeRecordings[0].id);
                else handleLoadSampleNote();
              }}
              className="flex flex-col items-center justify-center min-h-[48px] min-w-[60px] text-slate-600 dark:text-slate-300"
            >
              <CheckCircle2 className="h-5 w-5" />
              <span className="text-[10px] font-semibold mt-0.5">
                {activeRecordings.length > 0 ? `Notes (${activeRecordings.length})` : 'Sample'}
              </span>
            </button>
          )}

          {/* Center Circular Record / Stop Orb */}
          <button
            type="button"
            data-testid="ntk-mobile-record-orb"
            onClick={recState === 'idle' ? handleStartRecording : () => handleStopRecording()}
            aria-label={recState === 'idle' ? 'Start recording' : 'Stop and save recording'}
            className={`flex h-16 w-16 items-center justify-center rounded-full shadow-lg transition-transform active:scale-95 ${
              recState === 'idle'
                ? 'bg-rose-600 text-white ring-4 ring-rose-500/25'
                : 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 ring-4 ring-rose-500/35'
            }`}
          >
            {recState === 'idle' ? (
              <Mic className="h-7 w-7" />
            ) : (
              <Square className="h-6 w-6 fill-current" />
            )}
          </button>

          {/* Right slot: Flag Moment while recording, or Manage when idle */}
          {recState !== 'idle' && config.visibility.momentFlags ? (
            <button
              type="button"
              onClick={handleDropLiveFlag}
              aria-label="Flag important moment"
              className="flex flex-col items-center justify-center min-h-[48px] min-w-[60px] rounded-2xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300"
            >
              <Flag className="h-5 w-5" />
              <span className="text-[10px] font-semibold mt-0.5">
                Flag ({liveFlags.length})
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setManageOpen(true)}
              aria-label="Open Manager Console"
              className="flex flex-col items-center justify-center min-h-[48px] min-w-[60px] text-slate-600 dark:text-slate-300"
            >
              <Settings className="h-5 w-5" />
              <span className="text-[10px] font-semibold mt-0.5">Manage</span>
            </button>
          )}
        </div>
      </div>

      {/* Non-Destructive Waveform Trimmer & Voice-Over Modal */}
      {trimmerRecording && (
        <WaveformTrimmerModal
          recording={trimmerRecording}
          consoleSettings={consoleSettings}
          multiFormatExport={config.visibility.multiFormatExport}
          onUpdateRecording={async (updated) => {
            await saveNtkRecording(updated);
            await refreshRecordings();
          }}
          onClose={() => setTrimmerRecId(null)}
          onNotify={onNotify}
        />
      )}

      {/* Discreet No-PIN Manager Console */}
      {manageOpen && (
        <ManagerConsole
          config={config}
          onConfigUpdated={(next) => {
            setConfig(next);
            setHeaderDraft(next.workstation.suiteName);
          }}
          onExportAllZip={handleExportAllZip}
          onMasterResetStorage={async () => {
            await resetAllNtkStorage();
            setSelectedId(null);
            setCrashSession(null);
            setUndoDeleteItem(null);
            await refreshRecordings();
            onNotify('All NTK Reorder Suite local storage wiped cleanly.', 'info');
          }}
          onClose={() => {
            setManageOpen(false);
            if (window.location.hash.toLowerCase() === '#manage') {
              window.history.replaceState(null, '', window.location.pathname + window.location.search);
            }
          }}
          onNotify={onNotify}
        />
      )}
    </div>
  );
}
