import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  FileAudio,
  FileVideo,
  Flag,
  Headphones,
  Mic,
  MicOff,
  Monitor,
  Pause,
  Play,
  RotateCcw,
  ScrollText,
  Shield,
  Sliders,
  SlidersHorizontal,
  Sparkles,
  Square,
  Upload,
  Volume2,
  Waves,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BookmarkMarker,
  CaptureSource,
  ImportedVideoRef,
  LiveRecordingControls,
  OopsMarker,
  RealtimeNoiseGateHandle,
  RoomCheckResult,
  ThemeMode,
  TranscriptSegment,
  UserMode,
} from '../types/audio';
import { audioBackend } from '../services/audioBackend';
import {
  VAD_SENSITIVITY_PRESETS,
  VoiceActivityDetector,
  type VadSensitivity,
} from '../services/vadService';
import {
  appendAutoSaveChunk,
  startAutoSaveSession,
} from '../services/storageService';
import { formatDuration, formatFileSize, linearToDb } from '../utils/audioDsp';
import { isAndroidNative, setNativeKeepScreenOn } from '../utils/platformFileSave';
import { parseStudioProjectFile } from '../utils/projectFile';
import {
  getPresetConfig,
  isRecorderOnlyConfig,
  type WorkspaceConfig,
} from '../utils/workspaceConfig';
import { Tooltip } from './Tooltip';

interface RecorderViewProps {
  userMode: UserMode;
  onToggleUserMode?: (mode: UserMode) => void;
  workspaceConfig?: WorkspaceConfig;
  onOpenCustomizer?: () => void;
  quickSavedClip?: { title: string; duration: number; onDownloadWav: () => void } | null;
  ecoMode?: boolean;
  theme: ThemeMode;
  onRecordingComplete: (payload: {
    buffer: AudioBuffer;
    title: string;
    bookmarks: BookmarkMarker[];
    oopsMarkers: OopsMarker[];
    transcript: TranscriptSegment[];
    autoSaveSessionId?: string;
    importedVideo?: ImportedVideoRef | null;
    fromRecorder?: boolean;
  }) => void;
  onLoadSample: () => void;
  onRecordingStateChange: (active: boolean) => void;
  onNotify: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
  registerShortcuts?: (handlers: {
    toggleRecord: () => void;
    dropBookmark: () => void;
    oopsRetry: () => void;
  }) => void;
}

const DEFAULT_LIVE_CONTROLS: LiveRecordingControls = {
  inputGain: 1.0,
  muted: false,
  steadyVoiceLeveler: true,
  voicePresenceDb: 0,
  lowCutDb: 0,
  brightnessDb: 0,
  liveNoiseGate: false,
  monitorEnabled: false,
  monitorVolume: 0.5,
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
};

export function RecorderView({
  userMode,
  onToggleUserMode,
  workspaceConfig,
  onOpenCustomizer,
  quickSavedClip,
  ecoMode = false,
  theme,
  onRecordingComplete,
  onLoadSample,
  onRecordingStateChange,
  onNotify,
  registerShortcuts,
}: RecorderViewProps) {
  const cfg = workspaceConfig ?? getPresetConfig(userMode === 'pro' ? 'full-pro' : 'novice-office');
  const recorderOnly = isRecorderOnlyConfig(cfg);
  const showSideCard = cfg.recorderShowOpenFile || cfg.recorderShowSampleButton;
  const canCaptureSystemAudio =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
    !isAndroidNative();
  const [source, setSource] = useState<CaptureSource>('mic');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');

  // Recording states
  const [status, setStatus] = useState<'idle' | 'countdown' | 'recording' | 'paused'>('idle');
  const [countdownVal, setCountdownVal] = useState(3);
  const [useCountdown, setUseCountdown] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [recordedBytes, setRecordedBytes] = useState(0);
  const [autoSavePulse, setAutoSavePulse] = useState(false);
  const [savedChunksCount, setSavedChunksCount] = useState(0);

  // Smart recording features
  const [timeMachineArmed, setTimeMachineArmed] = useState(false);
  const [timeMachineBufferedSec, setTimeMachineBufferedSec] = useState(0);
  const [voiceActivated, setVoiceActivated] = useState(false);
  const [vadSensitivity, setVadSensitivity] = useState<VadSensitivity>('medium');
  const [vadThresholdDb, setVadThresholdDb] = useState<number>(
    VAD_SENSITIVITY_PRESETS.medium.thresholdDb
  );
  const [vadPaused, setVadPaused] = useState(false);
  const [vadSilenceSec, setVadSilenceSec] = useState(0);
  const [maxSizeMb, setMaxSizeMb] = useState<number>(0); // 0 = Off
  const [customMaxMb, setCustomMaxMb] = useState<string>('15');
  const [sampleRatePref, setSampleRatePref] = useState<number>(44100);
  const [stereoPref, setStereoPref] = useState<boolean>(false);

  // Room & Mic Check
  const [checkingRoom, setCheckingRoom] = useState(false);
  const [roomResult, setRoomResult] = useState<RoomCheckResult | null>(null);
  const [playingTestAudio, setPlayingTestAudio] = useState(false);

  // Live meters & helpers
  const [levelDb, setLevelDb] = useState(-60);
  const [peakDb, setPeakDb] = useState(-60);
  const [bookmarks, setBookmarks] = useState<BookmarkMarker[]>([]);
  const [bookmarkInput, setBookmarkInput] = useState('');
  const [oopsMarkers, setOopsMarkers] = useState<OopsMarker[]>([]);
  const [micDisconnectedMsg, setMicDisconnectedMsg] = useState<string | null>(null);

  // Teleprompter drawer
  const [showPrompter, setShowPrompter] = useState(false);
  const [prompterText, setPrompterText] = useState(
    'Welcome to today’s episode! Speak naturally, pause whenever you need to breathe, and if you stumble on a line just tap Oops! Retry Last Line — NTK StudioWave will automatically clean it up for you.'
  );
  const [prompterFontSize, setPrompterFontSize] = useState(20);
  const [prompterSpeed, setPrompterSpeed] = useState(0); // 0 = manual, 1..5 = auto-scroll
  const prompterBoxRef = useRef<HTMLDivElement>(null);

  // Live Recording Control Rack (collapsed by default in Simple mode to keep first glance calm!)
  const [showLiveControls, setShowLiveControls] = useState(userMode === 'pro');
  const [showSimpleOptions, setShowSimpleOptions] = useState(false);
  const [liveControls, setLiveControls] = useState<LiveRecordingControls>(DEFAULT_LIVE_CONTROLS);
  const liveNodesRef = useRef<{
    inputGain: GainNode;
    lowFilter: BiquadFilterNode;
    presenceFilter: BiquadFilterNode;
    highFilter: BiquadFilterNode;
    gate: RealtimeNoiseGateHandle;
    leveler: DynamicsCompressorNode;
    monitorGain: GainNode;
  } | null>(null);

  // Live Speech-to-Text
  const [liveTranscript, setLiveTranscript] = useState<TranscriptSegment[]>([]);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [speechSupported] = useState(() => {
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
  });

  // Import drag & drop
  const [isDragOver, setIsDragOver] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Refs for Web Audio / MediaRecorder internals
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waveHistoryRef = useRef<number[]>(new Array(160).fill(0));
  const streamRef = useRef<MediaStream | null>(null);
  const extraStreamsRef = useRef<MediaStream[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadDetectorRef = useRef<VoiceActivityDetector | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const preRollChunksRef = useRef<Blob[]>([]);
  const preRollRecorderRef = useRef<MediaRecorder | null>(null);
  const preRollStreamRef = useRef<MediaStream | null>(null);
  const sessionIdRef = useRef<string>('');
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const speechRecRef = useRef<SpeechRecognitionLike | null>(null);
  const rafRef = useRef<number>(0);
  const timerRef = useRef<number>(0);
  const silentSecondsRef = useRef<number>(0);
  const silentToastShownRef = useRef<boolean>(false);
  const elapsedRef = useRef<number>(0);
  const statusRef = useRef(status);
  const voiceActivatedRef = useRef(voiceActivated);
  const maxSizeMbRef = useRef(maxSizeMb);
  const ecoModeRef = useRef(ecoMode);

  statusRef.current = status;
  voiceActivatedRef.current = voiceActivated;
  maxSizeMbRef.current = maxSizeMb;
  ecoModeRef.current = ecoMode;

  // Live-sync real-time recording mixer sliders directly into the active Web Audio graph!
  useEffect(() => {
    const nodes = liveNodesRef.current;
    if (!nodes) return;
    const now = nodes.inputGain.context.currentTime;
    nodes.inputGain.gain.setTargetAtTime(liveControls.muted ? 0 : liveControls.inputGain, now, 0.02);
    nodes.lowFilter.gain.setTargetAtTime(liveControls.lowCutDb, now, 0.03);
    nodes.presenceFilter.gain.setTargetAtTime(liveControls.voicePresenceDb, now, 0.03);
    nodes.highFilter.gain.setTargetAtTime(liveControls.brightnessDb, now, 0.03);
    nodes.gate.setEnabled(liveControls.liveNoiseGate);
    nodes.leveler.threshold.setTargetAtTime(liveControls.steadyVoiceLeveler ? -22 : -1, now, 0.04);
    nodes.leveler.ratio.setTargetAtTime(liveControls.steadyVoiceLeveler ? 4.5 : 1.0, now, 0.04);
    nodes.monitorGain.gain.setTargetAtTime(
      liveControls.monitorEnabled ? liveControls.monitorVolume : 0,
      now,
      0.02
    );
  }, [liveControls]);

  // Live-sync Voice Activity Detection toggle and threshold changes
  useEffect(() => {
    if (vadDetectorRef.current) {
      vadDetectorRef.current.setEnabled(voiceActivated);
      vadDetectorRef.current.setThresholdDb(vadThresholdDb);
    }
    if (!voiceActivated && vadPaused && recorderRef.current?.state === 'paused' && statusRef.current === 'recording') {
      recorderRef.current.resume();
      setVadPaused(false);
      setVadSilenceSec(0);
    }
  }, [voiceActivated, vadThresholdDb, vadPaused]);

  // Enumerate microphones cleanly
  const refreshDevices = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const list = await navigator.mediaDevices.enumerateDevices();
      const mics = list.filter((d) => d.kind === 'audioinput');
      setDevices(mics);
      if (mics.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(mics[0].deviceId);
      }
    } catch {
      // ignore in restricted environments
    }
  }, [selectedDeviceId]);

  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
    };
  }, [refreshDevices]);

  // Auto-scroll teleprompter when speed > 0 and recording
  useEffect(() => {
    if (!showPrompter || prompterSpeed <= 0 || status !== 'recording') return;
    const id = window.setInterval(() => {
      if (prompterBoxRef.current) {
        prompterBoxRef.current.scrollTop += prompterSpeed * 0.8;
      }
    }, 45);
    return () => clearInterval(id);
  }, [showPrompter, prompterSpeed, status]);

  // Manage Time Machine 10-Second Pre-Roll Buffer when armed & idle
  useEffect(() => {
    let cancelled = false;
    const stopPreRoll = () => {
      if (preRollRecorderRef.current && preRollRecorderRef.current.state !== 'inactive') {
        try {
          preRollRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      preRollRecorderRef.current = null;
      preRollStreamRef.current?.getTracks().forEach((t) => t.stop());
      preRollStreamRef.current = null;
      setTimeMachineBufferedSec(0);
    };

    if (!timeMachineArmed || status !== 'idle') {
      if (status === 'idle') stopPreRoll();
      return;
    }

    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true,
        });
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        preRollStreamRef.current = s;
        preRollChunksRef.current = [];
        const preMime = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/mp4',
          'audio/ogg;codecs=opus',
        ].find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));
        const mr = preMime ? new MediaRecorder(s, { mimeType: preMime }) : new MediaRecorder(s);
        preRollRecorderRef.current = mr;
        mr.ondataavailable = (e) => {
          if (e.data.size > 0) {
            preRollChunksRef.current.push(e.data);
            // Keep rolling last 10 chunks (10 seconds)
            if (preRollChunksRef.current.length > 10) {
              preRollChunksRef.current.shift();
            }
            setTimeMachineBufferedSec(preRollChunksRef.current.length);
          }
        };
        mr.start(1000);
      } catch {
        setTimeMachineArmed(false);
        onNotify('Microphone permission is needed to arm the 10-second Time Machine buffer.', 'warning');
      }
    })();

    return () => {
      cancelled = true;
      if (statusRef.current === 'idle') stopPreRoll();
    };
  }, [timeMachineArmed, status, selectedDeviceId, onNotify]);

  // Draw live scrolling waveform canvas
  const drawLiveCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext('2d');
    if (!g) return;

    const dpr = ecoModeRef.current ? 1 : Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(280, Math.floor(rect.width));
    const h = 112;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    g.save();
    g.scale(dpr, dpr);

    const isDark = theme === 'dark';
    g.fillStyle = isDark ? '#0D121C' : '#F8FAFC';
    g.fillRect(0, 0, w, h);

    // Subtle center line
    g.strokeStyle = isDark ? 'rgba(148,163,184,0.14)' : 'rgba(100,116,139,0.18)';
    g.beginPath();
    g.moveTo(0, h / 2);
    g.lineTo(w, h / 2);
    g.stroke();

    const hist = waveHistoryRef.current;
    const barW = w / hist.length;
    for (let i = 0; i < hist.length; i++) {
      const amp = Math.min(1, hist[i] * 2.4);
      const barH = Math.max(2, amp * (h - 18));
      const x = i * barW;
      const y = (h - barH) / 2;
      g.fillStyle =
        statusRef.current === 'recording'
          ? amp > 0.85
            ? '#e11d48'
            : '#3b82f6'
          : isDark
          ? '#334155'
          : '#cbd5e1';
      g.fillRect(x, y, Math.max(1.5, barW - 1.5), barH);
    }
    g.restore();
  }, [theme]);

  useEffect(() => {
    drawLiveCanvas();
  }, [drawLiveCanvas]);

  const acquireStream = async (): Promise<MediaStream> => {
    extraStreamsRef.current = [];
    const audioConstraints: MediaTrackConstraints = {
      deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
      channelCount: stereoPref ? 2 : 1,
      sampleRate: sampleRatePref,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };

    if (source === 'mic') {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      refreshDevices();
      return mic;
    }

    if (source === 'tab') {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      // Stop video track immediately — we only need the tab/system audio
      display.getVideoTracks().forEach((t) => t.stop());
      if (display.getAudioTracks().length === 0) {
        throw new Error('No audio track shared. Check "Share tab audio" in the browser picker.');
      }
      return new MediaStream(display.getAudioTracks());
    }

    // Mic + Tab Audio mixed via Web Audio API
    const mic = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    display.getVideoTracks().forEach((t) => t.stop());
    extraStreamsRef.current = [mic, display];

    const ctx = audioBackend.getAudioContext();
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(mic).connect(dest);
    if (display.getAudioTracks().length > 0) {
      ctx.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(dest);
    }
    return dest.stream;
  };

  const acquireWakeLock = async () => {
    try {
      const nav = navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
      if (nav.wakeLock) {
        wakeLockRef.current = await nav.wakeLock.request('screen');
      }
    } catch {
      // Wake Lock not supported or disallowed
    }
  };

  const releaseWakeLock = () => {
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  };

  const startLiveSpeechRecognition = () => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;
    try {
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = navigator.language || 'en-US';
      rec.onresult = (ev) => {
        let interim = '';
        for (let i = 0; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (r.isFinal) {
            const text = r[0].transcript.trim();
            if (text) {
              setLiveTranscript((prev) => {
                if (prev.some((p) => p.text === text && Math.abs(p.end - elapsedRef.current) < 2)) {
                  return prev;
                }
                const end = Math.max(0.5, elapsedRef.current);
                const start = Math.max(0, end - Math.min(4, text.split(' ').length * 0.4));
                return [...prev, { id: `stt-${Date.now()}-${i}`, start, end, text }];
              });
            }
          } else {
            interim += r[0].transcript;
          }
        }
        setInterimTranscript(interim);
      };
      rec.onerror = () => {};
      rec.start();
      speechRecRef.current = rec;
    } catch {
      // graceful fallback
    }
  };

  const stopLiveSpeechRecognition = () => {
    try {
      speechRecRef.current?.stop();
    } catch {
      // ignore
    }
    speechRecRef.current = null;
    setInterimTranscript('');
  };

  const stopRecordingAndFinalize = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) return;

    cancelAnimationFrame(rafRef.current);
    clearInterval(timerRef.current);
    vadDetectorRef.current?.stop();
    vadDetectorRef.current = null;
    stopLiveSpeechRecognition();
    releaseWakeLock();
    setNativeKeepScreenOn(false);

    const finalizedBlob = await new Promise<Blob>((resolve) => {
      const finish = () => {
        const mimeType = rec.mimeType || 'audio/webm';
        resolve(new Blob(chunksRef.current, { type: mimeType }));
      };
      if (rec.state === 'inactive') {
        finish();
      } else {
        rec.onstop = finish;
        try {
          rec.stop();
        } catch {
          finish();
        }
      }
    });

    liveNodesRef.current?.gate.dispose();
    liveNodesRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    extraStreamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streamRef.current = null;
    recorderRef.current = null;

    setStatus('idle');
    setVadPaused(false);
    setVadSilenceSec(0);
    onRecordingStateChange(false);

    try {
      const arrayBuf = await finalizedBlob.arrayBuffer();
      const audioBuf = await audioBackend.decodeAudioData(arrayBuf);
      const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      onRecordingComplete({
        buffer: audioBuf,
        title: `Recording ${stamp}`,
        bookmarks,
        oopsMarkers,
        transcript: liveTranscript,
        autoSaveSessionId: sessionIdRef.current,
        importedVideo: null,
        fromRecorder: true,
      });
    } catch {
      onNotify('Could not decode recorded audio. Make sure your microphone captured audio.', 'error');
    }
  }, [bookmarks, liveTranscript, onNotify, onRecordingComplete, onRecordingStateChange, oopsMarkers]);

  const beginCaptureNow = async () => {
    try {
      setMicDisconnectedMsg(null);
      const stream = await acquireStream();
      streamRef.current = stream;

      // Stop pre-roll recorder and grab buffered chunks if Time Machine was armed
      const preRollBlobs: Blob[] = [];
      if (timeMachineArmed && preRollChunksRef.current.length > 0) {
        preRollBlobs.push(...preRollChunksRef.current);
        preRollChunksRef.current = [];
        try {
          preRollRecorderRef.current?.stop();
        } catch {
          // ignore
        }
        preRollStreamRef.current?.getTracks().forEach((t) => t.stop());
        onNotify(`Captured ${preRollBlobs.length}s from Time Machine pre-roll buffer!`, 'info');
      }

      const ctx = audioBackend.getAudioContext();
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => undefined);
      }
      const srcNode = ctx.createMediaStreamSource(stream);

      // Build lightweight Real-Time Live Recording Chain so sliders shape audio AS IT RECORDS
      const inputGain = ctx.createGain();
      inputGain.gain.value = liveControls.muted ? 0 : liveControls.inputGain;

      const lowFilter = ctx.createBiquadFilter();
      lowFilter.type = 'lowshelf';
      lowFilter.frequency.value = 140;
      lowFilter.gain.value = liveControls.lowCutDb;

      const presenceFilter = ctx.createBiquadFilter();
      presenceFilter.type = 'peaking';
      presenceFilter.frequency.value = 1800;
      presenceFilter.Q.value = 1.1;
      presenceFilter.gain.value = liveControls.voicePresenceDb;

      const highFilter = ctx.createBiquadFilter();
      highFilter.type = 'highshelf';
      highFilter.frequency.value = 6000;
      highFilter.gain.value = liveControls.brightnessDb;

      const liveGate = audioBackend.createRealtimeNoiseGate(ctx, {
        enabled: liveControls.liveNoiseGate,
        thresholdDb: -42,
        floorGain: 0.03,
      });

      const leveler = ctx.createDynamicsCompressor();
      leveler.threshold.value = liveControls.steadyVoiceLeveler ? -22 : -1;
      leveler.knee.value = 18;
      leveler.ratio.value = liveControls.steadyVoiceLeveler ? 4.5 : 1.0;
      leveler.attack.value = 0.006;
      leveler.release.value = 0.18;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = ecoModeRef.current ? 512 : 1024;
      analyserRef.current = analyser;

      const processedDest = ctx.createMediaStreamDestination();
      const monitorGain = ctx.createGain();
      monitorGain.gain.value = liveControls.monitorEnabled ? liveControls.monitorVolume : 0;

      srcNode.connect(inputGain);
      inputGain.connect(lowFilter);
      lowFilter.connect(presenceFilter);
      presenceFilter.connect(highFilter);
      highFilter.connect(liveGate.input);
      liveGate.output.connect(leveler);
      leveler.connect(analyser);
      analyser.connect(processedDest);
      analyser.connect(monitorGain);
      monitorGain.connect(ctx.destination);

      liveNodesRef.current = {
        inputGain,
        lowFilter,
        presenceFilter,
        highFilter,
        gate: liveGate,
        leveler,
        monitorGain,
      };

      const recordStream = processedDest.stream;
      const preferredMimes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ];
      const mimeType = preferredMimes.find((m) => MediaRecorder.isTypeSupported(m)) || '';
      const recorder = mimeType
        ? new MediaRecorder(recordStream, { mimeType })
        : new MediaRecorder(recordStream);
      recorderRef.current = recorder;

      chunksRef.current = [...preRollBlobs];
      let chunkCounter = preRollBlobs.length;
      let totalByteAcc = preRollBlobs.reduce((a, b) => a + b.size, 0);
      setRecordedBytes(totalByteAcc);
      setSavedChunksCount(chunkCounter);

      const sid = `rec-${Date.now()}`;
      sessionIdRef.current = sid;
      const nowLabel = `Auto-Backup ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      await startAutoSaveSession({
        sessionId: sid,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        chunkCount: chunkCounter,
        durationSec: preRollBlobs.length,
        mimeType: recorder.mimeType || 'audio/webm',
        title: nowLabel,
      });

      // Persist pre-roll chunks into IndexedDB immediately
      for (let i = 0; i < preRollBlobs.length; i++) {
        await appendAutoSaveChunk(sid, preRollBlobs[i], i + 1, i + 1);
      }

      // Mic Disconnect Guard
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (recorderRef.current && recorderRef.current.state === 'recording') {
            recorderRef.current.pause();
            setStatus('paused');
            setMicDisconnectedMsg(
              'Microphone disconnected! Your audio is safely backed up. Select another mic and resume or stop to edit.'
            );
            onNotify('Microphone disconnected — recording paused safely with backup preserved.', 'warning');
          }
        };
      });

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) {
          chunksRef.current.push(ev.data);
          chunkCounter++;
          totalByteAcc += ev.data.size;
          setRecordedBytes(totalByteAcc);
          setSavedChunksCount(chunkCounter);

          // 1-Second Append-Only Auto-Save to IndexedDB
          appendAutoSaveChunk(sid, ev.data, elapsedRef.current, chunkCounter)
            .then(() => {
              setAutoSavePulse(true);
              setTimeout(() => setAutoSavePulse(false), 320);
            })
            .catch(() => {});

          // Max File Size Auto-Stop Guard
          const capMb = maxSizeMbRef.current;
          if (capMb > 0) {
            const capBytes = capMb * 1024 * 1024 * 0.96;
            if (totalByteAcc >= capBytes) {
              onNotify(`Reached ${capMb} MB size limit — finalized recording cleanly!`, 'info');
              stopRecordingAndFinalize();
            }
          }
        }
      };

      setBookmarks([]);
      setOopsMarkers([]);
      setLiveTranscript([]);
      elapsedRef.current = preRollBlobs.length;
      setElapsedSec(preRollBlobs.length);
      silentSecondsRef.current = 0;
      silentToastShownRef.current = false;
      waveHistoryRef.current = new Array(160).fill(0);

      await acquireWakeLock();
      setNativeKeepScreenOn(true);
      recorder.start(1000); // emit 1-second chunks for append-only IndexedDB backup
      setStatus('recording');
      onRecordingStateChange(true);
      startLiveSpeechRecognition();

      // Elapsed timer + Silent-Mic Alert
      timerRef.current = window.setInterval(() => {
        if (statusRef.current === 'recording' && recorderRef.current?.state === 'recording') {
          elapsedRef.current += 0.1;
          setElapsedSec(Number(elapsedRef.current.toFixed(1)));
        }
      }, 100);

      // Start Web Audio AnalyserNode Voice Activity Detection (2-second silence auto-pause)
      const vadDetector = new VoiceActivityDetector({
        analyser,
        thresholdDb: vadThresholdDb,
        silenceHoldMs: 2000,
        onAutoPause: () => {
          if (statusRef.current === 'recording' && recorderRef.current?.state === 'recording') {
            recorderRef.current.pause();
            setVadPaused(true);
            onNotify('Voice Activation paused recording after 2s of silence — speak to resume.', 'info');
          }
        },
        onAutoResume: () => {
          if (statusRef.current === 'recording' && recorderRef.current?.state === 'paused') {
            recorderRef.current.resume();
            setVadPaused(false);
            setVadSilenceSec(0);
          }
        },
        onLevelUpdate: ({ silenceElapsedMs }) => {
          setVadSilenceSec(Number((silenceElapsedMs / 1000).toFixed(1)));
        },
      });
      vadDetector.setEnabled(voiceActivatedRef.current);
      vadDetector.start();
      vadDetectorRef.current = vadDetector;

      // Metering & Live Scrolling Waveform loop (auto-throttles in Lite Mode for 1GB PCs)
      const timeData = new Float32Array(analyser.fftSize);
      let lastMeterMs = 0;
      const tick = (now: number) => {
        if (!analyserRef.current) return;
        const minGap = ecoModeRef.current ? 66 : 20;
        if (now - lastMeterMs >= minGap) {
          lastMeterMs = now;
          analyserRef.current.getFloatTimeDomainData(timeData);
          let sumSq = 0;
          let peak = 0;
          for (let i = 0; i < timeData.length; i++) {
            const v = timeData[i];
            sumSq += v * v;
            if (Math.abs(v) > peak) peak = Math.abs(v);
          }
          const rms = Math.sqrt(sumSq / timeData.length);
          const curDb = Math.max(-60, Math.round(linearToDb(rms)));
          const pkDb = Math.max(-60, Math.round(linearToDb(peak)));
          setLevelDb(curDb);
          setPeakDb(pkDb);

          if (statusRef.current === 'recording') {
            waveHistoryRef.current.push(rms);
            if (waveHistoryRef.current.length > 160) waveHistoryRef.current.shift();

            // Silent-Mic Alert after 5 seconds of zero signal
            if (peak < 0.002) {
              silentSecondsRef.current += minGap / 1000;
              if (silentSecondsRef.current >= 5 && !silentToastShownRef.current) {
                silentToastShownRef.current = true;
                onNotify('No sound detected — check if your microphone is muted.', 'warning');
              }
            } else {
              silentSecondsRef.current = 0;
            }
          }

          drawLiveCanvas();
        }
        if (statusRef.current === 'recording' || statusRef.current === 'paused') {
          rafRef.current = requestAnimationFrame(tick);
        }
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      setNativeKeepScreenOn(false);
      const rawMsg = err instanceof Error ? err.message : '';
      const isPermErr = /permission|denied|notallowed/i.test(rawMsg);
      const msg = isPermErr
        ? 'Microphone access is needed. Tap Allow when prompted, or enable Microphone permission in Settings.'
        : rawMsg || 'Microphone access was denied. Check device permissions or try the 15-Second Sample.';
      onNotify(msg, 'error');
      setStatus('idle');
      onRecordingStateChange(false);
    }
  };

  const handleStartRecord = () => {
    if (status !== 'idle') return;
    if (!useCountdown) {
      beginCaptureNow();
      return;
    }
    setStatus('countdown');
    setCountdownVal(3);
    let c = 3;
    const id = window.setInterval(() => {
      c--;
      if (c <= 0) {
        clearInterval(id);
        beginCaptureNow();
      } else {
        setCountdownVal(c);
      }
    }, 1000);
  };

  const handlePauseResume = () => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (status === 'recording') {
      if (rec.state === 'recording') rec.pause();
      setStatus('paused');
    } else if (status === 'paused') {
      if (rec.state === 'paused') rec.resume();
      setStatus('recording');
    }
  };

  const handleDropBookmark = useCallback(() => {
    if (status !== 'recording' && status !== 'paused') return;
    const label = bookmarkInput.trim() || `Chapter ${bookmarks.length + 1}`;
    setBookmarks((prev) => [
      ...prev,
      { id: `bm-${Date.now()}`, time: elapsedRef.current, label },
    ]);
    setBookmarkInput('');
    onNotify(`Bookmark "${label}" dropped at ${formatDuration(elapsedRef.current, true)}`, 'info');
  }, [bookmarkInput, bookmarks.length, onNotify, status]);

  const handleOopsRetry = useCallback(() => {
    if (status !== 'recording' && status !== 'paused') return;
    setOopsMarkers((prev) => [...prev, { id: `oops-${Date.now()}`, time: elapsedRef.current }]);
    onNotify('Oops marker dropped! Retake your line — auto-cut it with one click in the editor.', 'info');
  }, [onNotify, status]);

  // Register global keyboard shortcuts
  useEffect(() => {
    registerShortcuts?.({
      toggleRecord: () => {
        if (statusRef.current === 'idle') handleStartRecord();
        else stopRecordingAndFinalize();
      },
      dropBookmark: handleDropBookmark,
      oopsRetry: handleOopsRetry,
    });
  }, [handleDropBookmark, handleOopsRetry, registerShortcuts, stopRecordingAndFinalize]);

  const handleRoomCheck = async () => {
    setCheckingRoom(true);
    setRoomResult(null);
    let tempStream: MediaStream | null = null;
    try {
      tempStream = await navigator.mediaDevices.getUserMedia({
        audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true,
      });
      refreshDevices();
      const res = await audioBackend.analyzeRoomNoise(tempStream, 2200);
      setRoomResult(res);
    } catch {
      onNotify('Allow microphone access to run the 2-Second Room & Mic Check.', 'warning');
    } finally {
      tempStream?.getTracks().forEach((t) => t.stop());
      setCheckingRoom(false);
    }
  };

  const handlePlayRoomTest = () => {
    if (!roomResult?.sampleBlob) return;
    const url = URL.createObjectURL(roomResult.sampleBlob);
    const audio = new Audio(url);
    setPlayingTestAudio(true);
    audio.onended = () => {
      setPlayingTestAudio(false);
      URL.revokeObjectURL(url);
    };
    audio.onerror = () => {
      setPlayingTestAudio(false);
      URL.revokeObjectURL(url);
    };
    audio.play().catch(() => setPlayingTestAudio(false));
  };

  // Universal Drag & Drop Audio/Video/Project (.swproj) Import
  const handleFileImport = async (file: File) => {
    setIsImporting(true);
    try {
      if (/\.swproj$/i.test(file.name)) {
        const text = await file.text();
        const proj = await parseStudioProjectFile(text);
        const audioBuffer = await audioBackend.decodeAudioData(proj.wavBuffer);
        onRecordingComplete({
          buffer: audioBuffer,
          title: proj.title,
          bookmarks: proj.bookmarks,
          oopsMarkers: [],
          transcript: proj.transcript,
          importedVideo: null,
          fromRecorder: false,
        });
        onNotify(`Reopened project "${proj.title}".`, 'success');
        return;
      }

      const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/i.test(file.name);
      const arrayBuf = await file.arrayBuffer();
      const audioBuffer = await audioBackend.decodeAudioData(arrayBuf);
      const cleanName = file.name.replace(/\.[^.]+$/, '');
      const videoRef: ImportedVideoRef | null = isVideo
        ? { file, objectUrl: URL.createObjectURL(file), name: file.name }
        : null;

      onRecordingComplete({
        buffer: audioBuffer,
        title: cleanName,
        bookmarks: [],
        oopsMarkers: [],
        transcript: [],
        importedVideo: videoRef,
        fromRecorder: false,
      });
      onNotify(
        isVideo
          ? `Extracted audio from video "${file.name}".`
          : `Opened "${file.name}" in the editor.`,
        'success'
      );
    } catch {
      onNotify(
        'Could not open that file. Try MP3, WAV, OGG, M4A, WebM, FLAC, MP4, MOV, or .swproj.',
        'error'
      );
    } finally {
      setIsImporting(false);
    }
  };

  const volumeHelper =
    status === 'idle'
      ? { label: 'Ready to record', tone: 'text-slate-500 dark:text-slate-400' }
      : peakDb > -3
      ? { label: 'Too Loud! Step back slightly', tone: 'text-rose-600 dark:text-rose-400 font-semibold' }
      : levelDb < -44
      ? { label: 'Too Quiet — Move Closer', tone: 'text-amber-600 dark:text-amber-400 font-semibold' }
      : { label: 'Good Level', tone: 'text-emerald-600 dark:text-emerald-400 font-semibold' };

  const sizeLimitRatio =
    maxSizeMb > 0 ? Math.min(100, (recordedBytes / (maxSizeMb * 1024 * 1024)) * 100) : 0;

  // DEDICATED MINIMAL "RECORDER ONLY" VIEW (Shows strictly the recorder, timer & essential controls)
  if (!cfg.recorderShowProCockpit && (recorderOnly || !showSideCard)) {
    return (
      <div
        className="mx-auto max-w-xl min-h-[calc(100vh-11rem)] flex flex-col justify-center py-4 sm:py-8 space-y-6"
        data-testid="minimal-recorder-view"
      >
        <section className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-6 sm:p-8 shadow-xs space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                Voice Recorder
              </h1>
              {cfg.showNoviceHints && (
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Press Start Recording to capture audio. Press Stop when finished.
                </p>
              )}
            </div>
            {cfg.recorderShowMicPicker && (
              <select
                aria-label="Select microphone"
                disabled={status !== 'idle'}
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
                className="min-h-[44px] sm:min-h-[38px] max-w-[210px] truncate rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {devices.length === 0 ? (
                  <option value="">Default Microphone</option>
                ) : (
                  devices.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Microphone ${i + 1}`}
                    </option>
                  ))
                )}
              </select>
            )}
          </div>

          {micDisconnectedMsg && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-200">
              <MicOff className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{micDisconnectedMsg}</span>
            </div>
          )}

          {/* Giant Crisp Tabular Record Timer */}
          {cfg.recorderShowTimer && (
            <div className="text-center py-3 space-y-1.5">
              <div
                data-testid="minimal-record-timer"
                className="font-mono text-5xl sm:text-6xl font-bold tracking-tight tabular-nums text-slate-900 dark:text-white"
              >
                {formatDuration(elapsedSec, true)}
              </div>
              <div className={`text-xs ${volumeHelper.tone}`}>
                {vadPaused ? 'Paused while quiet...' : volumeHelper.label}
              </div>
            </div>
          )}

          {/* Optional Live Sound Wave */}
          {cfg.recorderShowWaveform && (
            <div className="relative overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D121C]">
              <canvas
                ref={canvasRef}
                data-testid="live-recorder-canvas"
                className="block w-full h-24 sm:h-28"
              />
              {status === 'countdown' && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-950/75">
                  <span className="font-display text-5xl font-extrabold text-white tabular-nums">
                    {countdownVal}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Thumb-Friendly Primary Controls (48px+ tall) */}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {status === 'idle' ? (
              <button
                type="button"
                onClick={handleStartRecord}
                className="w-full h-14 inline-flex items-center justify-center gap-3 rounded-2xl bg-rose-600 px-6 text-base font-bold text-white hover:bg-rose-700 active:scale-[0.99] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
              >
                <span className="h-3.5 w-3.5 rounded-full bg-white" />
                <span>Start Recording</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handlePauseResume}
                  className="h-14 inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-5 text-sm font-semibold text-slate-900 dark:text-white hover:bg-slate-50 dark:hover:bg-slate-700"
                >
                  {status === 'paused' ? (
                    <>
                      <Play className="h-4.5 w-4.5 fill-current" />
                      <span>Resume</span>
                    </>
                  ) : (
                    <>
                      <Pause className="h-4.5 w-4.5 fill-current" />
                      <span>Pause</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={stopRecordingAndFinalize}
                  className="flex-1 h-14 inline-flex items-center justify-center gap-2 rounded-2xl bg-blue-600 px-6 text-base font-bold text-white hover:bg-blue-700 active:scale-[0.99] transition-all"
                >
                  <Square className="h-4 w-4 fill-current" />
                  <span>{cfg.showEditScreen ? 'Stop & Edit' : 'Stop & Save'}</span>
                </button>
              </>
            )}
          </div>

          {/* Instant Download bar when recording finishes in Recorder-Only mode */}
          {recorderOnly && quickSavedClip && status === 'idle' && (
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-50/80 dark:bg-emerald-500/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-bold text-emerald-900 dark:text-emerald-200 truncate">
                  Ready: {quickSavedClip.title}
                </div>
                <div className="text-xs font-mono tabular-nums text-emerald-700 dark:text-emerald-300">
                  Length {formatDuration(quickSavedClip.duration, true)}
                </div>
              </div>
              <button
                type="button"
                onClick={quickSavedClip.onDownloadWav}
                className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-700 shrink-0"
              >
                <Download className="h-4 w-4" />
                <span>Download Audio</span>
              </button>
            </div>
          )}

          {cfg.recorderShowOptionalSettings && (
            <div className="border-t border-slate-100 dark:border-slate-800 pt-3">
              <button
                type="button"
                onClick={() => setShowSimpleOptions((v) => !v)}
                aria-expanded={showSimpleOptions}
                className="flex w-full min-h-[40px] items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
              >
                <span>Optional settings (countdown, pause on silence, live volume)</span>
                {showSimpleOptions ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              {showSimpleOptions && (
                <div className="mt-3 space-y-3 text-xs text-slate-700 dark:text-slate-300">
                  <div className="flex items-center justify-between gap-2 min-h-[36px]">
                    <label htmlFor="min-countdown" className="cursor-pointer">
                      3-2-1 countdown before starting
                    </label>
                    <input
                      id="min-countdown"
                      type="checkbox"
                      checked={useCountdown}
                      onChange={(e) => setUseCountdown(e.target.checked)}
                      className="h-4.5 w-4.5 rounded accent-blue-600"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 min-h-[36px]">
                    <label htmlFor="min-vad" className="cursor-pointer">
                      Auto-pause when I stop talking (2s)
                    </label>
                    <input
                      id="min-vad"
                      type="checkbox"
                      checked={voiceActivated}
                      onChange={(e) => setVoiceActivated(e.target.checked)}
                      className="h-4.5 w-4.5 rounded accent-blue-600"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {onOpenCustomizer && (
          <div className="text-center">
            <button
              type="button"
              onClick={onOpenCustomizer}
              className="inline-flex items-center gap-1.5 min-h-[40px] text-xs font-semibold text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span>Want Edit, Save, AI Transcription, or other controls? Customize Screen</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  // CALM, ZERO-FEAR SIMPLE MODE (Novice Office First-Glance Experience)
  if (!cfg.recorderShowProCockpit) {
    return (
      <div className="mx-auto max-w-4xl space-y-6 sm:space-y-8 py-2 sm:py-4" data-testid="simple-recorder-view">
        {/* Warm, Uncluttered Welcome */}
        <div className="text-center space-y-2 max-w-2xl mx-auto">
          <h1 className="font-display text-2xl sm:text-4xl font-bold tracking-tight text-slate-900 dark:text-white [text-wrap:balance]">
            Record your voice or open an audio file
          </h1>
          <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400">
            Shared office ready — works on any PC or phone with no login or private locks. Customize what you see anytime.
          </p>
        </div>

        {/* Clean 2-Card Split: Record on Left, Open File / Practice on Right */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-5 sm:gap-6 items-stretch">
          {/* Primary Focus Card: Record */}
          <section className="md:col-span-7 flex flex-col justify-between rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 sm:p-7 space-y-5 sm:space-y-6">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                    Record Voice
                  </h2>
                  {cfg.showNoviceHints && (
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Step 1: Click Start Recording, speak normally, then click Done.
                    </p>
                  )}
                </div>
                {cfg.recorderShowMicPicker && (
                  <select
                    aria-label="Select microphone"
                    disabled={status !== 'idle'}
                    value={selectedDeviceId}
                    onChange={(e) => setSelectedDeviceId(e.target.value)}
                    className="min-h-[42px] sm:min-h-[36px] max-w-[200px] truncate rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {devices.length === 0 ? (
                      <option value="">Default Microphone</option>
                    ) : (
                      devices.map((d, i) => (
                        <option key={d.deviceId || i} value={d.deviceId}>
                          {d.label || `Microphone ${i + 1}`}
                        </option>
                      ))
                    )}
                  </select>
                )}
              </div>

              {micDisconnectedMsg && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-200">
                  <MicOff className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{micDisconnectedMsg}</span>
                </div>
              )}

              {/* Clean Calm Waveform & Simple Timer */}
              {(cfg.recorderShowTimer || cfg.recorderShowWaveform) && (
                <div className="space-y-2.5">
                  {cfg.recorderShowTimer && (
                    <div className="flex items-baseline justify-between">
                      <span className="font-mono text-3xl sm:text-4xl font-semibold tracking-tight tabular-nums text-slate-900 dark:text-white">
                        {formatDuration(elapsedSec, true)}
                      </span>
                      <span className={`text-xs ${volumeHelper.tone}`}>
                        {vadPaused ? 'Paused while quiet...' : volumeHelper.label}
                      </span>
                    </div>
                  )}
                  {cfg.recorderShowWaveform && (
                    <div className="relative overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D121C]">
                      <canvas
                        ref={canvasRef}
                        data-testid="live-recorder-canvas"
                        className="block w-full h-24"
                      />
                      {status === 'countdown' && (
                        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/75">
                          <span className="font-display text-5xl font-extrabold text-white tabular-nums">
                            {countdownVal}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Big Inviting Record / Stop Actions */}
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                {status === 'idle' ? (
                  <button
                    type="button"
                    onClick={handleStartRecord}
                    className="flex-1 min-h-[48px] inline-flex items-center justify-center gap-2.5 rounded-xl bg-rose-600 px-6 py-3.5 text-sm font-bold text-white hover:bg-rose-700 active:scale-[0.99] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                  >
                    <span className="h-3 w-3 rounded-full bg-white" />
                    <span>Start Recording</span>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={handlePauseResume}
                      className="min-h-[48px] inline-flex items-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-5 py-3 text-sm font-semibold text-slate-900 dark:text-white hover:bg-slate-50 dark:hover:bg-slate-700"
                    >
                      {status === 'paused' ? (
                        <>
                          <Play className="h-4 w-4 fill-current" />
                          <span>Resume</span>
                        </>
                      ) : (
                        <>
                          <Pause className="h-4 w-4 fill-current" />
                          <span>Pause</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={stopRecordingAndFinalize}
                      className="flex-1 min-h-[48px] inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-sm font-bold text-white hover:bg-blue-700"
                    >
                      <Square className="h-3.5 w-3.5 fill-current" />
                      <span>{cfg.showEditScreen ? 'Done — Edit Audio' : 'Done — Save Audio'}</span>
                    </button>
                  </>
                )}
              </div>

              {/* Optional Quiet Accordion for Everyday Helpers & Live Mic Volume */}
              {cfg.recorderShowOptionalSettings && (
                <div className="border-t border-slate-100 dark:border-slate-800 pt-3">
                  <button
                    type="button"
                    onClick={() => setShowSimpleOptions((v) => !v)}
                    aria-expanded={showSimpleOptions}
                    className="flex w-full min-h-[40px] items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                  >
                    <span>Optional settings (countdown, pause on silence, live volume)</span>
                    {showSimpleOptions ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                  {showSimpleOptions && (
                    <div className="mt-3 space-y-3 text-xs text-slate-700 dark:text-slate-300">
                      <div className="flex items-center justify-between gap-2 min-h-[36px]">
                        <label htmlFor="simple-countdown" className="cursor-pointer">
                          3-2-1 countdown before starting
                        </label>
                        <input
                          id="simple-countdown"
                          type="checkbox"
                          checked={useCountdown}
                          onChange={(e) => setUseCountdown(e.target.checked)}
                          className="h-4.5 w-4.5 rounded accent-blue-600"
                        />
                      </div>
                      <div className="flex items-center justify-between gap-2 min-h-[36px]">
                        <label htmlFor="simple-vad" className="cursor-pointer">
                          Auto-pause when I stop talking (2s)
                        </label>
                        <input
                          id="simple-vad"
                          type="checkbox"
                          checked={voiceActivated}
                          onChange={(e) => setVoiceActivated(e.target.checked)}
                          className="h-4.5 w-4.5 rounded accent-blue-600"
                        />
                      </div>
                      <div className="flex items-center justify-between gap-2 min-h-[36px]">
                        <label htmlFor="simple-steady-live" className="cursor-pointer">
                          Keep my voice volume steady while recording
                        </label>
                        <input
                          id="simple-steady-live"
                          type="checkbox"
                          checked={liveControls.steadyVoiceLeveler}
                          onChange={(e) =>
                            setLiveControls((c) => ({ ...c, steadyVoiceLeveler: e.target.checked }))
                          }
                          className="h-4.5 w-4.5 rounded accent-blue-600"
                        />
                      </div>
                      <div className="space-y-1 pt-1">
                        <div className="flex justify-between">
                          <span>Live Mic Volume</span>
                          <span className="font-mono tabular-nums">
                            {liveControls.muted ? 'Muted' : `${Math.round(liveControls.inputGain * 100)}%`}
                          </span>
                        </div>
                        <input
                          type="range"
                          aria-label="Live microphone volume"
                          min={0}
                          max={2}
                          step={0.05}
                          value={liveControls.muted ? 0 : liveControls.inputGain}
                          onChange={(e) =>
                            setLiveControls((c) => ({
                              ...c,
                              inputGain: Number(e.target.value),
                              muted: Number(e.target.value) === 0,
                            }))
                          }
                          className="w-full"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Secondary Card: Open Existing File or Try Sample */}
          <aside className="md:col-span-5 flex flex-col justify-between rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 sm:p-7 space-y-5">
            {cfg.recorderShowOpenFile && (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragOver(true);
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragOver(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) handleFileImport(f);
                }}
                className={`flex-1 flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-5 sm:p-6 text-center transition-colors ${
                  isDragOver
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10'
                    : 'border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/40'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*,video/*,.mp3,.wav,.ogg,.m4a,.webm,.flac,.mp4,.mov,.swproj"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFileImport(f);
                    e.target.value = '';
                  }}
                />
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-blue-600 dark:text-blue-400">
                  <Upload className="h-5 w-5" />
                </div>
                <h2 className="mt-3 font-display text-base font-bold text-slate-900 dark:text-white">
                  Open Audio or Video
                </h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  Drop MP3, WAV, M4A, video, or a saved <span className="font-mono">.swproj</span> project here.
                </p>
                <button
                  type="button"
                  disabled={isImporting}
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-4 w-full min-h-[44px] rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                >
                  {isImporting ? 'Opening file...' : 'Choose File from Device'}
                </button>
              </div>
            )}

            {cfg.recorderShowSampleButton && (
              <div
                className={`${
                  cfg.recorderShowOpenFile ? 'border-t border-slate-100 dark:border-slate-800 pt-4' : ''
                } text-center space-y-2.5`}
              >
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Want to practice editing without recording first?
                </p>
                <button
                  type="button"
                  onClick={onLoadSample}
                  className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-blue-50 dark:bg-blue-500/15 px-4 py-2.5 text-xs font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-500/25 transition-colors"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>Try With a 15-Second Sample</span>
                </button>
              </div>
            )}
          </aside>
        </div>

        {/* Gentle, Zero-Pressure Customize & Pro Mode Footer */}
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-center text-xs text-slate-500 dark:text-slate-400">
          {onOpenCustomizer && (
            <button
              type="button"
              onClick={onOpenCustomizer}
              className="inline-flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span>Want Recorder Only or custom buttons? Customize Screen</span>
            </button>
          )}
          {onToggleUserMode && (
            <>
              <span aria-hidden="true" className="hidden sm:inline">·</span>
              <button
                type="button"
                onClick={() => onToggleUserMode('pro')}
                className="font-semibold text-blue-600 dark:text-blue-400 hover:underline"
              >
                Switch to Pro Mode
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Pro Mode Header Banner */}
      {status === 'idle' && (
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] px-6 py-5">
          <div className="space-y-1">
            <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
              Pro Audio Recorder &amp; Capture
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Live mic &amp; tone shaping, Voice Activity Detection, Time Machine pre-roll, and instant local import.
            </p>
          </div>
          <button
            type="button"
            onClick={onLoadSample}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#131822]"
          >
            <Sparkles className="h-4 w-4" />
            <span>Try With a 15-Second Sample</span>
          </button>
        </div>
      )}

      {/* Main 2-Column Studio Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left/Center Recording Deck (8 cols) */}
        <section className="lg:col-span-8 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 sm:p-6 space-y-5">
          {/* Top Row: Source Selector + Live Auto-Save Status */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div
                role="group"
                aria-label="Audio input source"
                className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700/80 bg-slate-100 dark:bg-slate-900 p-0.5"
              >
                {(
                  [
                    { id: 'mic', label: 'Microphone', icon: Mic },
                    ...(canCaptureSystemAudio
                      ? [
                          { id: 'tab', label: 'Tab / System', icon: Monitor },
                          { id: 'mic+tab', label: 'Mic + Tab', icon: Waves },
                        ]
                      : []),
                  ] as Array<{ id: CaptureSource; label: string; icon: typeof Mic }>
                ).map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={status !== 'idle'}
                      onClick={() => setSource(item.id)}
                      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap disabled:opacity-50 ${
                        source === item.id
                          ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>

              {source !== 'tab' && (
                <select
                  aria-label="Select microphone"
                  disabled={status !== 'idle'}
                  value={selectedDeviceId}
                  onChange={(e) => setSelectedDeviceId(e.target.value)}
                  className="max-w-[220px] truncate rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {devices.length === 0 ? (
                    <option value="">Default Microphone</option>
                  ) : (
                    devices.map((d, i) => (
                      <option key={d.deviceId || i} value={d.deviceId}>
                        {d.label || `Microphone ${i + 1}`}
                      </option>
                    ))
                  )}
                </select>
              )}
            </div>

            {/* Calm Live 1-Second Auto-Save Pill while recording */}
            {(status === 'recording' || status === 'paused') && (
              <div
                aria-live="polite"
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  autoSavePulse
                    ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300'
                }`}
              >
                <Shield className="h-3.5 w-3.5 text-emerald-500" />
                <span>Auto-saving every 1s</span>
                <span className="font-mono tabular-nums text-[11px] opacity-75">
                  ({savedChunksCount})
                </span>
              </div>
            )}
          </div>

          {micDisconnectedMsg && (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
              <MicOff className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{micDisconnectedMsg}</span>
            </div>
          )}

          {/* Collapsible Teleprompter / Script Notes Drawer */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50">
            <button
              type="button"
              onClick={() => setShowPrompter((v) => !v)}
              aria-expanded={showPrompter}
              className="flex w-full items-center justify-between px-4 py-2.5 text-left text-xs font-semibold text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
            >
              <span className="inline-flex items-center gap-2">
                <ScrollText className="h-4 w-4 text-blue-500" />
                <span>Teleprompter & Script Notes</span>
              </span>
              {showPrompter ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            {showPrompter && (
              <div className="border-t border-slate-200 dark:border-slate-800 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400">
                  <label className="inline-flex items-center gap-2">
                    <span>Font Size</span>
                    <input
                      type="range"
                      min={14}
                      max={32}
                      value={prompterFontSize}
                      onChange={(e) => setPrompterFontSize(Number(e.target.value))}
                      className="w-24"
                    />
                    <span className="font-mono tabular-nums">{prompterFontSize}px</span>
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <span>Auto-Scroll</span>
                    <input
                      type="range"
                      min={0}
                      max={5}
                      value={prompterSpeed}
                      onChange={(e) => setPrompterSpeed(Number(e.target.value))}
                      className="w-24"
                    />
                    <span className="font-mono tabular-nums">
                      {prompterSpeed === 0 ? 'Manual' : `${prompterSpeed}x`}
                    </span>
                  </label>
                </div>
                <div
                  ref={prompterBoxRef}
                  className="max-h-36 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D121C] p-3"
                >
                  <textarea
                    aria-label="Teleprompter script text"
                    value={prompterText}
                    onChange={(e) => setPrompterText(e.target.value)}
                    rows={3}
                    style={{ fontSize: `${prompterFontSize}px` }}
                    className="w-full resize-none bg-transparent leading-relaxed text-slate-900 dark:text-slate-100 focus:outline-none"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Live Scrolling Waveform + Peak/RMS Meter + Timer */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-3xl sm:text-4xl font-semibold tracking-tight tabular-nums text-slate-900 dark:text-white">
                  {formatDuration(elapsedSec, true)}
                </span>
                <span className={`text-xs ${volumeHelper.tone}`}>{volumeHelper.label}</span>
                {vadPaused && (
                  <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                    Waiting for voice...
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                <span>RMS {levelDb} dB</span>
                <span>Peak {peakDb} dB</span>
                {recordedBytes > 0 && <span>{formatFileSize(recordedBytes)}</span>}
              </div>
            </div>

            <div className="relative overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D121C]">
              <canvas
                ref={canvasRef}
                data-testid="live-recorder-canvas"
                className="block w-full h-28"
              />
              {status === 'countdown' && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-950/75 backdrop-blur-xs">
                  <span className="font-display text-6xl font-extrabold text-white tabular-nums">
                    {countdownVal}
                  </span>
                </div>
              )}
            </div>

            {/* Horizontal Peak Meter Bar */}
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
              <div
                className={`h-full transition-all duration-75 ${
                  peakDb > -3
                    ? 'bg-rose-500'
                    : levelDb < -44
                    ? 'bg-amber-500'
                    : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.max(2, Math.min(100, ((levelDb + 60) / 60) * 100))}%` }}
              />
            </div>

            {/* Max File Size Auto-Stop Progress Bar */}
            {maxSizeMb > 0 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  <span>Auto-Stop Limit: {maxSizeMb} MB</span>
                  <span>
                    {formatFileSize(recordedBytes)} / {maxSizeMb} MB ({Math.round(sizeLimitRatio)}%)
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                  <div
                    className="h-full bg-blue-500 transition-all"
                    style={{ width: `${sizeLimitRatio}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Primary Transport Controls */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 dark:border-slate-800/80 pt-5">
            <div className="flex flex-wrap items-center gap-3">
              {status === 'idle' ? (
                <button
                  type="button"
                  onClick={handleStartRecord}
                  className="inline-flex items-center gap-2.5 rounded-full bg-rose-600 px-7 py-3.5 text-sm font-bold text-white hover:bg-rose-700 transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#131822]"
                >
                  <span className="h-3 w-3 rounded-full bg-white" />
                  <span>Start Recording</span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handlePauseResume}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-5 py-3 text-sm font-semibold text-slate-900 dark:text-white hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                  >
                    {status === 'paused' ? (
                      <>
                        <Play className="h-4 w-4 fill-current" />
                        <span>Resume</span>
                      </>
                    ) : (
                      <>
                        <Pause className="h-4 w-4 fill-current" />
                        <span>Pause</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={stopRecordingAndFinalize}
                    className="inline-flex items-center gap-2 rounded-full bg-slate-900 dark:bg-white px-6 py-3 text-sm font-bold text-white dark:text-slate-900 hover:opacity-90 transition-opacity"
                  >
                    <Square className="h-3.5 w-3.5 fill-current" />
                    <span>Stop & Edit</span>
                  </button>
                </>
              )}
            </div>

            {/* Active Recording Smart Actions: Oops Retry + Bookmark */}
            {status === 'recording' || status === 'paused' ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleOopsRetry}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 transition-colors"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Oops! Retry Last Line</span>
                </button>

                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    aria-label="Optional bookmark label"
                    placeholder="Bookmark label..."
                    value={bookmarkInput}
                    onChange={(e) => setBookmarkInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleDropBookmark();
                    }}
                    className="w-32 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={handleDropBookmark}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                  >
                    <Flag className="h-3.5 w-3.5" />
                    <span>Drop Bookmark</span>
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleRoomCheck}
                disabled={checkingRoom}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-4 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-60"
              >
                <Volume2 className="h-4 w-4 text-blue-500" />
                <span>{checkingRoom ? 'Listening to room (2s)...' : '2-Second Room & Mic Check'}</span>
              </button>
            )}
          </div>

          {/* Live Recording Sound Control Rack — adjust audio AS IT RECORDS LIVE! */}
          <div
            data-testid="live-recording-controls"
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/75 dark:bg-slate-900/50"
          >
            <button
              type="button"
              onClick={() => setShowLiveControls((v) => !v)}
              aria-expanded={showLiveControls}
              className="flex w-full items-center justify-between px-4 py-2.5 text-left text-xs font-semibold text-slate-800 dark:text-slate-200"
            >
              <span className="inline-flex items-center gap-2">
                <Sliders className="h-4 w-4 text-emerald-500" />
                <span>Live Sound Controls (Adjust While Recording)</span>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                  {status === 'recording' ? 'LIVE ACTIVE' : 'READY'}
                </span>
              </span>
              {showLiveControls ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>

            {showLiveControls && (
              <div className="border-t border-slate-200 dark:border-slate-800 p-4 space-y-4">
                {/* Row 1: Mic Volume + Mute + Steady Voice Live + Quiet Room Hum */}
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-center">
                  <div className="sm:col-span-5 space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-700 dark:text-slate-300">
                        Live Mic Volume
                      </span>
                      <span className="font-mono tabular-nums text-slate-900 dark:text-white">
                        {liveControls.muted ? 'Muted' : `${Math.round(liveControls.inputGain * 100)}%`}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        aria-pressed={liveControls.muted}
                        onClick={() =>
                          setLiveControls((c) => ({ ...c, muted: !c.muted }))
                        }
                        className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
                          liveControls.muted
                            ? 'bg-rose-600 text-white'
                            : 'border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200'
                        }`}
                      >
                        {liveControls.muted ? 'Unmute' : 'Mute'}
                      </button>
                      <input
                        type="range"
                        aria-label="Live microphone volume"
                        min={0}
                        max={2}
                        step={0.05}
                        value={liveControls.muted ? 0 : liveControls.inputGain}
                        onChange={(e) =>
                          setLiveControls((c) => ({
                            ...c,
                            inputGain: Number(e.target.value),
                            muted: Number(e.target.value) === 0,
                          }))
                        }
                        className="w-full"
                      />
                    </div>
                  </div>

                  <div className="sm:col-span-7 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      aria-pressed={liveControls.steadyVoiceLeveler}
                      onClick={() =>
                        setLiveControls((c) => ({
                          ...c,
                          steadyVoiceLeveler: !c.steadyVoiceLeveler,
                        }))
                      }
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                        liveControls.steadyVoiceLeveler
                          ? 'border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                          : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      <Volume2 className="h-3.5 w-3.5" />
                      <span>Keep Voice Steady Live</span>
                    </button>

                    <button
                      type="button"
                      aria-pressed={liveControls.liveNoiseGate}
                      onClick={() =>
                        setLiveControls((c) => ({
                          ...c,
                          liveNoiseGate: !c.liveNoiseGate,
                        }))
                      }
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                        liveControls.liveNoiseGate
                          ? 'border-blue-500 bg-blue-500/15 text-blue-700 dark:text-blue-300'
                          : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      <Shield className="h-3.5 w-3.5" />
                      <span>Quiet Room Hum</span>
                    </button>

                    <button
                      type="button"
                      aria-pressed={liveControls.monitorEnabled}
                      onClick={() =>
                        setLiveControls((c) => ({
                          ...c,
                          monitorEnabled: !c.monitorEnabled,
                        }))
                      }
                      title="Use headphones so your speakers don't create echo."
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                        liveControls.monitorEnabled
                          ? 'border-violet-500 bg-violet-500/15 text-violet-700 dark:text-violet-300'
                          : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      <Headphones className="h-3.5 w-3.5" />
                      <span>Hear Myself</span>
                    </button>
                  </div>
                </div>

                {/* Row 2: Plain-English Live Tone Shaping (Voice Clarity, Reduce Rumble/Drums, Soften Hiss) */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border-t border-slate-200/70 dark:border-slate-800 pt-3">
                  <label className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="font-medium text-slate-700 dark:text-slate-300">
                        Voice Clarity
                      </span>
                      <span className="font-mono tabular-nums text-blue-600 dark:text-blue-400">
                        {liveControls.voicePresenceDb > 0 ? '+' : ''}
                        {liveControls.voicePresenceDb} dB
                      </span>
                    </div>
                    <input
                      type="range"
                      aria-label="Live voice clarity"
                      min={-12}
                      max={12}
                      step={1}
                      value={liveControls.voicePresenceDb}
                      onChange={(e) =>
                        setLiveControls((c) => ({
                          ...c,
                          voicePresenceDb: Number(e.target.value),
                        }))
                      }
                      className="w-full"
                    />
                  </label>

                  <label className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="font-medium text-slate-700 dark:text-slate-300">
                        Bass / Drums Low End
                      </span>
                      <span className="font-mono tabular-nums text-amber-600 dark:text-amber-400">
                        {liveControls.lowCutDb > 0 ? '+' : ''}
                        {liveControls.lowCutDb} dB
                      </span>
                    </div>
                    <input
                      type="range"
                      aria-label="Live bass and drums low end"
                      min={-18}
                      max={12}
                      step={1}
                      value={liveControls.lowCutDb}
                      onChange={(e) =>
                        setLiveControls((c) => ({
                          ...c,
                          lowCutDb: Number(e.target.value),
                        }))
                      }
                      className="w-full"
                    />
                  </label>

                  <label className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="font-medium text-slate-700 dark:text-slate-300">
                        Brightness / Hiss
                      </span>
                      <span className="font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                        {liveControls.brightnessDb > 0 ? '+' : ''}
                        {liveControls.brightnessDb} dB
                      </span>
                    </div>
                    <input
                      type="range"
                      aria-label="Live brightness and hiss trim"
                      min={-12}
                      max={12}
                      step={1}
                      value={liveControls.brightnessDb}
                      onChange={(e) =>
                        setLiveControls((c) => ({
                          ...c,
                          brightnessDb: Number(e.target.value),
                        }))
                      }
                      className="w-full"
                    />
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Room Check Diagnosis Result */}
          {roomResult && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-slate-50 dark:bg-slate-900/70 px-4 py-3 text-sm">
              <div className="flex items-center gap-2.5">
                {roomResult.recommendation === 'ready' ? (
                  <CheckCircle2 className="h-4.5 w-4.5 text-emerald-500 shrink-0" />
                ) : (
                  <AlertCircle className="h-4.5 w-4.5 text-amber-500 shrink-0" />
                )}
                <div>
                  <div className="font-medium text-slate-900 dark:text-white">
                    {roomResult.diagnosis}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                    Room floor: {roomResult.noiseFloorDb} dB · Peak: {roomResult.peakDb} dB
                  </div>
                </div>
              </div>
              {roomResult.sampleBlob && (
                <button
                  type="button"
                  onClick={handlePlayRoomTest}
                  disabled={playingTestAudio}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
                >
                  <Play className="h-3.5 w-3.5" />
                  <span>{playingTestAudio ? 'Playing test...' : 'Hear Mic Test'}</span>
                </button>
              )}
            </div>
          )}

          {/* Live Speech-to-Text Preview */}
          {(status === 'recording' || liveTranscript.length > 0) && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40 p-3.5">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-1.5">
                <span className="font-semibold text-slate-700 dark:text-slate-300">
                  Live Transcript Preview
                </span>
                <span>{speechSupported ? 'Browser Speech-to-Text active' : 'Manual notes available in Editor'}</span>
              </div>
              <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed min-h-[1.5rem]">
                {liveTranscript.map((s) => s.text).join(' ')}{' '}
                <span className="text-slate-400 italic">{interimTranscript}</span>
                {liveTranscript.length === 0 && !interimTranscript && (
                  <span className="text-slate-400">
                    {speechSupported
                      ? 'Start speaking to see live captions appear here...'
                      : 'Live speech recognition is unavailable in this browser — you can type or paste notes in Step 2.'}
                  </span>
                )}
              </p>
            </div>
          )}
        </section>

        {/* Right Column: Smart Assist Controls + Universal Import (4 cols) */}
        <aside className="lg:col-span-4 space-y-5">
          {/* Smart Recording Toggles */}
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-4">
            <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
              Smart Recording Helpers
            </h2>

            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                <label htmlFor="toggle-countdown" className="cursor-pointer">
                  3-2-1 Countdown
                </label>
                <Tooltip text="Gives you 3 seconds to get ready before recording starts." />
              </span>
              <input
                id="toggle-countdown"
                type="checkbox"
                checked={useCountdown}
                onChange={(e) => setUseCountdown(e.target.checked)}
                className="h-4 w-4 rounded accent-blue-600 cursor-pointer"
              />
            </div>

            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                <label htmlFor="toggle-timemachine" className="cursor-pointer">
                  Time Machine (10s Pre-Roll)
                </label>
                <Tooltip text="Keeps the last 10 seconds buffered while armed so hitting Record captures what was just said." />
              </span>
              <input
                id="toggle-timemachine"
                type="checkbox"
                disabled={status !== 'idle'}
                checked={timeMachineArmed}
                onChange={(e) => setTimeMachineArmed(e.target.checked)}
                className="h-4 w-4 rounded accent-blue-600 cursor-pointer"
              />
            </div>
            {timeMachineArmed && status === 'idle' && (
              <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 font-mono tabular-nums">
                <Clock className="h-3.5 w-3.5" />
                <span>Pre-roll armed: {timeMachineBufferedSec}s / 10s buffered</span>
              </div>
            )}

            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                  <label htmlFor="toggle-voice-activation" className="cursor-pointer">
                    Voice Activation
                  </label>
                  <Tooltip text="Automatically pauses recording if silence lasts longer than 2 seconds, and resumes the moment you speak." />
                </span>
                <input
                  id="toggle-voice-activation"
                  type="checkbox"
                  checked={voiceActivated}
                  onChange={(e) => setVoiceActivated(e.target.checked)}
                  className="h-4 w-4 rounded accent-blue-600 cursor-pointer"
                />
              </div>

              {voiceActivated && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-3 space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-700 dark:text-slate-300">
                      VAD Sensitivity
                    </span>
                    <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      {vadThresholdDb} dBFS · 2s hold
                    </span>
                  </div>
                  <div
                    role="group"
                    aria-label="Voice activation sensitivity level"
                    className="grid grid-cols-3 gap-1.5"
                  >
                    {(['low', 'medium', 'high'] as VadSensitivity[]).map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => {
                          setVadSensitivity(lvl);
                          setVadThresholdDb(VAD_SENSITIVITY_PRESETS[lvl].thresholdDb);
                        }}
                        className={`rounded-md px-2 py-1.5 text-xs font-semibold transition-colors ${
                          vadSensitivity === lvl
                            ? 'bg-blue-600 text-white'
                            : 'border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                        }`}
                      >
                        {VAD_SENSITIVITY_PRESETS[lvl].label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                    {VAD_SENSITIVITY_PRESETS[vadSensitivity].description}
                  </p>
                  {userMode === 'pro' && (
                    <div className="space-y-1 pt-1">
                      <div className="flex justify-between text-[11px] text-slate-500">
                        <span>Custom Threshold</span>
                        <span className="font-mono tabular-nums">{vadThresholdDb} dB</span>
                      </div>
                      <input
                        type="range"
                        aria-label="Custom VAD threshold dB"
                        min={-60}
                        max={-20}
                        step={1}
                        value={vadThresholdDb}
                        onChange={(e) => setVadThresholdDb(Number(e.target.value))}
                        className="w-full"
                      />
                    </div>
                  )}
                  {status === 'recording' && vadSilenceSec > 0 && !vadPaused && (
                    <div className="text-[11px] font-mono tabular-nums text-amber-600 dark:text-amber-400">
                      Silence detected: {vadSilenceSec.toFixed(1)}s / 2.0s auto-pause
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Max File Size Auto-Stop */}
            <div className="space-y-2 border-t border-slate-100 dark:border-slate-800 pt-3">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">
                <span>Max File Size Auto-Stop</span>
                <Tooltip text="Automatically stops and saves cleanly right before your recording exceeds a file size limit." />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[0, 5, 10, 25, 50].map((mb) => (
                  <button
                    key={mb}
                    type="button"
                    onClick={() => setMaxSizeMb(mb)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      maxSizeMb === mb
                        ? 'bg-blue-600 text-white'
                        : 'border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {mb === 0 ? 'Off' : `${mb} MB`}
                  </button>
                ))}
              </div>
              {userMode === 'pro' && (
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="number"
                    min={1}
                    max={500}
                    aria-label="Custom max size in MB"
                    value={customMaxMb}
                    onChange={(e) => setCustomMaxMb(e.target.value)}
                    className="w-20 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs font-mono tabular-nums"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const n = Number(customMaxMb);
                      if (n > 0) setMaxSizeMb(n);
                    }}
                    className="rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    Set Custom MB
                  </button>
                </div>
              )}
            </div>

            {/* Pro Mode Hardware Capture Options */}
            {userMode === 'pro' && (
              <div className="space-y-3 border-t border-slate-100 dark:border-slate-800 pt-3">
                <div className="text-xs font-semibold text-blue-600 dark:text-blue-400">
                  Pro Capture Settings
                </div>
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="rec-sr" className="text-slate-600 dark:text-slate-400">
                    Sample Rate
                  </label>
                  <select
                    id="rec-sr"
                    value={sampleRatePref}
                    onChange={(e) => setSampleRatePref(Number(e.target.value))}
                    className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono text-xs"
                  >
                    <option value={22050}>22.05 kHz</option>
                    <option value={44100}>44.1 kHz (CD)</option>
                    <option value={48000}>48 kHz (Video)</option>
                  </select>
                </div>
                <label className="flex items-center justify-between text-xs cursor-pointer">
                  <span className="text-slate-600 dark:text-slate-400">Capture Stereo (2 ch)</span>
                  <input
                    type="checkbox"
                    checked={stereoPref}
                    onChange={(e) => setStereoPref(e.target.checked)}
                    className="h-4 w-4 rounded accent-blue-600"
                  />
                </label>
              </div>
            )}
          </div>

          {/* Universal Drag & Drop Audio/Video Import */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) handleFileImport(f);
            }}
            className={`rounded-2xl border-2 border-dashed p-5 text-center transition-colors ${
              isDragOver
                ? 'border-blue-500 bg-blue-500/10'
                : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-[#131822]'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,video/*,.mp3,.wav,.ogg,.m4a,.webm,.flac,.mp4,.mov"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFileImport(f);
                e.target.value = '';
              }}
            />
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
              <Upload className="h-5 w-5" />
            </div>
            <h3 className="mt-3 font-display text-sm font-bold text-slate-900 dark:text-white">
              Import Audio or Video File
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Drop MP3, WAV, OGG, M4A, WebM, FLAC — or MP4/MOV video to clean its soundtrack.
            </p>
            <div className="mt-3 flex items-center justify-center gap-3 text-[11px] text-slate-400">
              <span className="inline-flex items-center gap-1">
                <FileAudio className="h-3.5 w-3.5" /> Audio
              </span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1">
                <FileVideo className="h-3.5 w-3.5" /> Video Audio Cleaner
              </span>
            </div>
            <button
              type="button"
              disabled={isImporting}
              onClick={() => fileInputRef.current?.click()}
              className="mt-4 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-4 py-2 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            >
              {isImporting ? 'Decoding file...' : 'Choose File from Device'}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
