import {
  ArrowRight,
  AudioWaveform,
  Bookmark,
  Check,
  Crown,
  Download,
  Eraser,
  FileDown,
  FileText,
  Film,
  Gauge,
  History,
  Layers,
  Mic,
  Music,
  Music2,
  Pause,
  Play,
  Plus,
  Radio,
  Redo2,
  Repeat,
  RotateCcw,
  Save,
  Scissors,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Sliders,
  Sparkles,
  Square,
  Star,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
  Wand2,
  Waves,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AutomationCurveOptions,
  BookmarkMarker,
  DeClickOptions,
  DeReverbOptions,
  EffectSettings,
  ImportedVideoRef,
  LibraryRecording,
  MasteringAnalysis,
  MasteringPlan,
  MixerState,
  MusicalKey,
  MusicalScale,
  NoiseProfile,
  OopsMarker,
  OverlayTrack,
  ProjectSnapshot,
  RealtimeAutoTuneHandle,
  RealtimeAutoTuneState,
  RealtimeDynamicsHandle,
  RealtimeNoiseGateHandle,
  RegionTransformOptions,
  RepetitionRegion,
  SilencePreset,
  SilenceRegion,
  SoundBalanceSettings,
  SpectralBoxSelection,
  SteadyNormalizeOptions,
  SteadyNormalizeStats,
  ThemeMode,
  TrackEqualizerHandle,
  TranscriptSegment,
  UserMode,
} from '../types/audio';
import {
  audioBackend,
  createAudioBufferFromChannels,
  extractChannels,
} from '../services/audioBackend';
import {
  DEFAULT_TRACK_EQ,
  SILENCE_PRESETS,
  calculateTimeSaved,
  countFillerWords,
  cutRangePCM,
  detectRepetitions,
  detectSilences,
  encodeWavPCM,
  formatDuration,
  formatPlainTranscript,
  formatSrtCaptions,
  mixToMono,
  removeSilencesPCM,
  spliceSegmentsWithCrossfade,
  trimRangePCM,
} from '../utils/audioDsp';
import { saveBlobToDevice } from '../utils/platformFileSave';
import {
  MUSICAL_KEYS,
  MUSICAL_SCALES,
  computeTrackPlaybackParams,
} from '../utils/pitchCorrection';
import { STARTER_SOUND_PACK, synthesizeStarterSound } from '../utils/sampleSynthesizer';
import {
  getPresetConfig,
  getVisibleEditorTabs,
  resolveSafeEditorTab,
  type WorkspaceConfig,
} from '../utils/workspaceConfig';
import { AiTranscriptPanel } from './AiTranscriptPanel';
import { AutomationLaneCanvas } from './AutomationLaneCanvas';
import { DuckingEnvelopeCanvas } from './DuckingEnvelopeCanvas';
import { FrequencySpectrumCanvas } from './FrequencySpectrumCanvas';
import { MasteringAssistantPanel } from './MasteringAssistantPanel';
import { SoundControlPanel } from './SoundControlPanel';
import { SpectralRepairPanel } from './SpectralRepairPanel';
import { Tooltip } from './Tooltip';
import { type MainTrackControlState, TrackManagerPanel } from './TrackManagerPanel';
import { WaveformCanvas } from './WaveformCanvas';

interface EditorViewProps {
  userMode: UserMode;
  onToggleUserMode?: (mode: UserMode) => void;
  workspaceConfig?: WorkspaceConfig;
  onOpenCustomizer?: () => void;
  ecoMode?: boolean;
  theme: ThemeMode;
  title: string;
  onChangeTitle: (t: string) => void;
  originalBuffer: AudioBuffer | null;
  currentBuffer: AudioBuffer | null;
  onCommitBuffer: (next: AudioBuffer, actionLabel: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  snapshots: ProjectSnapshot[];
  onSaveSnapshot: (name: string) => void;
  onRestoreSnapshot: (id: string) => void;
  bookmarks: BookmarkMarker[];
  onChangeBookmarks: (next: BookmarkMarker[]) => void;
  oopsMarkers: OopsMarker[];
  onChangeOopsMarkers: (next: OopsMarker[]) => void;
  transcript: TranscriptSegment[];
  onChangeTranscript: (next: TranscriptSegment[]) => void;
  effects: EffectSettings;
  onChangeEffects: (next: EffectSettings) => void;
  mixer: MixerState;
  onChangeMixer: (next: MixerState) => void;
  overlayTracks: OverlayTrack[];
  onChangeOverlayTracks: (next: OverlayTrack[]) => void;
  mainTrackControl: MainTrackControlState;
  onChangeMainTrackControl: (next: MainTrackControlState) => void;
  importedVideo: ImportedVideoRef | null;
  showWhatNextBar: boolean;
  onDismissWhatNext: () => void;
  onSaveToLibrary: () => Promise<void>;
  onSaveProjectFile?: () => void;
  onGoToExport: () => void;
  onGoToRecord: () => void;
  onLoadSample: () => void;
  libraryRecordings: LibraryRecording[];
  onNotify: (msg: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
  registerPlayShortcut?: (togglePlay: () => void) => void;
}

type EditorTab = 'cleanup' | 'sound' | 'repair' | 'tracks' | 'effects' | 'mastering' | 'mixer' | 'transcript';

const TRACK_COLORS = ['#10b981', '#a855f7', '#f59e0b', '#ec4899', '#06b6d4', '#f97316'];

export function EditorView({
  userMode,
  onToggleUserMode,
  workspaceConfig,
  onOpenCustomizer,
  ecoMode = false,
  theme,
  title,
  onChangeTitle,
  originalBuffer,
  currentBuffer,
  onCommitBuffer,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  snapshots,
  onSaveSnapshot,
  onRestoreSnapshot,
  bookmarks,
  onChangeBookmarks,
  oopsMarkers,
  onChangeOopsMarkers,
  transcript,
  onChangeTranscript,
  effects,
  onChangeEffects,
  mixer,
  onChangeMixer,
  overlayTracks,
  onChangeOverlayTracks,
  mainTrackControl,
  onChangeMainTrackControl,
  importedVideo,
  showWhatNextBar,
  onDismissWhatNext,
  onSaveToLibrary,
  onSaveProjectFile,
  onGoToExport,
  onGoToRecord,
  onLoadSample,
  libraryRecordings,
  onNotify,
  registerPlayShortcut,
}: EditorViewProps) {
  const cfg = workspaceConfig ?? getPresetConfig(userMode === 'pro' ? 'full-pro' : 'novice-office');
  const visibleEditorTabIds = useMemo(() => getVisibleEditorTabs(cfg), [cfg]);
  const [activeTab, setActiveTab] = useState<EditorTab>('cleanup');
  useEffect(() => {
    const safe = resolveSafeEditorTab(activeTab, cfg);
    if (safe !== activeTab) setActiveTab(safe);
  }, [activeTab, cfg]);
  const [compareOriginal, setCompareOriginal] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [loopPreview, setLoopPreview] = useState(false);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [snapToSilence, setSnapToSilence] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSavingLib, setIsSavingLib] = useState(false);

  // Silence settings (Natural Pacing: shrink gaps > 0.5s down to exact 0.3s with 15ms linear crossfade)
  const [silencePreset, setSilencePreset] = useState<SilencePreset>('normal');
  const [keepPaddingSec, setKeepPaddingSec] = useState(0.3);
  const [proThresholdDb, setProThresholdDb] = useState(-36);
  const [proMinSilenceSec, setProMinSilenceSec] = useState(0.5);

  // Snapshots & Structural tools
  const [snapshotName, setSnapshotName] = useState('');
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [punchInRecording, setPunchInRecording] = useState(false);
  const punchRecorderRef = useRef<MediaRecorder | null>(null);
  const punchChunksRef = useRef<Blob[]>([]);
  const [stitchId, setStitchId] = useState('');

  // Spectral Subtraction Noise Reduction state
  const [noiseProfile, setNoiseProfile] = useState<NoiseProfile | null>(null);
  const [denoiseStrength, setDenoiseStrength] = useState(80);
  const [denoiseVocalProtect, setDenoiseVocalProtect] = useState(85);
  const [denoiseFloorDb, setDenoiseFloorDb] = useState(-24);

  // Playback engine refs (multi-track overlay + per-track 3-Band EQ + live Noise Gate + FFT Auto-Tune + Dynamics Processor + AnalyserNode)
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const overlaySourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const liveTrackNodesRef = useRef<
    Map<string, { eq: TrackEqualizerHandle; gain: GainNode; panner: StereoPannerNode | null }>
  >(new Map());
  const masterBusRef = useRef<GainNode | null>(null);
  const realtimeNoiseGateRef = useRef<RealtimeNoiseGateHandle | null>(null);
  const realtimeAutoTuneRef = useRef<RealtimeAutoTuneHandle | null>(null);
  const realtimeDynamicsRef = useRef<RealtimeDynamicsHandle | null>(null);
  const [autoTuneTelemetry, setAutoTuneTelemetry] = useState<RealtimeAutoTuneState | null>(null);
  const [dynamicsTelemetry, setDynamicsTelemetry] = useState<{
    enabled: boolean;
    reductionDb: number;
    limiterReductionDb: number;
    limiting: boolean;
  } | null>(null);
  const spectrumAnalyserRef = useRef<AnalyserNode | null>(null);
  const [spectrumAnalyser, setSpectrumAnalyser] = useState<AnalyserNode | null>(null);
  const playStartCtxTimeRef = useRef(0);
  const playStartOffsetRef = useRef(0);
  const playRafRef = useRef(0);
  const activeBuffer = compareOriginal && originalBuffer ? originalBuffer : currentBuffer;
  const duration = useMemo(() => {
    const baseDur = activeBuffer?.duration ?? 0;
    if (compareOriginal || overlayTracks.length === 0) return baseDur;
    return Math.max(baseDur, ...overlayTracks.map((t) => Math.max(0, t.offsetSec) + t.buffer.duration));
  }, [activeBuffer?.duration, compareOriginal, overlayTracks]);

  // Sync preset values when user changes preset in Simple Mode
  const handleSelectSilencePreset = (preset: SilencePreset) => {
    setSilencePreset(preset);
    const cfg = SILENCE_PRESETS[preset];
    setKeepPaddingSec(cfg.keepPaddingSec);
    setProThresholdDb(cfg.thresholdDb);
    setProMinSilenceSec(cfg.minSilenceSec);
  };

  // Detect silences & repetitions whenever buffer or thresholds change
  const { silences, timeSavedSec, repetitions } = useMemo(() => {
    if (!currentBuffer) {
      return {
        silences: [] as SilenceRegion[],
        timeSavedSec: 0,
        repetitions: [] as RepetitionRegion[],
      };
    }
    const mono = mixToMono(extractChannels(currentBuffer));
    const { regions } = detectSilences(mono, currentBuffer.sampleRate, {
      thresholdDb: proThresholdDb,
      minSilenceSec: proMinSilenceSec,
    });
    const saved = calculateTimeSaved(regions, keepPaddingSec);
    const autoReps = detectRepetitions(mono, currentBuffer.sampleRate, {
      thresholdDb: -34,
      similarityThreshold: 0.94,
    });

    // Convert Oops markers from recording into actionable retake regions (~2.2s before marker)
    const oopsRegions: RepetitionRegion[] = oopsMarkers.map((o, idx) => ({
      id: `oops-reg-${o.id}`,
      start: Math.max(0, o.time - 2.2),
      end: Math.min(currentBuffer.duration, o.time + 0.1),
      matchedWithStart: o.time,
      matchedWithEnd: Math.min(currentBuffer.duration, o.time + 2.2),
      similarity: 1,
      source: 'oops',
      label: `Oops Retake #${idx + 1}`,
    }));

    return {
      silences: regions,
      timeSavedSec: saved,
      repetitions: [...oopsRegions, ...autoReps],
    };
  }, [currentBuffer, keepPaddingSec, oopsMarkers, proMinSilenceSec, proThresholdDb]);

  // Playback Controls
  const stopPlayback = useCallback(() => {
    cancelAnimationFrame(playRafRef.current);
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.onended = null;
        sourceNodeRef.current.stop();
        sourceNodeRef.current.disconnect();
      } catch {
        // already stopped
      }
      sourceNodeRef.current = null;
    }
    for (const ovSrc of overlaySourcesRef.current) {
      try {
        ovSrc.stop();
        ovSrc.disconnect();
      } catch {
        // ignore
      }
    }
    overlaySourcesRef.current = [];
    for (const nodePair of liveTrackNodesRef.current.values()) {
      try {
        nodePair.eq.dispose();
        nodePair.gain.disconnect();
        nodePair.panner?.disconnect();
      } catch {
        // ignore
      }
    }
    liveTrackNodesRef.current.clear();
    if (masterBusRef.current) {
      try {
        masterBusRef.current.disconnect();
      } catch {
        // ignore
      }
      masterBusRef.current = null;
    }
    if (realtimeNoiseGateRef.current) {
      realtimeNoiseGateRef.current.dispose();
      realtimeNoiseGateRef.current = null;
    }
    if (realtimeAutoTuneRef.current) {
      realtimeAutoTuneRef.current.dispose();
      realtimeAutoTuneRef.current = null;
    }
    if (realtimeDynamicsRef.current) {
      realtimeDynamicsRef.current.dispose();
      realtimeDynamicsRef.current = null;
    }
    if (spectrumAnalyserRef.current) {
      try {
        spectrumAnalyserRef.current.disconnect();
      } catch {
        // ignore
      }
      spectrumAnalyserRef.current = null;
    }
    setSpectrumAnalyser(null);
    setAutoTuneTelemetry(null);
    setDynamicsTelemetry(null);
    setIsPlaying(false);
  }, []);

  const startPlayback = useCallback(
    (startSec?: number, playDurSec?: number) => {
      if (!activeBuffer) return;
      stopPlayback();

      const ctx = audioBackend.getAudioContext();
      const masterBus = ctx.createGain();
      const analyser = audioBackend.createSpectrumAnalyser(ctx, 2048);
      masterBus.connect(analyser);
      analyser.connect(ctx.destination);

      masterBusRef.current = masterBus;
      spectrumAnalyserRef.current = analyser;
      setSpectrumAnalyser(analyser);

      // Compute DAW Solo/Mute/Gain/Pan routing across main track + all overlaid tracks
      const trackMixInputs = [
        {
          id: 'main-track',
          gain: compareOriginal ? 1.0 : mainTrackControl.gain,
          pan: compareOriginal ? 0 : mainTrackControl.pan,
          muted: compareOriginal ? false : mainTrackControl.muted,
          solo: compareOriginal ? false : mainTrackControl.solo,
        },
        ...(compareOriginal
          ? []
          : overlayTracks.map((t) => ({
              id: t.id,
              gain: t.gain,
              pan: t.pan,
              muted: t.muted,
              solo: t.solo,
            }))),
      ];
      const routingMap = computeTrackPlaybackParams(trackMixInputs);

      // Main Track Chain: Source -> Real-Time Noise Gate -> Real-Time FFT Auto-Tune -> Dynamics Processor -> 3-Band EQ -> Gain -> StereoPanner -> MasterBus
      const src = ctx.createBufferSource();
      src.buffer = activeBuffer;
      src.playbackRate.value = playbackRate;

      const noiseGate = audioBackend.createRealtimeNoiseGate(ctx, {
        enabled: !compareOriginal && effects.noiseGate,
        thresholdDb: effects.noiseGateDb,
        floorGain: 0.02,
      });
      const autoTune = audioBackend.createRealtimeAutoTune(ctx, {
        enabled: !compareOriginal && effects.autoTune,
        key: effects.autoTuneKey,
        scale: effects.autoTuneScale,
        strength: effects.autoTuneStrength,
      });
      const dynamics = audioBackend.createRealtimeDynamicsProcessor(ctx, {
        enabled: !compareOriginal && effects.dynamicsProcessor,
        thresholdDb: effects.dynamicsThresholdDb,
        kneeDb: 12,
        ratio: effects.dynamicsRatio,
        attackSec: 0.008,
        releaseSec: 0.16,
        makeupGainDb: effects.dynamicsMakeupDb,
        limiterCeilingDb: effects.limiterCeilingDb,
      });
      const mainEq = audioBackend.createTrackEqualizer(
        ctx,
        compareOriginal ? { ...DEFAULT_TRACK_EQ, enabled: false } : mainTrackControl.eq
      );

      const mainRoute = routingMap['main-track'];
      const mainGain = ctx.createGain();
      mainGain.gain.setValueAtTime(mainRoute?.effectiveGain ?? 1.0, ctx.currentTime);
      const mainPanner =
        typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
      if (mainPanner) {
        mainPanner.pan.setValueAtTime(mainRoute?.pan ?? 0, ctx.currentTime);
      }

      src.connect(noiseGate.input);
      noiseGate.output.connect(autoTune.input);
      autoTune.output.connect(dynamics.input);
      dynamics.output.connect(mainEq.input);
      mainEq.output.connect(mainGain);
      if (mainPanner) {
        mainGain.connect(mainPanner);
        mainPanner.connect(masterBus);
      } else {
        mainGain.connect(masterBus);
      }

      liveTrackNodesRef.current.set('main-track', { eq: mainEq, gain: mainGain, panner: mainPanner });
      realtimeNoiseGateRef.current = noiseGate;
      realtimeAutoTuneRef.current = autoTune;
      realtimeDynamicsRef.current = dynamics;

      const offset = Math.max(0, Math.min(duration - 0.02, startSec ?? currentTime));

      // Schedule Main Track playback
      if (offset < activeBuffer.duration) {
        if (loopPreview && playDurSec === undefined) {
          src.loop = true;
          src.loopStart = offset;
          src.loopEnd = Math.min(activeBuffer.duration, offset + 5.0);
          src.start(0, offset);
        } else if (playDurSec !== undefined) {
          src.start(0, offset, playDurSec);
        } else {
          src.start(0, offset);
        }
      }

      // Schedule Overlaid AudioBuffer Tracks synchronized with playhead & live 3-Band EQ / Gain / Pan / Solo / Mute
      const spawnedOverlays: AudioBufferSourceNode[] = [];
      if (!compareOriginal && playDurSec === undefined) {
        for (const ov of overlayTracks) {
          const ovEnd = ov.offsetSec + ov.buffer.duration;
          if (offset >= ovEnd) continue;

          const ovSrc = ctx.createBufferSource();
          ovSrc.buffer = ov.buffer;
          ovSrc.playbackRate.value = playbackRate;

          const ovRoute = routingMap[ov.id];
          const ovEq = audioBackend.createTrackEqualizer(ctx, ov.eq ?? DEFAULT_TRACK_EQ);
          const ovGain = ctx.createGain();
          ovGain.gain.setValueAtTime(ovRoute?.effectiveGain ?? ov.gain, ctx.currentTime);
          const ovPanner =
            typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
          ovSrc.connect(ovEq.input);
          ovEq.output.connect(ovGain);
          if (ovPanner) {
            ovPanner.pan.setValueAtTime(ovRoute?.pan ?? ov.pan, ctx.currentTime);
            ovGain.connect(ovPanner);
            ovPanner.connect(masterBus);
          } else {
            ovGain.connect(masterBus);
          }

          liveTrackNodesRef.current.set(ov.id, { eq: ovEq, gain: ovGain, panner: ovPanner });

          if (offset < ov.offsetSec) {
            const delaySec = (ov.offsetSec - offset) / playbackRate;
            ovSrc.start(ctx.currentTime + delaySec, 0);
          } else {
            const bufferOffset = offset - ov.offsetSec;
            ovSrc.start(0, bufferOffset);
          }
          spawnedOverlays.push(ovSrc);
        }
      }
      overlaySourcesRef.current = spawnedOverlays;

      sourceNodeRef.current = src;
      playStartCtxTimeRef.current = ctx.currentTime;
      playStartOffsetRef.current = offset;
      setIsPlaying(true);

      src.onended = () => {
        if (!src.loop && overlayTracks.length === 0) {
          stopPlayback();
          if (playDurSec === undefined) {
            setCurrentTime(0);
          }
        }
      };

      const updatePlayhead = () => {
        if (!sourceNodeRef.current) return;
        const elapsed = (ctx.currentTime - playStartCtxTimeRef.current) * playbackRate;
        let nextTime = playStartOffsetRef.current + elapsed;
        if (src.loop && src.loopEnd > src.loopStart) {
          const span = src.loopEnd - src.loopStart;
          nextTime = src.loopStart + (elapsed % span);
        }
        if (nextTime >= duration && !src.loop) {
          stopPlayback();
          setCurrentTime(0);
          return;
        }
        setCurrentTime(Math.min(duration, nextTime));
        playRafRef.current = requestAnimationFrame(updatePlayhead);
      };
      playRafRef.current = requestAnimationFrame(updatePlayhead);
    },
    [
      activeBuffer,
      compareOriginal,
      currentTime,
      duration,
      effects.autoTune,
      effects.autoTuneKey,
      effects.autoTuneScale,
      effects.autoTuneStrength,
      effects.dynamicsMakeupDb,
      effects.dynamicsProcessor,
      effects.dynamicsRatio,
      effects.dynamicsThresholdDb,
      effects.limiterCeilingDb,
      effects.noiseGate,
      effects.noiseGateDb,
      loopPreview,
      mainTrackControl.eq,
      mainTrackControl.gain,
      mainTrackControl.muted,
      mainTrackControl.pan,
      mainTrackControl.solo,
      overlayTracks,
      playbackRate,
      stopPlayback,
    ]
  );

  // Live-update Real-Time Noise Gate settings mid-playback without interrupting audio
  useEffect(() => {
    if (!realtimeNoiseGateRef.current) return;
    realtimeNoiseGateRef.current.updateOptions({
      enabled: !compareOriginal && effects.noiseGate,
      thresholdDb: effects.noiseGateDb,
    });
  }, [compareOriginal, effects.noiseGate, effects.noiseGateDb]);

  // Live-update Real-Time FFT Auto-Tune settings mid-playback without interrupting audio
  useEffect(() => {
    if (!realtimeAutoTuneRef.current) return;
    realtimeAutoTuneRef.current.updateOptions({
      enabled: !compareOriginal && effects.autoTune,
      key: effects.autoTuneKey,
      scale: effects.autoTuneScale,
      strength: effects.autoTuneStrength,
    });
  }, [
    compareOriginal,
    effects.autoTune,
    effects.autoTuneKey,
    effects.autoTuneScale,
    effects.autoTuneStrength,
  ]);

  // Live-update Main Track Dynamics Processor (Compressor / Brickwall Limiter) mid-playback
  useEffect(() => {
    if (!realtimeDynamicsRef.current) return;
    realtimeDynamicsRef.current.updateOptions({
      enabled: !compareOriginal && effects.dynamicsProcessor,
      thresholdDb: effects.dynamicsThresholdDb,
      ratio: effects.dynamicsRatio,
      makeupGainDb: effects.dynamicsMakeupDb,
      limiterCeilingDb: effects.limiterCeilingDb,
    });
  }, [
    compareOriginal,
    effects.dynamicsMakeupDb,
    effects.dynamicsProcessor,
    effects.dynamicsRatio,
    effects.dynamicsThresholdDb,
    effects.limiterCeilingDb,
  ]);

  // Poll Real-Time FFT Auto-Tune tuner & Dynamics Gain Reduction telemetry at ~10Hz during playback
  useEffect(() => {
    if (!isPlaying) {
      setAutoTuneTelemetry(null);
      setDynamicsTelemetry(null);
      return;
    }
    const id = window.setInterval(() => {
      if (realtimeAutoTuneRef.current) {
        setAutoTuneTelemetry(realtimeAutoTuneRef.current.getState());
      }
      if (realtimeDynamicsRef.current) {
        setDynamicsTelemetry(realtimeDynamicsRef.current.getState());
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [isPlaying]);

  // Live-update Multi-Track 3-Band EQ, Gain, Panning, and Solo/Mute nodes mid-playback without interrupting audio
  useEffect(() => {
    if (!isPlaying || liveTrackNodesRef.current.size === 0) return;
    const ctx = audioBackend.getAudioContext();
    const now = ctx.currentTime;
    const routingMap = computeTrackPlaybackParams([
      {
        id: 'main-track',
        gain: compareOriginal ? 1.0 : mainTrackControl.gain,
        pan: compareOriginal ? 0 : mainTrackControl.pan,
        muted: compareOriginal ? false : mainTrackControl.muted,
        solo: compareOriginal ? false : mainTrackControl.solo,
      },
      ...overlayTracks.map((t) => ({
        id: t.id,
        gain: t.gain,
        pan: t.pan,
        muted: t.muted,
        solo: t.solo,
      })),
    ]);
    for (const [id, nodePair] of liveTrackNodesRef.current.entries()) {
      const p = routingMap[id];
      if (!p) continue;
      nodePair.gain.gain.setTargetAtTime(p.effectiveGain, now, 0.015);
      if (nodePair.panner) {
        nodePair.panner.pan.setTargetAtTime(p.pan, now, 0.015);
      }
      if (id === 'main-track') {
        nodePair.eq.updateEq(
          compareOriginal ? { ...DEFAULT_TRACK_EQ, enabled: false } : mainTrackControl.eq
        );
      } else {
        const ov = overlayTracks.find((t) => t.id === id);
        if (ov) {
          nodePair.eq.updateEq(ov.eq ?? DEFAULT_TRACK_EQ);
        }
      }
    }
  }, [compareOriginal, isPlaying, mainTrackControl, overlayTracks]);

  const togglePlay = useCallback(() => {
    if (isPlaying) stopPlayback();
    else startPlayback(currentTime >= duration - 0.05 ? 0 : currentTime);
  }, [currentTime, duration, isPlaying, startPlayback, stopPlayback]);

  useEffect(() => {
    registerPlayShortcut?.(togglePlay);
  }, [registerPlayShortcut, togglePlay]);

  useEffect(() => () => stopPlayback(), [stopPlayback]);

  // Reset playhead if buffer changes drastically
  useEffect(() => {
    stopPlayback();
    if (currentTime > duration) setCurrentTime(0);
  }, [activeBuffer, duration, stopPlayback]);

  // =========================================================================
  // SMART CLEANUP HANDLERS
  // =========================================================================

  const handleShrinkPauses = () => {
    if (!currentBuffer || silences.length === 0) {
      onNotify('No long pauses detected with current settings.', 'info');
      return;
    }
    stopPlayback();
    const { channels, savedSec } = removeSilencesPCM(
      extractChannels(currentBuffer),
      currentBuffer.sampleRate,
      silences,
      keepPaddingSec,
      15
    );
    const next = createAudioBufferFromChannels(
      audioBackend.getAudioContext(),
      channels,
      currentBuffer.sampleRate
    );
    onCommitBuffer(next, `Shrunk ${silences.length} pauses (-${savedSec.toFixed(1)}s)`);
    onDismissWhatNext();
    setCompareOriginal(false);
    onNotify(`Shrunk ${silences.length} pauses and saved ${savedSec.toFixed(1)} seconds!`, 'success');
  };

  const handleRemoveRepetition = (rep: RepetitionRegion) => {
    if (!currentBuffer) return;
    stopPlayback();
    const cutChannels = cutRangePCM(
      extractChannels(currentBuffer),
      currentBuffer.sampleRate,
      rep.start,
      rep.end,
      15
    );
    const next = createAudioBufferFromChannels(
      audioBackend.getAudioContext(),
      cutChannels,
      currentBuffer.sampleRate
    );
    if (rep.source === 'oops') {
      onChangeOopsMarkers(oopsMarkers.filter((o) => `oops-reg-${o.id}` !== rep.id));
    }
    onCommitBuffer(next, `Removed ${rep.label}`);
    onNotify(`Removed ${rep.label}.`, 'success');
  };

  const handleRemoveAllRepetitions = () => {
    if (!currentBuffer || repetitions.length === 0) return;
    stopPlayback();
    // Sort descending so earlier timestamps remain accurate while cutting
    const sorted = [...repetitions].sort((a, b) => b.start - a.start);
    let chs = extractChannels(currentBuffer);
    for (const r of sorted) {
      chs = cutRangePCM(chs, currentBuffer.sampleRate, r.start, r.end, 15);
    }
    const next = createAudioBufferFromChannels(
      audioBackend.getAudioContext(),
      chs,
      currentBuffer.sampleRate
    );
    onChangeOopsMarkers([]);
    onCommitBuffer(next, `Removed ${sorted.length} repeated takes`);
    onNotify(`Cleaned ${sorted.length} repeated take(s)!`, 'success');
  };

  const handleCutSelection = () => {
    if (!currentBuffer || !selection) return;
    stopPlayback();
    const chs = cutRangePCM(
      extractChannels(currentBuffer),
      currentBuffer.sampleRate,
      selection.start,
      selection.end,
      15
    );
    const next = createAudioBufferFromChannels(
      audioBackend.getAudioContext(),
      chs,
      currentBuffer.sampleRate
    );
    setSelection(null);
    onCommitBuffer(next, 'Cut selection');
    onNotify('Cut selected region smoothly.', 'success');
  };

  const handleTrimToSelection = () => {
    if (!currentBuffer || !selection) return;
    stopPlayback();
    const chs = trimRangePCM(
      extractChannels(currentBuffer),
      currentBuffer.sampleRate,
      selection.start,
      selection.end
    );
    const next = createAudioBufferFromChannels(
      audioBackend.getAudioContext(),
      chs,
      currentBuffer.sampleRate
    );
    setSelection(null);
    onCommitBuffer(next, 'Trimmed to selection');
    onNotify('Trimmed recording to selected region.', 'success');
  };

  // Punch-In Re-Record at Playhead
  const handleTogglePunchIn = async () => {
    if (!currentBuffer) return;
    if (!punchInRecording) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const rec = new MediaRecorder(stream);
        punchChunksRef.current = [];
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) punchChunksRef.current.push(e.data);
        };
        rec.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          try {
            const blob = new Blob(punchChunksRef.current, { type: rec.mimeType || 'audio/webm' });
            const insertBuf = await audioBackend.decodeAudioData(await blob.arrayBuffer());
            const sr = currentBuffer.sampleRate;
            const splitIdx = Math.floor(currentTime * sr);
            const curCh = extractChannels(currentBuffer);
            const insMono = mixToMono(extractChannels(insertBuf));
            const fade = Math.floor(sr * 0.015);
            const merged = curCh.map((ch) =>
              spliceSegmentsWithCrossfade([ch.subarray(0, splitIdx), insMono, ch.subarray(splitIdx)], fade)
            );
            const next = createAudioBufferFromChannels(audioBackend.getAudioContext(), merged, sr);
            onCommitBuffer(next, `Punch-in recorded at ${formatDuration(currentTime, true)}`);
            onNotify('Inserted punch-in recording at playhead!', 'success');
          } catch {
            onNotify('Could not decode punch-in clip.', 'error');
          }
        };
        punchRecorderRef.current = rec;
        rec.start();
        setPunchInRecording(true);
        onNotify(`Punch-in recording at ${formatDuration(currentTime, true)}... click again to insert.`, 'info');
      } catch {
        onNotify('Microphone permission needed for Punch-In Re-Record.', 'warning');
      }
    } else {
      punchRecorderRef.current?.stop();
      setPunchInRecording(false);
    }
  };

  // Merge / Stitch Library Recording
  const handleStitchRecording = async () => {
    if (!currentBuffer || !stitchId) return;
    const item = libraryRecordings.find((r) => r.id === stitchId);
    if (!item) return;
    setIsProcessing(true);
    try {
      const otherBuf = await audioBackend.decodeAudioData(await item.blob.arrayBuffer());
      const sr = currentBuffer.sampleRate;
      const curCh = extractChannels(currentBuffer);
      const otherMono = mixToMono(extractChannels(otherBuf));
      const fade = Math.floor(sr * 0.02);
      const merged = curCh.map((ch) => spliceSegmentsWithCrossfade([ch, otherMono], fade));
      const next = createAudioBufferFromChannels(audioBackend.getAudioContext(), merged, sr);
      onCommitBuffer(next, `Stitched "${item.title}"`);
      setStitchId('');
      onNotify(`Stitched "${item.title}" onto the end of your track!`, 'success');
    } catch {
      onNotify('Failed to stitch recording.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  // Export Bookmarks as Separate Clips
  const handleExportBookmarkClips = () => {
    if (!currentBuffer || bookmarks.length === 0) {
      onNotify('Add at least one bookmark to split into separate clips.', 'info');
      return;
    }
    const sorted = [...bookmarks].sort((a, b) => a.time - b.time);
    const chs = extractChannels(currentBuffer);
    sorted.forEach((bm, idx) => {
      const start = bm.time;
      const end = idx < sorted.length - 1 ? sorted[idx + 1].time : currentBuffer.duration;
      if (end - start < 0.2) return;
      const trimmed = trimRangePCM(chs, currentBuffer.sampleRate, start, end);
      const wav = encodeWavPCM(trimmed, currentBuffer.sampleRate);
      const copy = new Uint8Array(wav.byteLength);
      copy.set(wav);
      const blob = new Blob([copy], { type: 'audio/wav' });
      void saveBlobToDevice(
        blob,
        `${title.replace(/\s+/g, '_')}_${idx + 1}_${bm.label.replace(/\s+/g, '_')}.wav`
      );
    });
    onNotify(`Downloaded ${sorted.length} chapter clips!`, 'success');
  };

  // Highlight Reel Builder (stitches starred bookmark segments into one highlight clip)
  const handleBuildHighlightReel = () => {
    if (!currentBuffer) return;
    const sorted = [...bookmarks].sort((a, b) => a.time - b.time);
    const starredIdx = sorted.map((b, i) => (b.starred ? i : -1)).filter((i) => i >= 0);
    if (starredIdx.length === 0) {
      onNotify('Star at least one bookmark below to build a Highlight Reel.', 'info');
      return;
    }
    const chs = extractChannels(currentBuffer);
    const fade = Math.floor(currentBuffer.sampleRate * 0.025);
    const nextChannels = chs.map((ch) => {
      const pieces = starredIdx.map((idx) => {
        const start = Math.floor(sorted[idx].time * currentBuffer.sampleRate);
        const endSec = idx < sorted.length - 1 ? sorted[idx + 1].time : currentBuffer.duration;
        const end = Math.min(ch.length, Math.floor(endSec * currentBuffer.sampleRate));
        return ch.subarray(start, Math.max(start + 1, end));
      });
      return spliceSegmentsWithCrossfade(pieces, fade);
    });
    const reelBuf = createAudioBufferFromChannels(
      audioBackend.getAudioContext(),
      nextChannels,
      currentBuffer.sampleRate
    );
    onCommitBuffer(reelBuf, `Built Highlight Reel (${starredIdx.length} clips)`);
    onNotify(`Highlight Reel stitched from ${starredIdx.length} starred moments!`, 'success');
  };

  // =========================================================================
  // MULTI-TRACK OVERLAY MANAGER HANDLERS
  // =========================================================================

  const handleUpdateOverlayTrack = (id: string, patch: Partial<OverlayTrack>) => {
    onChangeOverlayTracks(overlayTracks.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const handleRemoveOverlayTrack = (id: string) => {
    stopPlayback();
    onChangeOverlayTracks(overlayTracks.filter((t) => t.id !== id));
    onNotify('Removed overlay track.', 'info');
  };

  const handleUploadOverlayFile = async (file: File) => {
    try {
      const decoded = await audioBackend.decodeAudioData(await file.arrayBuffer());
      const color = TRACK_COLORS[overlayTracks.length % TRACK_COLORS.length];
      const nextTrack: OverlayTrack = {
        id: `ov-${Date.now()}`,
        name: file.name.replace(/\.[^.]+$/, ''),
        buffer: decoded,
        gain: 0.85,
        pan: 0,
        muted: false,
        solo: false,
        offsetSec: Number(currentTime.toFixed(1)),
        color,
        eq: { ...DEFAULT_TRACK_EQ },
      };
      onChangeOverlayTracks([...overlayTracks, nextTrack]);
      onNotify(
        `Overlaid "${nextTrack.name}" at ${formatDuration(nextTrack.offsetSec, true)}.`,
        'success'
      );
    } catch {
      onNotify('Could not decode uploaded audio track.', 'error');
    }
  };

  const handleAddStarterOverlay = (packItemId: string) => {
    const item = STARTER_SOUND_PACK.find((i) => i.id === packItemId);
    if (!item) return;
    const buf = synthesizeStarterSound(audioBackend.getAudioContext(), packItemId);
    const color = TRACK_COLORS[overlayTracks.length % TRACK_COLORS.length];
    const nextTrack: OverlayTrack = {
      id: `ov-${Date.now()}`,
      name: item.name,
      buffer: buf,
      gain: item.category === 'music' ? 0.35 : 0.85,
      pan: 0,
      muted: false,
      solo: false,
      offsetSec: item.category === 'music' ? 0 : Number(currentTime.toFixed(1)),
      color,
      eq: { ...DEFAULT_TRACK_EQ },
    };
    onChangeOverlayTracks([...overlayTracks, nextTrack]);
    onNotify(`Added "${item.name}" to Track Manager.`, 'success');
  };

  const handleDuplicateMainTrack = () => {
    if (!currentBuffer) return;
    const color = TRACK_COLORS[overlayTracks.length % TRACK_COLORS.length];
    const nextTrack: OverlayTrack = {
      id: `ov-dup-${Date.now()}`,
      name: `${title} (Layer ${overlayTracks.length + 2})`,
      buffer: currentBuffer,
      gain: 0.75,
      pan: overlayTracks.length % 2 === 0 ? 0.35 : -0.35,
      muted: false,
      solo: false,
      offsetSec: 0,
      color,
      eq: { ...DEFAULT_TRACK_EQ },
    };
    onChangeOverlayTracks([...overlayTracks, nextTrack]);
    onNotify(
      `Duplicated vocal track into stereo layer (${nextTrack.pan > 0 ? 'R35' : 'L35'}).`,
      'info'
    );
  };

  const handleAddLibraryOverlay = async (recordingId: string) => {
    const item = libraryRecordings.find((r) => r.id === recordingId);
    if (!item) return;
    try {
      const buf = await audioBackend.decodeAudioData(await item.blob.arrayBuffer());
      const color = TRACK_COLORS[overlayTracks.length % TRACK_COLORS.length];
      const nextTrack: OverlayTrack = {
        id: `ov-lib-${Date.now()}`,
        name: item.title,
        buffer: buf,
        gain: 0.85,
        pan: 0,
        muted: false,
        solo: false,
        offsetSec: 0,
        color,
        eq: { ...DEFAULT_TRACK_EQ },
      };
      onChangeOverlayTracks([...overlayTracks, nextTrack]);
      onNotify(`Overlaid "${item.title}" from Library.`, 'success');
    } catch {
      onNotify('Could not load library track for overlay.', 'error');
    }
  };

  const handleBounceMultiTrack = async () => {
    if (!currentBuffer || overlayTracks.length === 0) return;
    stopPlayback();
    setIsProcessing(true);
    try {
      const allTracks: OverlayTrack[] = [
        {
          id: 'main-track',
          name: title,
          buffer: currentBuffer,
          gain: mainTrackControl.gain,
          pan: mainTrackControl.pan,
          muted: mainTrackControl.muted,
          solo: mainTrackControl.solo,
          offsetSec: 0,
          color: '#3b82f6',
          eq: mainTrackControl.eq,
          isMain: true,
        },
        ...overlayTracks,
      ];
      const bounced = await audioBackend.renderMultiTrack(allTracks);
      onCommitBuffer(bounced, `Bounced ${allTracks.length}-track stereo mixdown`);
      onChangeOverlayTracks([]);
      onChangeMainTrackControl({
        gain: 1.0,
        pan: 0,
        muted: false,
        solo: false,
        eq: { ...DEFAULT_TRACK_EQ },
      });
      onNotify(`Bounced ${allTracks.length} tracks into your main stereo master!`, 'success');
    } catch {
      onNotify('Failed to bounce multi-track mixdown.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  // =========================================================================
  // STUDIO VOICE EFFECTS HANDLERS
  // =========================================================================

  const applyEffectsToTrack = async (customEffects?: EffectSettings, label?: string) => {
    if (!currentBuffer) return;
    stopPlayback();
    setIsProcessing(true);
    try {
      const fx = customEffects ?? effects;
      const rendered = await audioBackend.renderEffects(currentBuffer, fx);
      onCommitBuffer(rendered, label ?? 'Applied Studio Voice Effects');
      onDismissWhatNext();
      setCompareOriginal(false);
      onNotify(label ? `${label} applied!` : 'Studio voice effects applied!', 'success');
    } catch {
      onNotify('Could not render effects.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleQuickPolish = async () => {
    const nextFx: EffectSettings = {
      ...effects,
      studioPolish: true,
      cleanNoise: true,
      autoLevel: true,
    };
    onChangeEffects(nextFx);
    await applyEffectsToTrack(nextFx, 'Studio Voice Polish');
  };

  // =========================================================================
  // SPECTRAL SUBTRACTION NOISE REDUCTION HANDLERS
  // =========================================================================

  const handleCaptureNoiseProfile = (useSelection: boolean) => {
    if (!currentBuffer) return;
    const range =
      useSelection && selection && selection.end - selection.start >= 0.08
        ? { startSec: selection.start, endSec: selection.end }
        : undefined;
    const profile = audioBackend.captureNoiseProfile(currentBuffer, range);
    setNoiseProfile(profile);
    onNotify(
      `Captured noise floor profile (${profile.noiseFloorDb.toFixed(1)} dB${
        profile.dominantHumHz ? `, ~${profile.dominantHumHz} Hz hum detected` : ''
      }).`,
      'info'
    );
  };

  const handleApplySpectralDenoise = () => {
    if (!currentBuffer) return;
    stopPlayback();
    setIsProcessing(true);
    try {
      const activeProfile = noiseProfile ?? audioBackend.captureNoiseProfile(currentBuffer);
      if (!noiseProfile) setNoiseProfile(activeProfile);
      const { buffer: cleaned, noiseReducedDb } = audioBackend.applySpectralNoiseReduction(
        currentBuffer,
        activeProfile,
        {
          reductionStrength: denoiseStrength,
          vocalProtection: denoiseVocalProtect,
          spectralFloorDb: denoiseFloorDb,
        }
      );
      onCommitBuffer(cleaned, 'Applied Spectral Subtraction Noise Reduction');
      onDismissWhatNext();
      setCompareOriginal(false);
      onNotify(
        `Spectral subtraction removed hiss/hum (-${noiseReducedDb.toFixed(1)} dB floor reduction) while preserving vocal clarity!`,
        'success'
      );
    } catch {
      onNotify('Could not apply spectral noise reduction.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  // =========================================================================
  // MASTERING ASSISTANT ("PRO MASTER") HANDLER
  // =========================================================================

  const handleApplyProMaster = async (
    plan: MasteringPlan
  ): Promise<{ afterAnalysis: MasteringAnalysis; maxReductionDb: number } | null> => {
    if (!currentBuffer) return null;
    stopPlayback();
    setIsProcessing(true);
    try {
      const { buffer: mastered, afterAnalysis, maxReductionDb } =
        await audioBackend.applyProMaster(currentBuffer, plan);
      onCommitBuffer(
        mastered,
        `Pro Master (${plan.targetLufs} LUFS, ceiling ${plan.limiter.ceilingDb} dBTP)`
      );
      onDismissWhatNext();
      setCompareOriginal(false);
      onNotify(
        `Pro Master applied! Loudness ${afterAnalysis.integratedLufs.toFixed(1)} LUFS · Peak ${afterAnalysis.peakDb.toFixed(1)} dBFS (zero clipping).`,
        'success'
      );
      return { afterAnalysis, maxReductionDb };
    } catch {
      onNotify('Could not apply Pro Master chain.', 'error');
      return null;
    } finally {
      setIsProcessing(false);
    }
  };

  // =========================================================================
  // RULE-BASED SOUND ISOLATOR, STEADY VOICE NORMALIZER & REGION TRANSFORM
  // =========================================================================

  const handleApplySoundBalance = (
    settings: SoundBalanceSettings,
    scope: 'full' | 'selection'
  ) => {
    if (!currentBuffer) return;
    stopPlayback();
    setIsProcessing(true);
    try {
      const range =
        scope === 'selection' && selection && selection.end - selection.start >= 0.1
          ? { startSec: selection.start, endSec: selection.end }
          : undefined;
      const updated = audioBackend.rebalanceSoundElements(currentBuffer, settings, range);
      onCommitBuffer(
        updated,
        range ? 'Adjusted individual sounds in selection' : 'Adjusted individual sounds'
      );
      onDismissWhatNext();
      setCompareOriginal(false);
      onNotify(
        range
          ? 'Updated individual sound levels in your selected part! Press Ctrl+Z anytime to undo.'
          : 'Updated individual sound levels across your recording! Press Ctrl+Z anytime to undo.',
        'success'
      );
    } catch {
      onNotify('Could not adjust sound elements.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleApplySteadyNormalize = (
    options: SteadyNormalizeOptions
  ): SteadyNormalizeStats | null => {
    if (!currentBuffer) return null;
    stopPlayback();
    setIsProcessing(true);
    try {
      const { buffer: leveled, stats } = audioBackend.normalizeSteadyVolume(
        currentBuffer,
        options
      );
      onCommitBuffer(
        leveled,
        options.mode === 'peak' ? 'Peak Normalized Volume' : 'Steady Voice Volume Normalized'
      );
      onDismissWhatNext();
      setCompareOriginal(false);
      onNotify(
        `Volume is now steady! Swing reduced from ${stats.beforeRangeDb.toFixed(1)} dB to ${stats.afterRangeDb.toFixed(1)} dB.`,
        'success'
      );
      return stats;
    } catch {
      onNotify('Could not normalize volume.', 'error');
      return null;
    } finally {
      setIsProcessing(false);
    }
  };

  const handleApplyRegionTransform = (options: RegionTransformOptions) => {
    if (!currentBuffer) return;
    stopPlayback();
    setIsProcessing(true);
    try {
      const updated = audioBackend.transformAudioRegion(currentBuffer, options);
      const hasSel = options.startSec !== undefined && options.endSec !== undefined;
      onCommitBuffer(
        updated,
        hasSel ? 'Transformed pitch/speed/volume on selection' : 'Transformed pitch/speed/volume'
      );
      onDismissWhatNext();
      setCompareOriginal(false);
      onNotify(
        hasSel
          ? 'Updated pitch, speed, and volume on your selected part cleanly!'
          : 'Updated pitch, speed, and volume across your recording cleanly!',
        'success'
      );
    } catch {
      onNotify('Could not transform audio.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  // =========================================================================
  // 3-LANE CREATOR MIXER HANDLERS
  // =========================================================================

  const handleSelectStarterMusic = (itemId: string) => {
    const item = STARTER_SOUND_PACK.find((i) => i.id === itemId);
    if (!item) return;
    const buf = synthesizeStarterSound(audioBackend.getAudioContext(), itemId);
    onChangeMixer({
      ...mixer,
      musicTrackId: itemId,
      musicTrackName: item.name,
      musicBuffer: buf,
      musicMuted: false,
    });
    onNotify(`Loaded "${item.name}" into Background Music lane.`, 'info');
  };

  const handleUploadMusicFile = async (file: File) => {
    try {
      const buf = await audioBackend.decodeAudioData(await file.arrayBuffer());
      onChangeMixer({
        ...mixer,
        musicTrackId: `custom-${Date.now()}`,
        musicTrackName: file.name,
        musicBuffer: buf,
        musicMuted: false,
      });
      onNotify(`Added "${file.name}" to Background Music lane.`, 'success');
    } catch {
      onNotify('Could not decode music track.', 'error');
    }
  };

  const handlePlaceSfxAtPlayhead = (itemId: string) => {
    const item = STARTER_SOUND_PACK.find((i) => i.id === itemId);
    if (!item) return;
    const buf = synthesizeStarterSound(audioBackend.getAudioContext(), itemId);
    onChangeMixer({
      ...mixer,
      sfxPlacements: [
        ...mixer.sfxPlacements,
        {
          id: `sfx-${Date.now()}`,
          packItemId: itemId,
          name: item.name,
          time: Number(currentTime.toFixed(2)),
          volume: 0.85,
          buffer: buf,
        },
      ],
    });
    onNotify(`Placed "${item.name}" at ${formatDuration(currentTime, true)}.`, 'info');
  };

  const handleRenderMixer = async () => {
    if (!currentBuffer) return;
    stopPlayback();
    setIsProcessing(true);
    try {
      const mixed = await audioBackend.renderMix(currentBuffer, mixer);
      onCommitBuffer(mixed, 'Rendered 3-Lane Creator Mix');
      onNotify('3-Lane Mix rendered with Auto-Ducking!', 'success');
    } catch {
      onNotify('Failed to render 3-lane mix.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };


  // =========================================================================
  // RULE-BASED SPECTRAL REPAIR (DE-CLICK, DE-REVERB, BOX ERASER) & AUTOMATION
  // =========================================================================

  const handleRepairClicks = (opts: DeClickOptions) => {
    if (!currentBuffer) return;
    stopPlayback();
    setIsProcessing(true);
    try {
      const res = audioBackend.repairClicksAndPlosives(currentBuffer, opts);
      onCommitBuffer(res.buffer, 'Repaired Clicks & Mic Pops');
      onNotify(
        `Repaired ${res.clicksRepaired} clicks and softened ${res.plosivesTamed} mic pops!`,
        'success'
      );
    } catch {
      onNotify('Could not run click & pop repair.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReduceReverb = (opts: DeReverbOptions) => {
    if (!currentBuffer) return;
    stopPlayback();
    setIsProcessing(true);
    try {
      const res = audioBackend.reduceRoomReverb(currentBuffer, opts);
      onCommitBuffer(res.buffer, 'Reduced Room Echo');
      onNotify(
        `Reduced room echo smoothly (${res.echoReducedDb.toFixed(1)} dB tail trimmed).`,
        'success'
      );
    } catch {
      onNotify('Could not run room echo reducer.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleEraseSpectralBox = (box: SpectralBoxSelection) => {
    if (!currentBuffer) return;
    stopPlayback();
    setIsProcessing(true);
    try {
      const next = audioBackend.eraseSpectralBox(currentBuffer, box);
      onCommitBuffer(next, 'Erased Selected Sound');
      onNotify(
        `Erased sound in ${box.minHz}–${box.maxHz} Hz cleanly! Press Ctrl+Z anytime to undo.`,
        'success'
      );
    } catch {
      onNotify('Could not erase the selected spectrogram region.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleApplyAutomation = (opts: AutomationCurveOptions) => {
    if (!currentBuffer) return;
    stopPlayback();
    setIsProcessing(true);
    try {
      const next = audioBackend.applyAutomationCurve(currentBuffer, opts);
      onCommitBuffer(next, 'Applied Volume/Pan Automation');
      onNotify('Applied smooth volume & pan automation curve to your track!', 'success');
    } catch {
      onNotify('Could not apply automation curve.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSimpleCleanAll = async () => {
    if (!currentBuffer) return;
    stopPlayback();
    setIsProcessing(true);
    try {
      // 1-click novice cleaner: repair mouth clicks/pops -> reduce room echo -> gentle noise cleanup
      const clickRes = audioBackend.repairClicksAndPlosives(currentBuffer, {
        sensitivity: 60,
        removePlosives: true,
        plosiveStrength: 65,
      });
      const reverbRes = audioBackend.reduceRoomReverb(clickRes.buffer, {
        strength: 45,
        decaySec: 0.25,
      });
      const cleaned = await audioBackend.renderEffects(reverbRes.buffer, {
        ...effects,
        cleanNoise: true,
        studioPolish: true,
        wetDry: 70,
      });
      onCommitBuffer(cleaned, 'Cleaned Noise, Clicks & Echo');
      onNotify('Cleaned background noise, clicks, and room echo! Press Ctrl+Z anytime to undo.', 'success');
    } catch {
      onNotify('Could not finish noise cleanup.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  // =========================================================================
  // TRANSCRIPT EXPORT HANDLERS
  // =========================================================================

  const downloadTextFile = async (content: string, ext: 'txt' | 'srt') => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const res = await saveBlobToDevice(
      blob,
      `${title.replace(/\s+/g, '_') || 'transcript'}.${ext}`
    );
    if (res.saved) {
      onNotify(
        res.location ? `Saved captions to ${res.location}` : `Exported captions as .${ext}`,
        'success'
      );
    }
  };

  const totalFillerWords = useMemo(
    () => transcript.reduce((acc, s) => acc + countFillerWords(s.text), 0),
    [transcript]
  );

  // Empty state if user navigates to Step 2 before recording/loading anything
  if (!currentBuffer) {
    return (
      <div className="mx-auto max-w-2xl rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-10 text-center space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
          <Sliders className="h-6 w-6" />
        </div>
        <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
          No audio loaded in the editor yet
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Record your voice, import an audio or video file, or test all smart cleanup tools immediately with our 15-second sample.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <button
            type="button"
            onClick={onLoadSample}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
          >
            <Sparkles className="h-4 w-4" />
            <span>Try With a 15-Second Sample</span>
          </button>
          <button
            type="button"
            onClick={onGoToRecord}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 px-5 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Mic className="h-4 w-4" />
            <span>Go to Recorder</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* Post-Recording Friendly "What next?" Bar (Pro only; Simple Mode leads cleanly with Easy Fixes) */}
      {showWhatNextBar && userMode === 'pro' && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-blue-500/30 bg-blue-500/8 px-5 py-3.5">
          <div className="flex items-center gap-2.5 text-sm">
            <Sparkles className="h-4.5 w-4.5 text-blue-500 shrink-0" />
            <span className="font-semibold text-slate-900 dark:text-white">What next?</span>
            <span className="text-slate-600 dark:text-slate-300">
              Try a one-click studio action to make this sound crisp:
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={isProcessing}
              onClick={() =>
                handleApplySteadyNormalize({
                  mode: 'steady',
                  targetLufs: -16,
                  ceilingDb: -1.0,
                })
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors"
            >
              <Volume2 className="h-3.5 w-3.5" />
              <span>Make Voice Steady</span>
            </button>
            <button
              type="button"
              disabled={isProcessing}
              onClick={handleQuickPolish}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 transition-colors"
            >
              <Wand2 className="h-3.5 w-3.5" />
              <span>Polish Voice</span>
            </button>
            <button
              type="button"
              disabled={silences.length === 0}
              onClick={handleShrinkPauses}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50"
            >
              <Scissors className="h-3.5 w-3.5" />
              <span>Shrink Pauses ({silences.length})</span>
            </button>
            <button
              type="button"
              onClick={onGoToExport}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export Now</span>
            </button>
          </div>
        </div>
      )}

      {/* Top Project Title + Undo/Redo + Compare Original + Save + Next Step */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <input
            type="text"
            aria-label="Recording title"
            value={title}
            onChange={(e) => onChangeTitle(e.target.value)}
            className="font-display text-lg sm:text-xl font-bold bg-transparent text-slate-900 dark:text-white border-b border-transparent hover:border-slate-300 dark:hover:border-slate-700 focus:border-blue-500 focus:outline-none px-1 py-0.5 max-w-xs sm:max-w-sm truncate"
          />
          <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
            {formatDuration(duration, true)}
            {userMode === 'pro' ? ` · ${Math.round(currentBuffer.sampleRate / 1000)} kHz` : ''}
          </span>
          {importedVideo && (
            <span className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 whitespace-nowrap">
              <Film className="h-3.5 w-3.5" /> Video synced
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Fearless A/B Original vs Edited Toggle */}
          <button
            type="button"
            onClick={() => setCompareOriginal((v) => !v)}
            aria-pressed={compareOriginal}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              compareOriginal
                ? 'border-amber-500 bg-amber-500/15 text-amber-700 dark:text-amber-300'
                : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>
              {compareOriginal
                ? 'Hearing Original'
                : userMode === 'simple'
                ? 'Hear Original'
                : 'Compare: Original vs. Edited'}
            </span>
          </button>

          <button
            type="button"
            disabled={!canUndo}
            onClick={onUndo}
            aria-label="Undo last edit"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40"
          >
            <Undo2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Undo</span>
          </button>

          <button
            type="button"
            disabled={!canRedo}
            onClick={onRedo}
            aria-label="Redo edit"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40"
          >
            <Redo2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Redo</span>
          </button>

          {cfg.editorShowSnapshots && (
            <button
              type="button"
              onClick={() => setShowSnapshots((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <History className="h-3.5 w-3.5" />
              <span>Snapshots ({snapshots.length})</span>
            </button>
          )}

          {userMode === 'pro' && onSaveProjectFile && (
            <button
              type="button"
              onClick={onSaveProjectFile}
              title="Download a portable .swproj project file to your PC"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <FileDown className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>Save .swproj</span>
            </button>
          )}

          <button
            type="button"
            disabled={isSavingLib}
            onClick={async () => {
              setIsSavingLib(true);
              await onSaveToLibrary();
              setIsSavingLib(false);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <Save className="h-3.5 w-3.5 text-blue-500" />
            <span>{isSavingLib ? 'Saving...' : userMode === 'simple' ? 'Save' : 'Save to Library'}</span>
          </button>

          <button
            type="button"
            onClick={onGoToExport}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 whitespace-nowrap"
          >
            <span>{userMode === 'simple' ? 'Next: Save File' : 'Next: Export'}</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Version Snapshots Drawer */}
      {showSnapshots && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Project Version Snapshots — switch safely between edits anytime
            </span>
            <div className="flex items-center gap-2">
              <input
                type="text"
                aria-label="New snapshot name"
                placeholder="e.g. Cleaned Edit, Short Cut..."
                value={snapshotName}
                onChange={(e) => setSnapshotName(e.target.value)}
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-1 text-xs text-slate-900 dark:text-white"
              />
              <button
                type="button"
                onClick={() => {
                  onSaveSnapshot(snapshotName.trim() || `Checkpoint ${snapshots.length}`);
                  setSnapshotName('');
                }}
                className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Save Checkpoint</span>
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {snapshots.map((snap) => (
              <button
                key={snap.id}
                type="button"
                onClick={() => {
                  onRestoreSnapshot(snap.id);
                  setCompareOriginal(false);
                }}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-1.5 text-xs hover:border-blue-500 transition-colors"
              >
                <span className="font-semibold text-slate-800 dark:text-slate-200">{snap.name}</span>
                <span className="font-mono tabular-nums text-slate-500">
                  {formatDuration(snap.duration, true)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Waveform + Transport Deck */}
      <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-4">
        <WaveformCanvas
          buffer={activeBuffer}
          currentTime={currentTime}
          duration={duration}
          selection={selection}
          onSelectRange={setSelection}
          onSeek={(t) => {
            setCurrentTime(t);
            if (isPlaying) startPlayback(t);
          }}
          silences={compareOriginal ? [] : silences}
          repetitions={compareOriginal ? [] : repetitions}
          bookmarks={bookmarks}
          oopsMarkers={oopsMarkers}
          snapToSilence={snapToSilence}
          onToggleSnapToSilence={setSnapToSilence}
          theme={theme}
        />

        {/* Real-Time AnalyserNode Frequency Spectrum Visualizer (controlled by WorkspaceConfig) */}
        {cfg.editorShowSpectrum && (
          <FrequencySpectrumCanvas
            analyser={spectrumAnalyser}
            noiseGateRef={realtimeNoiseGateRef}
            isPlaying={isPlaying}
            theme={theme}
            ecoMode={ecoMode}
            effects={effects}
            onToggleNoiseGate={(enabled) => onChangeEffects({ ...effects, noiseGate: enabled })}
          />
        )}

        {/* Transport Controls Row */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 dark:border-slate-800 pt-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={togglePlay}
              aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
              className="inline-flex items-center gap-2 rounded-full bg-slate-900 dark:bg-white px-5 py-2 text-xs font-bold text-white dark:text-slate-900 hover:opacity-90 transition-opacity"
            >
              {isPlaying ? <Pause className="h-3.5 w-3.5 fill-current" /> : <Play className="h-3.5 w-3.5 fill-current" />}
              <span>{isPlaying ? 'Pause' : 'Play'}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                stopPlayback();
                setCurrentTime(0);
              }}
              aria-label="Stop playback"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Square className="h-3.5 w-3.5" />
            </button>

            <button
              type="button"
              onClick={() => {
                const next = Math.max(0, currentTime - 5);
                setCurrentTime(next);
                if (isPlaying) startPlayback(next);
              }}
              aria-label="Skip back 5 seconds"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <SkipBack className="h-3.5 w-3.5" />
              <span>-5s</span>
            </button>

            <button
              type="button"
              onClick={() => {
                const next = Math.min(duration, currentTime + 5);
                setCurrentTime(next);
                if (isPlaying) startPlayback(next);
              }}
              aria-label="Skip forward 5 seconds"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <span>+5s</span>
              <SkipForward className="h-3.5 w-3.5" />
            </button>

            <span className="ml-1 font-mono text-xs font-semibold tabular-nums text-slate-800 dark:text-slate-200">
              {formatDuration(currentTime, true)} / {formatDuration(duration, true)}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* 5-Second Loop Preview */}
            <button
              type="button"
              onClick={() => setLoopPreview((v) => !v)}
              aria-pressed={loopPreview}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                loopPreview
                  ? 'border-blue-500 bg-blue-500/15 text-blue-600 dark:text-blue-400'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <Repeat className="h-3.5 w-3.5" />
              <span>5s Loop Preview</span>
            </button>

            {/* Playback Speed */}
            <select
              aria-label="Playback speed"
              value={playbackRate}
              onChange={(e) => setPlaybackRate(Number(e.target.value))}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 font-mono text-xs font-semibold text-slate-700 dark:text-slate-200"
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((sp) => (
                <option key={sp} value={sp}>
                  {sp}x
                </option>
              ))}
            </select>

            {/* Quick Cut / Keep Selection buttons */}
            {selection && (
              <>
                <button
                  type="button"
                  onClick={handleCutSelection}
                  className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700"
                >
                  <Scissors className="h-3.5 w-3.5" />
                  <span>Cut Selection</span>
                </button>
                <button
                  type="button"
                  onClick={handleTrimToSelection}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <span>Keep Only Selection</span>
                </button>
              </>
            )}
          </div>
        </div>
      </section>

      {/* Studio Tool Navigation Tabs — dynamically shows ONLY the tabs enabled in Customize Screen */}
      <div
        role="tablist"
        aria-label="Audio editor tools"
        className="flex items-center gap-1 overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-1.5"
      >
        {(
          [
            {
              id: 'cleanup' as const,
              label: userMode === 'simple' ? 'Easy Fixes' : 'Smart Cleanup & Cut',
              icon: userMode === 'simple' ? Sparkles : Scissors,
            },
            {
              id: 'sound' as const,
              label: userMode === 'simple' ? 'Sounds & Pitch' : 'Sound & Pitch Editor',
              icon: Sliders,
            },
            {
              id: 'repair' as const,
              label: 'Audio Repair & Eraser',
              icon: Eraser,
            },
            {
              id: 'tracks' as const,
              label:
                overlayTracks.length > 0
                  ? `Tracks & Automation (${overlayTracks.length + 1})`
                  : 'Tracks & Automation',
              icon: Layers,
            },
            {
              id: 'effects' as const,
              label: 'Studio Voice Effects',
              icon: Wand2,
            },
            {
              id: 'mastering' as const,
              label: 'Mastering Assistant',
              icon: Crown,
            },
            {
              id: 'mixer' as const,
              label: userMode === 'simple' ? 'Add Music' : '3-Lane Creator Mixer',
              icon: Music,
            },
            {
              id: 'transcript' as const,
              label: cfg.enableCloudAiApi ? 'AI Transcript & Notes' : 'Transcript & Captions',
              icon: FileText,
            },
          ] as const
        )
          .filter((tab) => visibleEditorTabIds.includes(tab.id))
          .map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 min-h-[40px] rounded-lg px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <Icon className="h-4 w-4" />
                <span>{tab.label}</span>
              </button>
            );
          })}
      </div>

      {/* TAB: SOUND & PITCH EDITOR (Steady Voice Normalizer + Rule-Based Sound Control + Any-Part Pitch/Speed/Volume) */}
      {activeTab === 'sound' && (
        <SoundControlPanel
          userMode={userMode}
          duration={duration}
          selection={selection}
          onClearSelection={() => setSelection(null)}
          onApplySoundBalance={handleApplySoundBalance}
          onApplySteadyNormalize={handleApplySteadyNormalize}
          onApplyRegionTransform={handleApplyRegionTransform}
          isProcessing={isProcessing}
        />
      )}

      {/* TAB: AUDIO REPAIR & SPECTRAL ERASER (Pro Mode) */}
      {activeTab === 'repair' && (
        <SpectralRepairPanel
          buffer={currentBuffer}
          theme={theme}
          ecoMode={ecoMode}
          isProcessing={isProcessing}
          onRepairClicks={handleRepairClicks}
          onReduceReverb={handleReduceReverb}
          onEraseSpectralBox={handleEraseSpectralBox}
        />
      )}

      {/* TAB 1 (SIMPLE MODE): CALM 4-CARD "EASY FIXES" GRID */}
      {activeTab === 'cleanup' && userMode === 'simple' && (
        <div className="space-y-5" data-testid="simple-easy-fixes">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Easy Fix 1: Steady Voice */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 flex flex-col justify-between gap-4">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Volume2 className="h-4.5 w-4.5 text-emerald-600 dark:text-emerald-400" />
                  <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
                    Make My Voice Steady
                  </h3>
                </div>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Fixes recordings where your voice gets quiet in some parts and loud in others — cleanly and automatically.
                </p>
              </div>
              <button
                type="button"
                disabled={isProcessing}
                onClick={() =>
                  handleApplySteadyNormalize({
                    mode: 'steady',
                    targetLufs: -16,
                    ceilingDb: -1.0,
                  })
                }
                className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
              >
                {isProcessing ? 'Working...' : 'Even Out Volume'}
              </button>
            </div>

            {/* Easy Fix 2: Clean Noise, Clicks & Echo */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 flex flex-col justify-between gap-4">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4.5 w-4.5 text-blue-600 dark:text-blue-400" />
                  <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
                    Clean Background Noise &amp; Echo
                  </h3>
                </div>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Removes room hum, mic pops, mouth clicks, and hollow room echo in one easy click.
                </p>
              </div>
              <button
                type="button"
                data-testid="simple-clean-noise-btn"
                disabled={isProcessing}
                onClick={handleSimpleCleanAll}
                className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {isProcessing ? 'Cleaning...' : 'Clean Noise & Echo'}
              </button>
            </div>

            {/* Easy Fix 3: Trim Long Pauses */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 flex flex-col justify-between gap-4">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Scissors className="h-4.5 w-4.5 text-amber-600 dark:text-amber-400" />
                  <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
                    Shorten Long Pauses
                  </h3>
                </div>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {silences.length > 0
                    ? `We found ${silences.length} long pauses (${timeSavedSec.toFixed(1)}s saved). Keeps natural breathing space.`
                    : 'Your pacing already looks great — no long pauses detected.'}
                </p>
              </div>
              <button
                type="button"
                disabled={silences.length === 0 || isProcessing}
                onClick={handleShrinkPauses}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-4 py-2.5 text-sm font-semibold text-slate-900 dark:text-white hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-45 transition-colors"
              >
                {silences.length > 0 ? `Shorten ${silences.length} Pauses` : 'No Long Pauses'}
              </button>
            </div>

            {/* Easy Fix 4: Reduce Room Echo / Cut Part */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 flex flex-col justify-between gap-4">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Waves className="h-4.5 w-4.5 text-violet-600 dark:text-violet-400" />
                  <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
                    {selection ? 'Edit Selected Part' : 'Fix Mouth Clicks & Mic Pops'}
                  </h3>
                </div>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {selection
                    ? `Selected ${formatDuration(selection.start, true)} to ${formatDuration(selection.end, true)}. Remove it or keep only this section.`
                    : 'Softens sharp "P"/"B" microphone thumps and mouth clicks — or drag across the wave above to cut any mistake.'}
                </p>
              </div>
              {selection ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleCutSelection}
                    className="flex-1 rounded-lg bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-rose-700"
                  >
                    Cut Selected Part
                  </button>
                  <button
                    type="button"
                    onClick={handleTrimToSelection}
                    className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    Keep Only Part
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => handleRepairClicks({ sensitivity: 65, removePlosives: true, plosiveStrength: 70 })}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-4 py-2.5 text-sm font-semibold text-slate-900 dark:text-white hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors"
                >
                  Repair Clicks &amp; Mic Pops
                </button>
              )}
            </div>
          </div>

          {/* Gentle customize & Pro prompt */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/40 px-5 py-3.5 text-xs text-slate-600 dark:text-slate-400">
            <span>
              Want to show or hide specific tools like Visual Sound Eraser, AI Notes, Auto-Tune, or Mastering?
            </span>
            <div className="flex items-center gap-3">
              {onOpenCustomizer && (
                <button
                  type="button"
                  onClick={onOpenCustomizer}
                  className="font-semibold text-slate-800 dark:text-slate-200 hover:text-blue-600 dark:hover:text-blue-400 whitespace-nowrap"
                >
                  Customize Tools
                </button>
              )}
              {onToggleUserMode && (
                <button
                  type="button"
                  onClick={() => onToggleUserMode('pro')}
                  className="font-semibold text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                >
                  Switch to Pro Mode →
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 1 (PRO MODE): SMART CLEANUP & STRUCTURAL EDITS */}
      {activeTab === 'cleanup' && userMode === 'pro' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* 1. Smart Silence Removal & Natural Pacing */}
          <div className="lg:col-span-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                  <span>Smart Silence Removal</span>
                  <Tooltip text="Shrinks awkward pauses down to a natural breath using smooth 15ms crossfades so cuts never click." />
                </h3>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {silences.length > 0
                    ? `Found ${silences.length} pauses — saves ${timeSavedSec.toFixed(1)}s`
                    : 'No long pauses detected'}
                </p>
              </div>
              <button
                type="button"
                disabled={silences.length === 0}
                onClick={handleShrinkPauses}
                className="rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-40 whitespace-nowrap"
              >
                Shrink Pauses
              </button>
            </div>

            {/* 3 Plain-English Presets */}
            <div className="grid grid-cols-3 gap-2">
              {(['gentle', 'normal', 'tight'] as SilencePreset[]).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => handleSelectSilencePreset(preset)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                    silencePreset === preset
                      ? 'border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                      : 'border-slate-200 dark:border-slate-700/80 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <div className="text-xs font-bold">{SILENCE_PRESETS[preset].label}</div>
                  <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2">
                    {preset === 'gentle'
                      ? 'Relaxed pauses'
                      : preset === 'normal'
                      ? 'Natural speech'
                      : 'Fast & punchy'}
                  </div>
                </button>
              ))}
            </div>

            {/* Natural Pacing Breath Slider */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-700 dark:text-slate-300 flex items-center gap-1">
                  <span>Natural Pacing (keep breath)</span>
                  <Tooltip text="Leaves a brief, natural breath pause instead of abruptly gluing words together." />
                </span>
                <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400">
                  {keepPaddingSec.toFixed(2)}s
                </span>
              </div>
              <input
                type="range"
                aria-label="Natural pacing breath duration"
                min={0.05}
                max={0.8}
                step={0.05}
                value={keepPaddingSec}
                onChange={(e) => setKeepPaddingSec(Number(e.target.value))}
                className="w-full"
              />
            </div>

            {/* Pro Mode exact silence threshold sliders */}
            {userMode === 'pro' && (
              <div className="grid grid-cols-2 gap-4 border-t border-slate-100 dark:border-slate-800 pt-3">
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-600 dark:text-slate-400">Threshold</span>
                    <span className="font-mono tabular-nums">{proThresholdDb} dBFS</span>
                  </div>
                  <input
                    type="range"
                    min={-55}
                    max={-20}
                    step={1}
                    value={proThresholdDb}
                    onChange={(e) => setProThresholdDb(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-600 dark:text-slate-400">Min Pause</span>
                    <span className="font-mono tabular-nums">{proMinSilenceSec.toFixed(2)}s</span>
                  </div>
                  <input
                    type="range"
                    min={0.2}
                    max={2.0}
                    step={0.05}
                    value={proMinSilenceSec}
                    onChange={(e) => setProMinSilenceSec(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
              </div>
            )}
          </div>

          {/* 2. Repetition & Retake Removal */}
          <div className="lg:col-span-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                  <span>Repetition & Retake Removal</span>
                  <Tooltip text="Detects repeated sentences and Oops markers so you can cut false starts while keeping your best take." />
                </h3>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {repetitions.length > 0
                    ? `Found ${repetitions.length} repeated take${repetitions.length === 1 ? '' : 's'} highlighted in purple`
                    : 'No repeated takes detected — audio flows cleanly!'}
                </p>
              </div>
              {repetitions.length > 0 && (
                <button
                  type="button"
                  onClick={handleRemoveAllRepetitions}
                  className="rounded-lg bg-purple-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-purple-700 whitespace-nowrap"
                >
                  Remove All ({repetitions.length})
                </button>
              )}
            </div>

            {repetitions.length === 0 ? (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40 px-4 py-6 text-center text-xs text-slate-500 dark:text-slate-400">
                Clean run! No repeated phrases or Oops markers found.
              </div>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {repetitions.map((rep) => (
                  <div
                    key={rep.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 px-3.5 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                        {rep.label}
                      </div>
                      <div className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        {formatDuration(rep.start, true)} – {formatDuration(rep.end, true)} (
                        {(rep.end - rep.start).toFixed(1)}s)
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => startPlayback(rep.start, rep.end - rep.start)}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
                      >
                        <Play className="h-3 w-3" />
                        <span>Listen</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveRepetition(rep)}
                        className="inline-flex items-center gap-1 rounded-md bg-rose-600/15 px-2.5 py-1 text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-600/25"
                      >
                        <Trash2 className="h-3 w-3" />
                        <span>Remove</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 3. Structural Edits: Punch-In, Stitch, Bookmarks & Highlight Reel */}
          <div className="lg:col-span-12 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                Punch-In, Stitch & Chapter Bookmarks
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleTogglePunchIn}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                    punchInRecording
                      ? 'bg-rose-600 text-white'
                      : 'border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <Mic className="h-3.5 w-3.5" />
                  <span>
                    {punchInRecording
                      ? 'Stop & Insert Punch-In'
                      : `Punch-In Re-Record at ${formatDuration(currentTime, true)}`}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    onChangeBookmarks([
                      ...bookmarks,
                      {
                        id: `bm-${Date.now()}`,
                        time: Number(currentTime.toFixed(2)),
                        label: `Chapter ${bookmarks.length + 1}`,
                      },
                    ])
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <Bookmark className="h-3.5 w-3.5 text-emerald-500" />
                  <span>Add Bookmark Here</span>
                </button>

                {libraryRecordings.filter((r) => !r.deletedAt).length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <select
                      aria-label="Choose recording to stitch"
                      value={stitchId}
                      onChange={(e) => setStitchId(e.target.value)}
                      className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                    >
                      <option value="">Stitch from Library...</option>
                      {libraryRecordings
                        .filter((r) => !r.deletedAt)
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.title} ({formatDuration(r.duration)})
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      disabled={!stitchId || isProcessing}
                      onClick={handleStitchRecording}
                      className="rounded-lg bg-slate-900 dark:bg-white px-3 py-1.5 text-xs font-semibold text-white dark:text-slate-900 disabled:opacity-40"
                    >
                      Merge
                    </button>
                  </div>
                )}
              </div>
            </div>

            {bookmarks.length > 0 && (
              <div className="space-y-2.5 border-t border-slate-100 dark:border-slate-800 pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Star your favorite moments to build a Highlight Reel, or export chapters separately:
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleBuildHighlightReel}
                      className="inline-flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-500/20"
                    >
                      <Star className="h-3.5 w-3.5" />
                      <span>Build Highlight Reel</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleExportBookmarkClips}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Export Bookmarks as Clips</span>
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {bookmarks.map((bm) => (
                    <div
                      key={bm.id}
                      className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                    >
                      <button
                        type="button"
                        aria-label={`Star ${bm.label}`}
                        onClick={() =>
                          onChangeBookmarks(
                            bookmarks.map((b) => (b.id === bm.id ? { ...b, starred: !b.starred } : b))
                          )
                        }
                        className={bm.starred ? 'text-amber-500' : 'text-slate-400 hover:text-amber-500'}
                      >
                        <Star className={`h-3.5 w-3.5 ${bm.starred ? 'fill-current' : ''}`} />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCurrentTime(bm.time);
                          startPlayback(bm.time);
                        }}
                        className="font-medium text-slate-800 dark:text-slate-200 hover:underline"
                      >
                        {bm.label}
                      </button>
                      <span className="font-mono tabular-nums text-[11px] text-slate-500">
                        {formatDuration(bm.time, true)}
                      </span>
                      <button
                        type="button"
                        aria-label={`Delete bookmark ${bm.label}`}
                        onClick={() => onChangeBookmarks(bookmarks.filter((b) => b.id !== bm.id))}
                        className="text-slate-400 hover:text-rose-500"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: MULTI-TRACK OVERLAY MANAGER + INTERACTIVE VOLUME & PAN AUTOMATION */}
      {activeTab === 'tracks' && (
        <div className="space-y-6">
          <AutomationLaneCanvas
            buffer={currentBuffer}
            theme={theme}
            ecoMode={ecoMode}
            isProcessing={isProcessing}
            onApplyAutomation={handleApplyAutomation}
          />
          <TrackManagerPanel
            mainTitle={title}
            mainBuffer={currentBuffer}
            mainControl={mainTrackControl}
            onChangeMainControl={onChangeMainTrackControl}
            overlayTracks={overlayTracks}
            onUpdateOverlayTrack={handleUpdateOverlayTrack}
            onRemoveOverlayTrack={handleRemoveOverlayTrack}
            onUploadOverlayFile={handleUploadOverlayFile}
            onAddStarterOverlay={handleAddStarterOverlay}
            onDuplicateMainTrack={handleDuplicateMainTrack}
            onAddLibraryOverlay={handleAddLibraryOverlay}
            onBounceMixdown={handleBounceMultiTrack}
            libraryRecordings={libraryRecordings}
            isProcessing={isProcessing}
            currentTime={currentTime}
          />
        </div>
      )}

      {/* TAB 4: MASTERING ASSISTANT */}
      {activeTab === 'mastering' && (
        <MasteringAssistantPanel
          currentBuffer={currentBuffer}
          isProcessing={isProcessing}
          onApplyProMaster={handleApplyProMaster}
          onGoToExport={onGoToExport}
        />
      )}

      {/* TAB 3: ONE-CLICK STUDIO VOICE EFFECTS */}
      {activeTab === 'effects' && (
        <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-5">
          {/* Top Bar: Speech vs Singing/Music Mode + Wet/Dry Strength + Apply */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-4">
            <div className="flex flex-wrap items-center gap-3">
              <div
                role="group"
                aria-label="Audio profile mode"
                className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 p-0.5"
              >
                <button
                  type="button"
                  onClick={() => onChangeEffects({ ...effects, profile: 'speech' })}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                    effects.profile === 'speech'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Speech Mode
                </button>
                <button
                  type="button"
                  onClick={() => onChangeEffects({ ...effects, profile: 'music' })}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                    effects.profile === 'music'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Singing / Music Mode
                </button>
              </div>

              <div className="flex items-center gap-2.5 text-xs">
                <span className="text-slate-500 dark:text-slate-400">Subtle</span>
                <input
                  type="range"
                  aria-label="Effect strength wet dry mix"
                  min={0}
                  max={100}
                  value={effects.wetDry}
                  onChange={(e) => onChangeEffects({ ...effects, wetDry: Number(e.target.value) })}
                  className="w-32"
                />
                <span className="text-slate-500 dark:text-slate-400">Strong</span>
                <span className="font-mono tabular-nums font-semibold text-slate-800 dark:text-slate-200">
                  {effects.wetDry}%
                </span>
              </div>
            </div>

            <button
              type="button"
              disabled={isProcessing}
              onClick={() => applyEffectsToTrack()}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" />
              <span>{isProcessing ? 'Processing Studio DSP...' : 'Apply Selected Effects'}</span>
            </button>
          </div>

          {/* Real-Time Noise Gate Toggle Control (active live on playback & export) */}
          <div
            className={`rounded-xl border p-4 transition-colors ${
              effects.noiseGate
                ? 'border-emerald-500/60 bg-emerald-500/8'
                : 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <div
                  className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                    effects.noiseGate
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                      : 'bg-slate-200/70 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                  }`}
                >
                  <ShieldCheck className="h-4.5 w-4.5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <label
                      htmlFor="realtime-noise-gate-toggle"
                      className="font-display text-sm font-bold text-slate-900 dark:text-white cursor-pointer"
                    >
                      Real-Time Noise Gate
                    </label>
                    <Tooltip text="Automatically mutes quiet background hum and room hiss between words during both live playback and final export." />
                  </div>
                  <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                    Reduces background noise floor live while playing and automatically applies on export.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
                  {effects.noiseGate ? `Active · ${effects.noiseGateDb} dB` : 'Bypassed'}
                </span>
                <button
                  id="realtime-noise-gate-toggle"
                  type="button"
                  role="switch"
                  aria-checked={effects.noiseGate}
                  aria-label="Real-Time Noise Gate"
                  onClick={() => onChangeEffects({ ...effects, noiseGate: !effects.noiseGate })}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900 ${
                    effects.noiseGate ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow-sm transition-transform ${
                      effects.noiseGate ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
            </div>

            {effects.noiseGate && (
              <div className="mt-3.5 border-t border-emerald-500/20 pt-3 flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex items-center justify-between sm:w-48 text-xs">
                  <label
                    htmlFor="noise-gate-threshold-slider"
                    className="font-medium text-slate-700 dark:text-slate-300"
                  >
                    Gate Threshold
                  </label>
                  <span className="font-mono font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
                    {effects.noiseGateDb} dB
                  </span>
                </div>
                <input
                  id="noise-gate-threshold-slider"
                  type="range"
                  aria-label="Real-Time Noise Gate Threshold"
                  min={-60}
                  max={-20}
                  step={1}
                  value={effects.noiseGateDb}
                  onChange={(e) =>
                    onChangeEffects({ ...effects, noiseGateDb: Number(e.target.value) })
                  }
                  className="flex-1"
                />
                <span className="text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap">
                  Quieter (-60 dB) ↔ Stronger (-20 dB)
                </span>
              </div>
            )}
          </div>

          {/* Spectral Subtraction Noise Reduction (Noise-Floor Profiling for Hiss & AC Hum) */}
          <div
            data-testid="spectral-denoise-card"
            className="rounded-xl border border-cyan-500/40 bg-cyan-500/6 p-4 space-y-3.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-600 dark:text-cyan-400">
                  <AudioWaveform className="h-4.5 w-4.5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-display text-sm font-bold text-slate-900 dark:text-white">
                      Spectral Subtraction Noise Reduction
                    </span>
                    <Tooltip text="Profiles the FFT spectrum of room hiss or air conditioner hum and surgically subtracts those exact noise frequencies while protecting clear vocal formants." />
                  </div>
                  <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                    Captures a background noise floor profile to surgically remove static hiss and AC hum without dulling vocals.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="auto-noise-profile-btn"
                  onClick={() => handleCaptureNoiseProfile(false)}
                  className="rounded-lg border border-cyan-500/40 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-cyan-700 dark:text-cyan-300 hover:border-cyan-500 transition-colors"
                >
                  Auto-Detect Noise Profile
                </button>
                <button
                  type="button"
                  disabled={!selection || selection.end - selection.start < 0.08}
                  onClick={() => handleCaptureNoiseProfile(true)}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:border-cyan-500 disabled:opacity-40 transition-colors"
                >
                  Capture From Selection
                </button>
                <button
                  type="button"
                  data-testid="apply-spectral-denoise-btn"
                  disabled={isProcessing}
                  onClick={handleApplySpectralDenoise}
                  className="rounded-lg bg-cyan-600 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-cyan-700 disabled:opacity-50 transition-colors"
                >
                  Apply Spectral Denoise
                </button>
              </div>
            </div>

            {noiseProfile && (
              <div
                data-testid="noise-profile-status"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-cyan-500/25 bg-white/80 dark:bg-[#0B0F17] px-3.5 py-2 text-xs"
              >
                <span className="font-medium text-slate-700 dark:text-slate-300">
                  Noise Profile: <strong className="text-slate-900 dark:text-white">{noiseProfile.sourceLabel}</strong>
                </span>
                <span className="font-mono text-[11px] tabular-nums text-cyan-700 dark:text-cyan-300">
                  Floor {noiseProfile.noiseFloorDb.toFixed(1)} dB
                  {noiseProfile.dominantHumHz
                    ? ` · AC Hum Peak ~${noiseProfile.dominantHumHz} Hz`
                    : ' · Broadband Hiss Profile'}
                </span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border-t border-cyan-500/15 pt-3 text-xs">
              <div className="space-y-1">
                <div className="flex justify-between">
                  <label
                    htmlFor="spectral-strength-slider"
                    className="font-medium text-slate-700 dark:text-slate-300"
                  >
                    Noise Reduction
                  </label>
                  <span className="font-mono font-semibold tabular-nums text-cyan-700 dark:text-cyan-300">
                    {denoiseStrength}%
                  </span>
                </div>
                <input
                  id="spectral-strength-slider"
                  type="range"
                  aria-label="Spectral noise reduction strength"
                  min={10}
                  max={100}
                  step={5}
                  value={denoiseStrength}
                  onChange={(e) => setDenoiseStrength(Number(e.target.value))}
                  className="w-full"
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between">
                  <label
                    htmlFor="spectral-vocal-slider"
                    className="font-medium text-slate-700 dark:text-slate-300"
                  >
                    Vocal Clarity Protection
                  </label>
                  <span className="font-mono font-semibold tabular-nums text-cyan-700 dark:text-cyan-300">
                    {denoiseVocalProtect}%
                  </span>
                </div>
                <input
                  id="spectral-vocal-slider"
                  type="range"
                  aria-label="Spectral vocal clarity protection"
                  min={0}
                  max={100}
                  step={5}
                  value={denoiseVocalProtect}
                  onChange={(e) => setDenoiseVocalProtect(Number(e.target.value))}
                  className="w-full"
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between">
                  <label
                    htmlFor="spectral-floor-slider"
                    className="font-medium text-slate-700 dark:text-slate-300"
                  >
                    Residual Floor
                  </label>
                  <span className="font-mono font-semibold tabular-nums text-cyan-700 dark:text-cyan-300">
                    {denoiseFloorDb} dB
                  </span>
                </div>
                <input
                  id="spectral-floor-slider"
                  type="range"
                  aria-label="Spectral residual floor dB"
                  min={-36}
                  max={-12}
                  step={1}
                  value={denoiseFloorDb}
                  onChange={(e) => setDenoiseFloorDb(Number(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>
          </div>

          {/* Automated Pitch Correction (Real-Time FFT Auto-Tune) */}
          <div
            className={`rounded-xl border p-4 transition-colors ${
              effects.autoTune
                ? 'border-indigo-500/60 bg-indigo-500/8'
                : 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <div
                  className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                    effects.autoTune
                      ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400'
                      : 'bg-slate-200/70 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                  }`}
                >
                  <Music2 className="h-4.5 w-4.5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <label
                      htmlFor="autotune-toggle"
                      className="font-display text-sm font-bold text-slate-900 dark:text-white cursor-pointer"
                    >
                      Auto-Tune Pitch Correction (Real-Time FFT)
                    </label>
                    <Tooltip text="Analyzes monophonic vocal pitch using a real-time Fast Fourier Transform and snaps notes to the nearest semitone in your chosen musical scale." />
                  </div>
                  <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                    Snaps vocals to the nearest in-scale semitone live during playback, rendering, and export.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
                  {effects.autoTune
                    ? `${effects.autoTuneKey} ${MUSICAL_SCALES[effects.autoTuneScale].label}`
                    : 'Off'}
                </span>
                <button
                  id="autotune-toggle"
                  type="button"
                  role="switch"
                  aria-checked={effects.autoTune}
                  aria-label="Auto-Tune Pitch Correction"
                  onClick={() => onChangeEffects({ ...effects, autoTune: !effects.autoTune })}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900 ${
                    effects.autoTune ? 'bg-indigo-500' : 'bg-slate-300 dark:bg-slate-700'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow-sm transition-transform ${
                      effects.autoTune ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
            </div>

            {effects.autoTune && (
              <div className="mt-3.5 border-t border-indigo-500/20 pt-3.5 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <label className="space-y-1 text-xs">
                    <span className="font-medium text-slate-700 dark:text-slate-300">Root Key</span>
                    <select
                      aria-label="Auto-Tune musical key"
                      value={effects.autoTuneKey}
                      onChange={(e) =>
                        onChangeEffects({ ...effects, autoTuneKey: e.target.value as MusicalKey })
                      }
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 font-mono text-xs font-semibold text-slate-900 dark:text-white"
                    >
                      {MUSICAL_KEYS.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1 text-xs">
                    <span className="font-medium text-slate-700 dark:text-slate-300">
                      Target Scale
                    </span>
                    <select
                      aria-label="Auto-Tune musical scale"
                      value={effects.autoTuneScale}
                      onChange={(e) =>
                        onChangeEffects({
                          ...effects,
                          autoTuneScale: e.target.value as MusicalScale,
                        })
                      }
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-slate-900 dark:text-white"
                    >
                      {(Object.keys(MUSICAL_SCALES) as MusicalScale[]).map((sc) => (
                        <option key={sc} value={sc}>
                          {MUSICAL_SCALES[sc].label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <label
                        htmlFor="autotune-strength-slider"
                        className="font-medium text-slate-700 dark:text-slate-300"
                      >
                        Retune Speed
                      </label>
                      <span className="font-mono font-semibold tabular-nums text-indigo-600 dark:text-indigo-400">
                        {effects.autoTuneStrength}%
                      </span>
                    </div>
                    <input
                      id="autotune-strength-slider"
                      type="range"
                      aria-label="Auto-Tune retune speed"
                      min={10}
                      max={100}
                      step={5}
                      value={effects.autoTuneStrength}
                      onChange={(e) =>
                        onChangeEffects({ ...effects, autoTuneStrength: Number(e.target.value) })
                      }
                      className="w-full"
                    />
                  </div>
                </div>

                {/* Live FFT Pitch Tuner Bar */}
                <div
                  data-testid="autotune-tuner"
                  data-voiced={autoTuneTelemetry?.voiced ? 'true' : 'false'}
                  data-detected-hz={autoTuneTelemetry?.detectedHz ?? 0}
                  data-target-note={autoTuneTelemetry?.targetNote ?? '--'}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-indigo-500/25 bg-white/80 dark:bg-[#0B0F17] px-3.5 py-2 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        isPlaying && autoTuneTelemetry?.voiced
                          ? 'bg-indigo-500 animate-pulse'
                          : 'bg-slate-400'
                      }`}
                    />
                    <span className="font-semibold text-slate-700 dark:text-slate-300">
                      FFT Pitch Tuner:
                    </span>
                    <span className="font-mono tabular-nums text-slate-900 dark:text-white">
                      {isPlaying && autoTuneTelemetry?.voiced
                        ? `${autoTuneTelemetry.detectedHz.toFixed(1)} Hz (${autoTuneTelemetry.detectedNote}) → ${autoTuneTelemetry.targetNote}`
                        : isPlaying
                        ? 'Listening for vocal pitch...'
                        : 'Press Play to monitor live FFT pitch snap'}
                    </span>
                  </div>
                  <span className="font-mono text-[11px] tabular-nums text-indigo-600 dark:text-indigo-400">
                    {isPlaying && autoTuneTelemetry?.voiced
                      ? `${autoTuneTelemetry.centsOffset >= 0 ? '+' : ''}${autoTuneTelemetry.centsOffset}¢ · Shift ${autoTuneTelemetry.shiftSemitones >= 0 ? '+' : ''}${autoTuneTelemetry.shiftSemitones.toFixed(2)} st`
                      : `${effects.autoTuneKey} ${MUSICAL_SCALES[effects.autoTuneScale].label}`}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Main Track Dynamics Processor (Compressor & Brickwall Limiter) */}
          <div
            className={`rounded-xl border p-4 transition-colors ${
              effects.dynamicsProcessor
                ? 'border-amber-500/60 bg-amber-500/8'
                : 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <div
                  className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                    effects.dynamicsProcessor
                      ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                      : 'bg-slate-200/70 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                  }`}
                >
                  <Gauge className="h-4.5 w-4.5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <label
                      htmlFor="dynamics-processor-toggle"
                      className="font-display text-sm font-bold text-slate-900 dark:text-white cursor-pointer"
                    >
                      Main Track Dynamics Processor (Compressor &amp; Limiter)
                    </label>
                    <Tooltip text="Smoothly evens out loud and quiet vocal passages with soft-knee compression and prevents digital clipping with a brickwall limiter on playback and export." />
                  </div>
                  <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                    Automatically evens out volume levels and clamps peaks below the limiter ceiling during playback and export.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
                  {effects.dynamicsProcessor
                    ? `${effects.dynamicsRatio.toFixed(1)}:1 · Ceiling ${effects.limiterCeilingDb.toFixed(1)} dB`
                    : 'Bypassed'}
                </span>
                <button
                  id="dynamics-processor-toggle"
                  type="button"
                  role="switch"
                  aria-checked={effects.dynamicsProcessor}
                  aria-label="Dynamics Processor"
                  onClick={() =>
                    onChangeEffects({
                      ...effects,
                      dynamicsProcessor: !effects.dynamicsProcessor,
                    })
                  }
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900 ${
                    effects.dynamicsProcessor ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-700'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow-sm transition-transform ${
                      effects.dynamicsProcessor ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
            </div>

            {effects.dynamicsProcessor && (
              <div className="mt-3.5 border-t border-amber-500/20 pt-3.5 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <label
                        htmlFor="dynamics-threshold-slider"
                        className="font-medium text-slate-700 dark:text-slate-300"
                      >
                        Threshold
                      </label>
                      <span className="font-mono font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                        {effects.dynamicsThresholdDb} dB
                      </span>
                    </div>
                    <input
                      id="dynamics-threshold-slider"
                      type="range"
                      aria-label="Dynamics Compressor Threshold"
                      min={-36}
                      max={-6}
                      step={1}
                      value={effects.dynamicsThresholdDb}
                      onChange={(e) =>
                        onChangeEffects({
                          ...effects,
                          dynamicsThresholdDb: Number(e.target.value),
                        })
                      }
                      className="w-full"
                    />
                  </div>

                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <label
                        htmlFor="dynamics-ratio-slider"
                        className="font-medium text-slate-700 dark:text-slate-300"
                      >
                        Ratio
                      </label>
                      <span className="font-mono font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                        {effects.dynamicsRatio.toFixed(1)}:1
                      </span>
                    </div>
                    <input
                      id="dynamics-ratio-slider"
                      type="range"
                      aria-label="Dynamics Compressor Ratio"
                      min={1.5}
                      max={12}
                      step={0.5}
                      value={effects.dynamicsRatio}
                      onChange={(e) =>
                        onChangeEffects({
                          ...effects,
                          dynamicsRatio: Number(e.target.value),
                        })
                      }
                      className="w-full"
                    />
                  </div>

                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <label
                        htmlFor="dynamics-makeup-slider"
                        className="font-medium text-slate-700 dark:text-slate-300"
                      >
                        Makeup Gain
                      </label>
                      <span className="font-mono font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                        +{effects.dynamicsMakeupDb.toFixed(1)} dB
                      </span>
                    </div>
                    <input
                      id="dynamics-makeup-slider"
                      type="range"
                      aria-label="Dynamics Makeup Gain"
                      min={0}
                      max={12}
                      step={0.5}
                      value={effects.dynamicsMakeupDb}
                      onChange={(e) =>
                        onChangeEffects({
                          ...effects,
                          dynamicsMakeupDb: Number(e.target.value),
                        })
                      }
                      className="w-full"
                    />
                  </div>

                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <label
                        htmlFor="dynamics-ceiling-slider"
                        className="font-medium text-slate-700 dark:text-slate-300"
                      >
                        Limiter Ceiling
                      </label>
                      <span className="font-mono font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                        {effects.limiterCeilingDb.toFixed(1)} dBFS
                      </span>
                    </div>
                    <input
                      id="dynamics-ceiling-slider"
                      type="range"
                      aria-label="Dynamics Limiter Ceiling"
                      min={-3.0}
                      max={-0.1}
                      step={0.1}
                      value={effects.limiterCeilingDb}
                      onChange={(e) =>
                        onChangeEffects({
                          ...effects,
                          limiterCeilingDb: Number(e.target.value),
                        })
                      }
                      className="w-full"
                    />
                  </div>
                </div>

                {/* Live Gain Reduction & Limiter Protection Bar */}
                <div
                  data-testid="dynamics-gr-meter"
                  data-active={isPlaying ? 'true' : 'false'}
                  data-reduction-db={dynamicsTelemetry ? dynamicsTelemetry.reductionDb.toFixed(1) : '0.0'}
                  data-limiting={dynamicsTelemetry?.limiting ? 'true' : 'false'}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/25 bg-white/80 dark:bg-[#0B0F17] px-3.5 py-2 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        isPlaying && dynamicsTelemetry?.limiting
                          ? 'bg-rose-500 animate-pulse'
                          : isPlaying
                          ? 'bg-amber-500 animate-pulse'
                          : 'bg-slate-400'
                      }`}
                    />
                    <span className="font-semibold text-slate-700 dark:text-slate-300">
                      Gain Reduction:
                    </span>
                    <span className="font-mono tabular-nums text-slate-900 dark:text-white">
                      {isPlaying && dynamicsTelemetry
                        ? `${dynamicsTelemetry.reductionDb.toFixed(1)} dB`
                        : '0.0 dB (press Play to monitor live)'}
                    </span>
                  </div>
                  <span className="font-mono text-[11px] tabular-nums text-amber-600 dark:text-amber-400">
                    {isPlaying && dynamicsTelemetry?.limiting
                      ? `Limiter Active (${dynamicsTelemetry.limiterReductionDb.toFixed(1)} dB)`
                      : `Brickwall Anti-Clip ≤ ${effects.limiterCeilingDb.toFixed(1)} dBFS`}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* 6 One-Click DSP Effect Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {(
              [
                {
                  key: 'studioPolish',
                  title: 'Studio Voice Polish',
                  desc: 'Removes rumble, clears muddiness, boosts vocal clarity, and balances loudness.',
                },
                {
                  key: 'cleanNoise',
                  title: 'Clean Background Noise',
                  desc: 'Quiets fan hum, air-conditioning hiss, and room background static.',
                },
                {
                  key: 'removeEcho',
                  title: 'Remove Room Echo',
                  desc: 'Tightens hollow room bounce and softens boxy echo reflections.',
                },
                {
                  key: 'autoLevel',
                  title: 'Auto-Level & Multi-Speaker',
                  desc: 'Raises quiet sections so every speaker sounds even and clear.',
                },
                {
                  key: 'warmRadio',
                  title: 'Warm Radio / Podcast Tone',
                  desc: 'Adds rich broadcast low-mid warmth with smooth analog polish.',
                },
                {
                  key: 'breathSoftener',
                  title: 'Breath, Pop & Sibilance Softener',
                  desc: 'Tames harsh "S" sounds, mic pops, and distracting breath spikes.',
                },
              ] as const
            ).map((fx) => {
              const active = effects[fx.key];
              return (
                <button
                  key={fx.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChangeEffects({ ...effects, [fx.key]: !active })}
                  className={`flex flex-col justify-between rounded-xl border p-4 text-left transition-colors ${
                    active
                      ? 'border-blue-500 bg-blue-500/10'
                      : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display text-sm font-bold text-slate-900 dark:text-white">
                      {fx.title}
                    </span>
                    <span
                      className={`flex h-5 w-5 items-center justify-center rounded-full border ${
                        active
                          ? 'border-blue-600 bg-blue-600 text-white'
                          : 'border-slate-300 dark:border-slate-600'
                      }`}
                    >
                      {active && <Check className="h-3 w-3" />}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    {fx.desc}
                  </p>
                </button>
              );
            })}
          </div>

          {/* 7th Effect: Smooth Fade In & Fade Out */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 p-4">
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="font-semibold text-slate-700 dark:text-slate-300">
                  Smooth Fade In
                </span>
                <span className="font-mono tabular-nums text-slate-500">
                  {effects.fadeInSec.toFixed(1)}s
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={5}
                step={0.1}
                value={effects.fadeInSec}
                onChange={(e) => onChangeEffects({ ...effects, fadeInSec: Number(e.target.value) })}
                className="w-full"
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="font-semibold text-slate-700 dark:text-slate-300">
                  Smooth Fade Out
                </span>
                <span className="font-mono tabular-nums text-slate-500">
                  {effects.fadeOutSec.toFixed(1)}s
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={5}
                step={0.1}
                value={effects.fadeOutSec}
                onChange={(e) => onChangeEffects({ ...effects, fadeOutSec: Number(e.target.value) })}
                className="w-full"
              />
            </div>
          </div>

          {/* Pro Mode Fine-Tuned DSP Controls */}
          {userMode === 'pro' && (
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 border-t border-slate-100 dark:border-slate-800 pt-4">
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">High-Pass Filter</span>
                  <span className="font-mono tabular-nums">{effects.highPassHz} Hz</span>
                </div>
                <input
                  type="range"
                  min={40}
                  max={180}
                  step={5}
                  value={effects.highPassHz}
                  onChange={(e) => onChangeEffects({ ...effects, highPassHz: Number(e.target.value) })}
                  className="w-full"
                />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Noise Gate</span>
                  <span className="font-mono tabular-nums">{effects.noiseGateDb} dB</span>
                </div>
                <input
                  type="range"
                  min={-60}
                  max={-24}
                  step={1}
                  value={effects.noiseGateDb}
                  onChange={(e) => onChangeEffects({ ...effects, noiseGateDb: Number(e.target.value) })}
                  className="w-full"
                />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">De-Esser Band</span>
                  <span className="font-mono tabular-nums">{(effects.deEsserFreqHz / 1000).toFixed(1)} kHz</span>
                </div>
                <input
                  type="range"
                  min={5500}
                  max={9000}
                  step={100}
                  value={effects.deEsserFreqHz}
                  onChange={(e) => onChangeEffects({ ...effects, deEsserFreqHz: Number(e.target.value) })}
                  className="w-full"
                />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Comp Ratio</span>
                  <span className="font-mono tabular-nums">{effects.compressorRatio.toFixed(1)}:1</span>
                </div>
                <input
                  type="range"
                  min={1.5}
                  max={8}
                  step={0.5}
                  value={effects.compressorRatio}
                  onChange={(e) => onChangeEffects({ ...effects, compressorRatio: Number(e.target.value) })}
                  className="w-full"
                />
              </div>
            </div>
          )}
        </section>
      )}

      {/* TAB 3: SIMPLE 3-LANE CREATOR MIXER */}
      {activeTab === 'mixer' && (
        <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
                3-Lane Creator Mixer
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Blend your voice with royalty-free background beds and sound effects — Auto-Ducking lowers music while you speak.
              </p>
            </div>
            <button
              type="button"
              disabled={isProcessing}
              onClick={handleRenderMixer}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Radio className="h-4 w-4" />
              <span>{isProcessing ? 'Mixing...' : 'Apply 3-Lane Mix to Track'}</span>
            </button>
          </div>

          {/* Lane 1: Main Voice */}
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-4">
            <div className="flex items-center gap-3 min-w-[180px]">
              <button
                type="button"
                aria-label="Mute main voice"
                onClick={() => onChangeMixer({ ...mixer, voiceMuted: !mixer.voiceMuted })}
                className={`flex h-8 w-8 items-center justify-center rounded-lg border ${
                  mixer.voiceMuted
                    ? 'border-rose-500 bg-rose-500/15 text-rose-500'
                    : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                }`}
              >
                {mixer.voiceMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              </button>
              <div>
                <div className="text-sm font-bold text-slate-900 dark:text-white">Lane 1 · Main Voice</div>
                <div className="text-xs text-slate-500">{title}</div>
              </div>
            </div>
            <div className="flex items-center gap-3 flex-1 max-w-xs">
              <input
                type="range"
                aria-label="Main voice volume"
                min={0}
                max={1.5}
                step={0.05}
                value={mixer.voiceVolume}
                onChange={(e) => onChangeMixer({ ...mixer, voiceVolume: Number(e.target.value) })}
                className="w-full"
              />
              <span className="w-10 text-right font-mono text-xs tabular-nums">
                {Math.round(mixer.voiceVolume * 100)}%
              </span>
            </div>
          </div>

          {/* Lane 2: Background Music + Auto-Ducking */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-[200px]">
                <button
                  type="button"
                  aria-label="Mute background music"
                  onClick={() => onChangeMixer({ ...mixer, musicMuted: !mixer.musicMuted })}
                  className={`flex h-8 w-8 items-center justify-center rounded-lg border ${
                    mixer.musicMuted
                      ? 'border-rose-500 bg-rose-500/15 text-rose-500'
                      : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  {mixer.musicMuted ? <VolumeX className="h-4 w-4" /> : <Music className="h-4 w-4" />}
                </button>
                <div>
                  <div className="text-sm font-bold text-slate-900 dark:text-white">
                    Lane 2 · Background Music
                  </div>
                  <div className="text-xs text-slate-500">
                    {mixer.musicTrackName ?? 'Pick a built-in music bed or upload your own'}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={mixer.autoDucking}
                    onChange={(e) => onChangeMixer({ ...mixer, autoDucking: e.target.checked })}
                    className="h-4 w-4 rounded accent-blue-600"
                  />
                  <span>Auto-Ducking</span>
                  <Tooltip text="Automatically lowers background music whenever you speak and swells it gently during pauses." />
                </label>

                <div className="flex items-center gap-2 w-40">
                  <input
                    type="range"
                    aria-label="Background music volume"
                    min={0}
                    max={1}
                    step={0.05}
                    value={mixer.musicVolume}
                    onChange={(e) => onChangeMixer({ ...mixer, musicVolume: Number(e.target.value) })}
                    className="w-full"
                  />
                  <span className="w-9 text-right font-mono text-xs tabular-nums">
                    {Math.round(mixer.musicVolume * 100)}%
                  </span>
                </div>
              </div>
            </div>

            {/* Real Envelope-Following Gain Automation Visualizer & Controls */}
            {currentBuffer && (
              <div className="space-y-3 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white/80 dark:bg-[#0D121C] p-3.5">
                <DuckingEnvelopeCanvas
                  voiceBuffer={currentBuffer}
                  mixer={mixer}
                  currentTime={currentTime}
                  duration={duration}
                  theme={theme}
                />

                {mixer.autoDucking && (
                  <div className="space-y-2.5 pt-1">
                    {/* Novice Friendly Ducking Depth Presets */}
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-slate-700 dark:text-slate-300">
                        Ducking Smoothness:
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {(
                          [
                            { label: 'Gentle (-8 dB)', db: -8, attack: 60, hold: 160, release: 420 },
                            { label: 'Podcast Smooth (-12 dB)', db: -12, attack: 45, hold: 180, release: 380 },
                            { label: 'Deep Radio (-18 dB)', db: -18, attack: 30, hold: 220, release: 320 },
                          ] as const
                        ).map((preset) => (
                          <button
                            key={preset.label}
                            type="button"
                            onClick={() =>
                              onChangeMixer({
                                ...mixer,
                                duckAmountDb: preset.db,
                                duckAttackMs: preset.attack,
                                duckHoldMs: preset.hold,
                                duckReleaseMs: preset.release,
                              })
                            }
                            className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                              mixer.duckAmountDb === preset.db
                                ? 'bg-amber-500 text-slate-950'
                                : 'border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-amber-500'
                            }`}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Pro Mode Envelope Timing Fine-Tuning */}
                    {userMode === 'pro' && (
                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 pt-1 text-[11px]">
                        <label className="space-y-1">
                          <div className="flex justify-between">
                            <span className="text-slate-500">Duck Depth</span>
                            <span className="font-mono">{mixer.duckAmountDb} dB</span>
                          </div>
                          <input
                            type="range"
                            min={-24}
                            max={-4}
                            step={1}
                            value={mixer.duckAmountDb}
                            onChange={(e) =>
                              onChangeMixer({ ...mixer, duckAmountDb: Number(e.target.value) })
                            }
                            className="w-full"
                          />
                        </label>
                        <label className="space-y-1">
                          <div className="flex justify-between">
                            <span className="text-slate-500">Attack</span>
                            <span className="font-mono">{mixer.duckAttackMs ?? 45} ms</span>
                          </div>
                          <input
                            type="range"
                            min={15}
                            max={150}
                            step={5}
                            value={mixer.duckAttackMs ?? 45}
                            onChange={(e) =>
                              onChangeMixer({ ...mixer, duckAttackMs: Number(e.target.value) })
                            }
                            className="w-full"
                          />
                        </label>
                        <label className="space-y-1">
                          <div className="flex justify-between">
                            <span className="text-slate-500">Hold</span>
                            <span className="font-mono">{mixer.duckHoldMs ?? 180} ms</span>
                          </div>
                          <input
                            type="range"
                            min={40}
                            max={500}
                            step={20}
                            value={mixer.duckHoldMs ?? 180}
                            onChange={(e) =>
                              onChangeMixer({ ...mixer, duckHoldMs: Number(e.target.value) })
                            }
                            className="w-full"
                          />
                        </label>
                        <label className="space-y-1">
                          <div className="flex justify-between">
                            <span className="text-slate-500">Release Swell</span>
                            <span className="font-mono">{mixer.duckReleaseMs ?? 380} ms</span>
                          </div>
                          <input
                            type="range"
                            min={100}
                            max={900}
                            step={20}
                            value={mixer.duckReleaseMs ?? 380}
                            onChange={(e) =>
                              onChangeMixer({ ...mixer, duckReleaseMs: Number(e.target.value) })
                            }
                            className="w-full"
                          />
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              {STARTER_SOUND_PACK.filter((s) => s.category === 'music').map((bed) => (
                <button
                  key={bed.id}
                  type="button"
                  onClick={() => handleSelectStarterMusic(bed.id)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                    mixer.musicTrackId === bed.id
                      ? 'border-blue-500 bg-blue-500/15 text-blue-600 dark:text-blue-300'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                  }`}
                >
                  {bed.name}
                </button>
              ))}
              <label className="cursor-pointer rounded-lg border border-dashed border-slate-300 dark:border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:border-blue-500">
                <span>+ Upload Own Music</span>
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleUploadMusicFile(f);
                    e.target.value = '';
                  }}
                />
              </label>
              {mixer.musicBuffer && (
                <button
                  type="button"
                  onClick={() =>
                    onChangeMixer({ ...mixer, musicTrackId: null, musicTrackName: null, musicBuffer: null })
                  }
                  className="text-xs text-rose-500 hover:underline ml-1"
                >
                  Clear Music
                </button>
              )}
            </div>
          </div>

          {/* Lane 3: Sound Effects / Stingers */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label="Mute sound effects"
                  onClick={() => onChangeMixer({ ...mixer, sfxMuted: !mixer.sfxMuted })}
                  className={`flex h-8 w-8 items-center justify-center rounded-lg border ${
                    mixer.sfxMuted
                      ? 'border-rose-500 bg-rose-500/15 text-rose-500'
                      : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  <Sparkles className="h-4 w-4" />
                </button>
                <div>
                  <div className="text-sm font-bold text-slate-900 dark:text-white">
                    Lane 3 · Sound Effects & Stingers
                  </div>
                  <div className="text-xs text-slate-500">
                    Click any starter effect to drop it at the current playhead ({formatDuration(currentTime, true)})
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 w-40">
                <input
                  type="range"
                  aria-label="Sound effects volume"
                  min={0}
                  max={1}
                  step={0.05}
                  value={mixer.sfxVolume}
                  onChange={(e) => onChangeMixer({ ...mixer, sfxVolume: Number(e.target.value) })}
                  className="w-full"
                />
                <span className="w-9 text-right font-mono text-xs tabular-nums">
                  {Math.round(mixer.sfxVolume * 100)}%
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {STARTER_SOUND_PACK.filter((s) => s.category === 'sfx').map((sfx) => (
                <button
                  key={sfx.id}
                  type="button"
                  onClick={() => handlePlaceSfxAtPlayhead(sfx.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-blue-500 transition-colors"
                >
                  <Plus className="h-3 w-3 text-blue-500" />
                  <span>{sfx.name}</span>
                </button>
              ))}
            </div>

            {mixer.sfxPlacements.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-200/70 dark:border-slate-800">
                {mixer.sfxPlacements.map((p) => (
                  <span
                    key={p.id}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1 text-xs"
                  >
                    <span className="font-medium">{p.name}</span>
                    <span className="font-mono text-[11px] text-slate-500">
                      @{formatDuration(p.time, true)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${p.name}`}
                      onClick={() =>
                        onChangeMixer({
                          ...mixer,
                          sfxPlacements: mixer.sfxPlacements.filter((x) => x.id !== p.id),
                        })
                      }
                      className="text-slate-400 hover:text-rose-500"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* TAB: AI TRANSCRIPT, CLOUD API NOTES & CAPTIONS */}
      {activeTab === 'transcript' && currentBuffer && (
        <AiTranscriptPanel
          buffer={currentBuffer}
          duration={duration}
          currentTime={currentTime}
          transcript={transcript}
          onChangeTranscript={onChangeTranscript}
          onJumpAndPlay={(t) => {
            setCurrentTime(t);
            startPlayback(t);
          }}
          onDownloadTextFile={downloadTextFile}
          enableCloudAiApi={cfg.enableCloudAiApi}
          showLocalSpeechOption={cfg.showLocalSpeechOption}
          showNoviceHints={cfg.showNoviceHints}
          onNotify={onNotify}
        />
      )}
    </div>
  );
}
