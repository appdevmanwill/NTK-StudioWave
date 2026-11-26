import {
  CheckCircle2,
  Download,
  Film,
  Gauge,
  Image as ImageIcon,
  Layers,
  Mail,
  MessageCircle,
  Mic,
  Music2,
  Pause,
  Play,
  Radio,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Video,
  HardDrive,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AudiogramStyle,
  AudioMetadata,
  EffectSettings,
  ExportFormat,
  ExportOptions,
  ImportedVideoRef,
  OverlayTrack,
  UserMode,
} from '../types/audio';
import {
  audioBackend,
  createAudioBufferFromChannels,
  extractChannels,
} from '../services/audioBackend';
import {
  applyDynamicsProcessorPCM,
  applyNoiseGatePCM,
  calculateBitrateForTargetSize,
  estimateFileSizeBytes,
  formatDuration,
  formatFileSize,
  isTrackEqActive,
} from '../utils/audioDsp';
import { MUSICAL_SCALES, applyAutoTunePCM } from '../utils/pitchCorrection';
import {
  createAudiogramParticles,
  renderAudiogramFrame,
} from '../utils/audiogramRenderer';
import { getPresetConfig, type WorkspaceConfig } from '../utils/workspaceConfig';
import { saveBlobToDevice, shareBlobFromDevice } from '../utils/platformFileSave';
import type { MainTrackControlState } from './TrackManagerPanel';
import { Tooltip } from './Tooltip';

interface ExportViewProps {
  userMode: UserMode;
  onToggleUserMode?: (mode: UserMode) => void;
  workspaceConfig?: WorkspaceConfig;
  onOpenCustomizer?: () => void;
  ecoMode?: boolean;
  buffer: AudioBuffer | null;
  effects: EffectSettings;
  overlayTracks: OverlayTrack[];
  mainTrackControl: MainTrackControlState;
  title: string;
  onChangeTitle: (t: string) => void;
  importedVideo: ImportedVideoRef | null;
  onSaveProjectFile?: () => void;
  onGoToRecord: () => void;
  onLoadSample: () => void;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
}

const BITRATES = [64, 96, 128, 192, 256, 320];
const TARGET_SIZE_PRESETS = [1, 5, 10, 25];

const FORMATS: Array<{ id: ExportFormat; label: string; badge: string; desc: string }> = [
  { id: 'mp3', label: 'MP3', badge: 'Universal', desc: 'Plays everywhere — WhatsApp, phones, podcasts' },
  { id: 'wav', label: 'WAV', badge: 'Lossless', desc: 'Uncompressed studio master for video editors' },
  { id: 'ogg', label: 'OGG', badge: 'Compact', desc: 'Open web format with high clarity at low sizes' },
  { id: 'm4a', label: 'M4A', badge: 'Apple / Podcast', desc: 'Modern AAC audio for iOS & podcast hosts' },
  { id: 'flac', label: 'FLAC', badge: 'Archival', desc: 'Lossless archival format with full fidelity' },
];

export function ExportView({
  userMode,
  onToggleUserMode,
  workspaceConfig,
  onOpenCustomizer,
  ecoMode = false,
  buffer,
  effects,
  overlayTracks,
  mainTrackControl,
  title,
  onChangeTitle,
  importedVideo,
  onSaveProjectFile,
  onGoToRecord,
  onLoadSample,
  onNotify,
}: ExportViewProps) {
  const cfg = workspaceConfig ?? getPresetConfig(userMode === 'pro' ? 'full-pro' : 'novice-office');
  const [format, setFormat] = useState<ExportFormat>('mp3');
  const [qualityMode, setQualityMode] = useState<'bitrate' | 'targetSize'>('bitrate');
  const [bitrateKbps, setBitrateKbps] = useState(192);
  const [targetSizeMb, setTargetSizeMb] = useState(5);
  const [sampleRate, setSampleRate] = useState(44100);
  const [channels, setChannels] = useState<1 | 2>(1);
  const [metadata, setMetadata] = useState<AudioMetadata>({
    title: title || 'NTK StudioWave Recording',
    artist: '',
    album: 'NTK StudioWave Studio',
    coverDataUrl: null,
  });

  // Export states
  const [isExporting, setIsExporting] = useState(false);
  const [lastExport, setLastExport] = useState<{
    blob: Blob;
    filename: string;
    sizeBytes: number;
  } | null>(null);

  // Audiogram states
  const [audiogramAspect, setAudiogramAspect] = useState<'9:16' | '1:1'>('9:16');
  const [audiogramTheme, setAudiogramTheme] = useState<'midnight' | 'sunrise' | 'studio'>('midnight');
  const [audiogramStyle, setAudiogramStyle] = useState<AudiogramStyle>('bars');
  const [previewAnimated, setPreviewAnimated] = useState(true);
  const [audiogramProgress, setAudiogramProgress] = useState<number | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // Video Replacement Export state
  const [videoExportProgress, setVideoExportProgress] = useState<number | null>(null);

  useEffect(() => {
    setMetadata((prev) => ({ ...prev, title }));
  }, [title]);

  const duration = buffer?.duration ?? 0;

  // Compute effective bitrate & estimated size
  const { effectiveBitrate, effectiveSampleRate, estimatedBytes, qualityHint } = useMemo(() => {
    if (qualityMode === 'targetSize') {
      const calc = calculateBitrateForTargetSize({
        durationSec: duration,
        targetSizeMb,
        format,
        channels,
      });
      const bytes = estimateFileSizeBytes({
        durationSec: duration,
        format,
        bitrateKbps: calc.recommendedBitrateKbps,
        sampleRate: calc.recommendedSampleRate,
        channels,
      });
      return {
        effectiveBitrate: calc.recommendedBitrateKbps,
        effectiveSampleRate: calc.recommendedSampleRate,
        estimatedBytes: bytes,
        qualityHint:
          format === 'wav' || format === 'flac'
            ? `Auto-selected ${Math.round(calc.recommendedSampleRate / 1000)} kHz to stay under ${targetSizeMb} MB`
            : `Auto-selected ${calc.recommendedBitrateKbps} kbps to fit neatly under ${targetSizeMb} MB`,
      };
    }

    const bytes = estimateFileSizeBytes({
      durationSec: duration,
      format,
      bitrateKbps,
      sampleRate,
      channels,
    });
    const hint =
      format === 'wav' || format === 'flac'
        ? 'Studio lossless quality — zero compression artifacts'
        : bitrateKbps <= 96
        ? 'Compact & fast — great for WhatsApp & Email'
        : bitrateKbps <= 192
        ? 'Crisp broadcast voice — ideal for Podcasts & YouTube'
        : 'Maximum clarity — great for music & mastering';

    return {
      effectiveBitrate: bitrateKbps,
      effectiveSampleRate: sampleRate,
      estimatedBytes: bytes,
      qualityHint: hint,
    };
  }, [bitrateKbps, channels, duration, format, qualityMode, sampleRate, targetSizeMb]);

  // Live Full-Canvas Animated Audiogram Preview (uses the exact same renderer as the video export!)
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext('2d');
    if (!g) return;

    const w = audiogramAspect === '9:16' ? 270 : 288;
    const h = audiogramAspect === '9:16' ? 480 : 288;
    const dpr = ecoMode ? 1 : Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    // Pre-extract lightweight real amplitude envelope from loaded audio so preview reacts to actual recording!
    const previewEnv = new Float32Array(120);
    if (buffer && buffer.length > 0) {
      const ch = buffer.getChannelData(0);
      const block = Math.max(1, Math.floor(ch.length / previewEnv.length));
      for (let b = 0; b < previewEnv.length; b++) {
        let sumSq = 0;
        const start = b * block;
        const end = Math.min(ch.length, start + block);
        const step = Math.max(1, Math.floor((end - start) / 64));
        let count = 0;
        for (let i = start; i < end; i += step) {
          sumSq += ch[i] * ch[i];
          count++;
        }
        previewEnv[b] = Math.min(1, Math.sqrt(sumSq / Math.max(1, count)) * 3.8);
      }
    } else {
      for (let b = 0; b < previewEnv.length; b++) {
        previewEnv[b] = 0.35 + 0.45 * Math.abs(Math.sin(b * 0.28));
      }
    }

    const freqData = new Uint8Array(64);
    const timeData = new Uint8Array(128);
    const peakCaps = new Float32Array(44);
    const particles = createAudiogramParticles(ecoMode ? 14 : 26);
    const totalDur = Math.min(20, Math.max(4, duration || 15));

    let coverImg: HTMLImageElement | null = null;
    if (metadata.coverDataUrl) {
      const img = new Image();
      img.onload = () => {
        coverImg = img;
      };
      img.src = metadata.coverDataUrl;
    }

    let rafId = 0;
    let lastRenderMs = 0;
    const minFrameGapMs = ecoMode ? 66 : 30; // ~15fps in Lite mode, ~33fps in standard
    const startMs = performance.now();

    const tick = (now: number) => {
      if (now - lastRenderMs >= minFrameGapMs) {
        lastRenderMs = now;
        const elapsed = previewAnimated ? ((now - startMs) / 1000) % totalDur : totalDur * 0.38;
        const progress = elapsed / totalDur;
        const envIdx = Math.min(previewEnv.length - 1, Math.floor(progress * previewEnv.length));
        const liveLevel = Math.max(0.18, previewEnv[envIdx]);

        // Populate realistic audio-reactive spectral & waveform preview bins from real recording energy
        for (let i = 0; i < freqData.length; i++) {
          const u = i / freqData.length;
          const shape = Math.exp(-u * 1.9);
          const motion =
            0.55 +
            0.45 *
              Math.sin(elapsed * (4.2 + i * 0.31) + i * 0.55) *
              Math.cos(elapsed * 2.1 - i * 0.22);
          freqData[i] = Math.max(14, Math.min(255, Math.round(liveLevel * shape * motion * 255)));
        }
        for (let i = 0; i < timeData.length; i++) {
          const wave =
            Math.sin((i / timeData.length) * Math.PI * 6 + elapsed * 9) * liveLevel * 0.7;
          timeData[i] = Math.max(0, Math.min(255, Math.round(128 + wave * 110)));
        }

        g.save();
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderAudiogramFrame({
          ctx: g,
          width: w,
          height: h,
          aspect: audiogramAspect,
          theme: audiogramTheme,
          style: audiogramStyle,
          title: metadata.title || 'NTK StudioWave Clip',
          artist: metadata.artist || 'NTK StudioWave Studio',
          coverImg,
          freqData,
          timeData,
          peakCaps,
          particles,
          elapsedSec: elapsed,
          totalDurationSec: totalDur,
          progress,
        });
        g.restore();
      }

      if (previewAnimated) {
        rafId = requestAnimationFrame(tick);
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [
    audiogramAspect,
    audiogramStyle,
    audiogramTheme,
    buffer,
    duration,
    ecoMode,
    metadata.artist,
    metadata.coverDataUrl,
    metadata.title,
    previewAnimated,
  ]);

  const applyGoalPreset = (
    preset: 'whatsapp' | 'podcast' | 'email' | 'video' | 'archival'
  ) => {
    if (preset === 'whatsapp') {
      setFormat('mp3');
      setQualityMode('targetSize');
      setTargetSizeMb(15);
      setChannels(1);
      setSampleRate(44100);
      onNotify('Applied WhatsApp / Chat preset (compact MP3 under 15 MB).', 'info');
    } else if (preset === 'podcast') {
      setFormat('mp3');
      setQualityMode('bitrate');
      setBitrateKbps(192);
      setChannels(1);
      setSampleRate(44100);
      onNotify('Applied Podcast Standard preset (192 kbps broadcast clarity).', 'info');
    } else if (preset === 'email') {
      setFormat('mp3');
      setQualityMode('targetSize');
      setTargetSizeMb(10);
      setChannels(1);
      onNotify('Applied Email Attachment preset (auto-fits under 10 MB).', 'info');
    } else if (preset === 'video') {
      setFormat('wav');
      setQualityMode('bitrate');
      setSampleRate(48000);
      setChannels(2);
      onNotify('Applied Video Editor Master preset (48 kHz lossless WAV).', 'info');
    } else {
      setFormat('flac');
      setQualityMode('bitrate');
      setSampleRate(44100);
      setChannels(2);
      onNotify('Applied Archival Lossless preset (FLAC).', 'info');
    }
  };

  const triggerDownload = (blob: Blob, filename: string) => {
    return saveBlobToDevice(blob, filename);
  };

  const getExportReadyBuffer = async (sourceBuffer: AudioBuffer): Promise<AudioBuffer> => {
    let mainProcessed = sourceBuffer;
    if (effects.noiseGate) {
      const gated = applyNoiseGatePCM(extractChannels(mainProcessed), mainProcessed.sampleRate, {
        thresholdDb: effects.noiseGateDb,
        floorGain: 0.02,
      });
      mainProcessed = createAudioBufferFromChannels(
        audioBackend.getAudioContext(),
        gated,
        mainProcessed.sampleRate
      );
    }
    if (effects.autoTune) {
      const tuned = applyAutoTunePCM(extractChannels(mainProcessed), mainProcessed.sampleRate, {
        key: effects.autoTuneKey,
        scale: effects.autoTuneScale,
        strength: effects.autoTuneStrength,
      });
      mainProcessed = createAudioBufferFromChannels(
        audioBackend.getAudioContext(),
        tuned,
        mainProcessed.sampleRate
      );
    }
    if (effects.dynamicsProcessor) {
      const leveled = applyDynamicsProcessorPCM(
        extractChannels(mainProcessed),
        mainProcessed.sampleRate,
        {
          enabled: true,
          thresholdDb: effects.dynamicsThresholdDb,
          kneeDb: 12,
          ratio: effects.dynamicsRatio,
          attackSec: 0.008,
          releaseSec: 0.16,
          makeupGainDb: effects.dynamicsMakeupDb,
          limiterCeilingDb: effects.limiterCeilingDb,
        }
      );
      mainProcessed = createAudioBufferFromChannels(
        audioBackend.getAudioContext(),
        leveled.channels,
        mainProcessed.sampleRate
      );
    }

    if (overlayTracks.length > 0) {
      return audioBackend.renderMultiTrack([
        {
          id: 'main-track',
          name: metadata.title || 'Main Track',
          buffer: mainProcessed,
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
      ]);
    }
    if (isTrackEqActive(mainTrackControl.eq)) {
      return audioBackend.renderMultiTrack([
        {
          id: 'main-track',
          name: metadata.title || 'Main Track',
          buffer: mainProcessed,
          gain: 1.0,
          pan: 0,
          muted: false,
          solo: false,
          offsetSec: 0,
          color: '#3b82f6',
          eq: mainTrackControl.eq,
          isMain: true,
        },
      ]);
    }
    return mainProcessed;
  };

  const handleExportAudio = async () => {
    if (!buffer) return;
    setIsExporting(true);
    try {
      const preparedBuf =
        overlayTracks.length > 0 ? await getExportReadyBuffer(buffer) : buffer;
      const opts: ExportOptions = {
        format,
        qualityMode,
        bitrateKbps: effectiveBitrate,
        targetSizeMb,
        sampleRate: effectiveSampleRate,
        channels: overlayTracks.length > 0 ? 2 : channels,
        metadata,
        noiseGate:
          overlayTracks.length > 0
            ? undefined
            : {
                enabled: effects.noiseGate,
                thresholdDb: effects.noiseGateDb,
                floorGain: 0.02,
              },
        autoTune:
          overlayTracks.length > 0
            ? undefined
            : {
                enabled: effects.autoTune,
                key: effects.autoTuneKey,
                scale: effects.autoTuneScale,
                strength: effects.autoTuneStrength,
              },
        mainEq: overlayTracks.length > 0 ? undefined : mainTrackControl.eq,
        dynamics:
          overlayTracks.length > 0
            ? effects.dynamicsProcessor
              ? {
                  // Final anti-clipping brickwall limiter on the combined multi-track master
                  enabled: true,
                  thresholdDb: -1,
                  kneeDb: 0,
                  ratio: 1.5,
                  attackSec: 0.002,
                  releaseSec: 0.08,
                  makeupGainDb: 0,
                  limiterCeilingDb: effects.limiterCeilingDb,
                }
              : undefined
            : {
                enabled: effects.dynamicsProcessor,
                thresholdDb: effects.dynamicsThresholdDb,
                kneeDb: 12,
                ratio: effects.dynamicsRatio,
                attackSec: 0.008,
                releaseSec: 0.16,
                makeupGainDb: effects.dynamicsMakeupDb,
                limiterCeilingDb: effects.limiterCeilingDb,
              },
      };
      const result = await audioBackend.encodeAudio(preparedBuf, opts);
      const safeBase = (metadata.title || 'NTK_StudioWave_Recording')
        .replace(/[^a-z0-9_\-\s]/gi, '')
        .trim()
        .replace(/\s+/g, '_');
      const filename = `${safeBase || 'NTK_StudioWave_Audio'}.${result.extension}`;
      const saveRes = await triggerDownload(result.blob, filename);
      setLastExport({ blob: result.blob, filename, sizeBytes: result.blob.size });
      onNotify(
        saveRes.location
          ? `Saved to ${saveRes.location} (${formatFileSize(result.blob.size)})`
          : `Exported ${filename} (${formatFileSize(result.blob.size)})!`,
        'success'
      );
    } catch {
      onNotify('Export failed. Try MP3 or WAV format.', 'error');
    } finally {
      setIsExporting(false);
    }
  };

  const handleNativeShare = async () => {
    if (!lastExport) return;
    const ok = await shareBlobFromDevice(
      lastExport.blob,
      lastExport.filename,
      metadata.title || 'NTK StudioWave Recording'
    );
    if (!ok) {
      await triggerDownload(lastExport.blob, lastExport.filename);
      onNotify('Saved file to device downloads folder.', 'info');
    }
  };

  const handleGenerateAudiogram = async () => {
    if (!buffer) return;
    setAudiogramProgress(1);
    try {
      const exportBuf = await getExportReadyBuffer(buffer);
      const blob = await audioBackend.generateAudiogram({
        buffer: exportBuf,
        title: metadata.title || 'NTK StudioWave Clip',
        artist: metadata.artist || 'Recorded in NTK StudioWave',
        aspect: audiogramAspect,
        theme: audiogramTheme,
        style: audiogramStyle,
        coverDataUrl: metadata.coverDataUrl,
        onProgress: setAudiogramProgress,
      });
      const safe = (metadata.title || 'audiogram').replace(/\s+/g, '_');
      const saveRes = await triggerDownload(
        blob,
        `${safe}_${audiogramAspect.replace(':', 'x')}_audiogram.webm`
      );
      onNotify(
        saveRes.location
          ? `Audiogram saved to ${saveRes.location}`
          : 'Audiogram social video exported!',
        'success'
      );
    } catch {
      onNotify('Could not export audiogram in this browser.', 'error');
    } finally {
      setAudiogramProgress(null);
    }
  };

  const handleReplaceVideoAudio = async () => {
    if (!buffer || !importedVideo) return;
    setVideoExportProgress(1);
    try {
      const exportBuf = await getExportReadyBuffer(buffer);
      const blob = await audioBackend.replaceVideoAudio(
        importedVideo.objectUrl,
        exportBuf,
        setVideoExportProgress
      );
      const base = importedVideo.name.replace(/\.[^.]+$/, '');
      const saveRes = await triggerDownload(blob, `${base}_cleaned_audio.webm`);
      onNotify(
        saveRes.location
          ? `Cleaned video saved to ${saveRes.location}`
          : 'Exported video with cleaned audio track synced!',
        'success'
      );
    } catch {
      onNotify('Could not mux cleaned audio back onto video.', 'error');
    } finally {
      setVideoExportProgress(null);
    }
  };

  if (!buffer) {
    return (
      <div className="mx-auto max-w-2xl rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-10 text-center space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
          <Download className="h-6 w-6" />
        </div>
        <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
          Nothing ready to export yet
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Record audio or load our 15-second sample to test MP3, WAV, FLAC, Target Size, and Audiogram export.
        </p>
        <div className="flex flex-wrap justify-center gap-3 pt-2">
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

  // CALM, ZERO-FEAR SIMPLE SAVE SCREEN (Novice Mode)
  if (!cfg.exportShowProOptions) {
    return (
      <div className="mx-auto max-w-5xl space-y-6" data-testid="simple-export-view">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            Save Your Audio
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Pick how you plan to use it, then click Download. Everything is created right on your device.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left: Simple 3-Option Audio Download */}
          <section
            className={`${
              cfg.exportShowAudiogram ? 'lg:col-span-7' : 'lg:col-span-12 max-w-2xl mx-auto w-full'
            } rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 sm:p-6 space-y-5`}
          >
            <div className="space-y-1.5">
              <label
                htmlFor="simple-export-title"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
              >
                File Name
              </label>
              <input
                id="simple-export-title"
                type="text"
                value={metadata.title}
                onChange={(e) => {
                  setMetadata((m) => ({ ...m, title: e.target.value }));
                  onChangeTitle(e.target.value);
                }}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3.5 py-2.5 text-sm font-medium text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="space-y-2.5">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Choose a simple quality option
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {[
                  {
                    id: 'whatsapp' as const,
                    label: 'Share in Chat',
                    sub: 'Small MP3 file',
                    active: format === 'mp3' && qualityMode === 'targetSize',
                  },
                  {
                    id: 'podcast' as const,
                    label: 'Podcast / YouTube',
                    sub: 'Clear MP3 (Recommended)',
                    active: format === 'mp3' && qualityMode === 'bitrate',
                  },
                  {
                    id: 'video' as const,
                    label: 'Highest Quality',
                    sub: 'Studio WAV file',
                    active: format === 'wav',
                  },
                ].map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => applyGoalPreset(opt.id)}
                    className={`rounded-xl border p-3.5 text-left transition-colors ${
                      opt.active
                        ? 'border-blue-600 bg-blue-50 dark:bg-blue-500/10 text-blue-800 dark:text-blue-200'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 hover:border-slate-300 dark:hover:border-slate-700'
                    }`}
                  >
                    <div className="text-sm font-bold">{opt.label}</div>
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{opt.sub}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 border-t border-slate-100 dark:border-slate-800 pt-4">
              <span>
                Format: <strong className="text-slate-800 dark:text-slate-200">{format.toUpperCase()}</strong>
              </span>
              <span className="font-mono tabular-nums">
                Length {formatDuration(duration, true)} · Est. ~{formatFileSize(estimatedBytes)}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={isExporting}
                onClick={handleExportAudio}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-3.5 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                <Download className="h-4 w-4" />
                <span>{isExporting ? 'Preparing file...' : `Download ${format.toUpperCase()} Audio`}</span>
              </button>

              {onSaveProjectFile && (
                <button
                  type="button"
                  onClick={onSaveProjectFile}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-3.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                >
                  <HardDrive className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span>Save Project (.swproj)</span>
                </button>
              )}
            </div>

            {lastExport && (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-800 dark:text-emerald-200">
                <span className="inline-flex items-center gap-1.5 font-medium truncate">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  Saved {lastExport.filename} ({formatFileSize(lastExport.sizeBytes)})
                </span>
                <button
                  type="button"
                  onClick={() => triggerDownload(lastExport.blob, lastExport.filename)}
                  className="font-semibold underline whitespace-nowrap"
                >
                  Download again
                </button>
              </div>
            )}
          </section>

          {/* Right: Friendly Video Clip (Audiogram) — shown when enabled in Customize Screen */}
          {cfg.exportShowAudiogram && (
            <aside className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-4">
              <div>
                <h2 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <Video className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  <span>Make a Shareable Video</span>
                </h2>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Turn your audio into a moving wave video for status updates or social posts.
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 p-0.5">
                  {(
                    [
                      { id: 'bars', label: 'Pulse Bars' },
                      { id: 'radial', label: 'Radial Halo' },
                      { id: 'wave', label: 'Smooth Wave' },
                    ] as const
                  ).map((st) => (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => setAudiogramStyle(st.id)}
                      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                        audiogramStyle === st.id
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => setAudiogramAspect((a) => (a === '9:16' ? '1:1' : '9:16'))}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  {audiogramAspect === '9:16' ? 'Vertical 9:16' : 'Square 1:1'}
                </button>
              </div>

              <div className="flex justify-center rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950 p-3">
                <canvas
                  ref={previewCanvasRef}
                  data-testid="audiogram-preview-canvas"
                  className="rounded-xl shadow-sm max-h-[290px] w-auto"
                />
              </div>

              <button
                type="button"
                disabled={audiogramProgress !== null}
                onClick={handleGenerateAudiogram}
                className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 dark:bg-white px-4 py-3 text-xs font-bold text-white dark:text-slate-900 hover:opacity-90 disabled:opacity-50"
              >
                <Video className="h-4 w-4" />
                <span>
                  {audiogramProgress !== null
                    ? `Creating Video (${audiogramProgress}%)...`
                    : 'Download Video Clip'}
                </span>
              </button>
            </aside>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-center text-xs text-slate-500 dark:text-slate-400">
          {onOpenCustomizer && (
            <button
              type="button"
              onClick={onOpenCustomizer}
              className="font-semibold text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400"
            >
              Customize Save Screen
            </button>
          )}
          {onToggleUserMode && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => onToggleUserMode('pro')}
                className="font-semibold text-blue-600 dark:text-blue-400 hover:underline"
              >
                Switch to Pro Mode (Custom kbps, FLAC, ID3)
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* One-Tap Goal Presets Bar */}
      <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white">
              Save &amp; Export Studio Audio
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Pick a one-tap destination preset or fine-tune format, bitrate, and exact target file size.
            </p>
          </div>
          <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
            Length: {formatDuration(duration, true)}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
          {[
            { id: 'whatsapp', label: 'WhatsApp / Chat', sub: 'Crisp MP3 < 15 MB', icon: MessageCircle },
            { id: 'podcast', label: 'Podcast Standard', sub: '192 kbps broadcast', icon: Radio },
            { id: 'email', label: 'Email Attachment', sub: 'Auto-fits < 10 MB', icon: Mail },
            { id: 'video', label: 'Video Editor Master', sub: '48 kHz lossless WAV', icon: Film },
            { id: 'archival', label: 'Archival Lossless', sub: 'Studio FLAC master', icon: HardDrive },
          ].map((p) => {
            const Icon = p.icon;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() =>
                  applyGoalPreset(p.id as 'whatsapp' | 'podcast' | 'email' | 'video' | 'archival')
                }
                className="flex flex-col items-start rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-3 text-left hover:border-blue-500 transition-colors"
              >
                <Icon className="h-4 w-4 text-blue-500 mb-1.5" />
                <span className="text-xs font-bold text-slate-900 dark:text-white">{p.label}</span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">{p.sub}</span>
              </button>
            );
          })}
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Audio Format + Dual Quality/Target Size + Metadata (7 cols) */}
        <section className="lg:col-span-7 space-y-5">
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-5">
            {/* Format Picker */}
            <div className="space-y-2.5">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Audio Format
              </div>
              <div className="grid grid-cols-5 gap-2">
                {FORMATS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFormat(f.id)}
                    className={`rounded-xl border px-2 py-2.5 text-center transition-colors ${
                      format === f.id
                        ? 'border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                        : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900/60'
                    }`}
                  >
                    <div className="font-display text-sm font-bold">{f.label}</div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                      {f.badge}
                    </div>
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {FORMATS.find((f) => f.id === format)?.desc}
              </p>
            </div>

            {/* Dual Quality & Size Control */}
            <div className="space-y-3 border-t border-slate-100 dark:border-slate-800 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                  <span>Quality & Size Control</span>
                  <Tooltip text="Choose a bitrate directly, or pick a Target File Size and let NTK StudioWave calculate the best bitrate automatically." />
                </span>
                <div
                  role="group"
                  aria-label="Quality selection mode"
                  className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 p-0.5"
                >
                  <button
                    type="button"
                    onClick={() => setQualityMode('bitrate')}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                      qualityMode === 'bitrate'
                        ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                        : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    Choose Bitrate
                  </button>
                  <button
                    type="button"
                    onClick={() => setQualityMode('targetSize')}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                      qualityMode === 'targetSize'
                        ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                        : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    Exact Target Size
                  </button>
                </div>
              </div>

              {qualityMode === 'bitrate' ? (
                <div className="space-y-2">
                  {format !== 'wav' && format !== 'flac' ? (
                    <div className="flex flex-wrap gap-1.5">
                      {BITRATES.map((br) => (
                        <button
                          key={br}
                          type="button"
                          onClick={() => setBitrateKbps(br)}
                          className={`rounded-lg px-3 py-1.5 font-mono text-xs font-semibold tabular-nums transition-colors ${
                            bitrateKbps === br
                              ? 'bg-blue-600 text-white'
                              : 'border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >
                          {br} kbps
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Lossless {format.toUpperCase()} uses full 16-bit PCM fidelity at{' '}
                      <span className="font-mono">{Math.round(effectiveSampleRate / 1000)} kHz</span>.
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {TARGET_SIZE_PRESETS.map((mb) => (
                      <button
                        key={mb}
                        type="button"
                        onClick={() => setTargetSizeMb(mb)}
                        className={`rounded-lg px-3 py-1.5 font-mono text-xs font-semibold tabular-nums ${
                          targetSizeMb === mb
                            ? 'bg-blue-600 text-white'
                            : 'border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                        }`}
                      >
                        {mb} MB
                      </button>
                    ))}
                    <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                      <span>Custom:</span>
                      <input
                        type="number"
                        min={0.5}
                        max={500}
                        step={0.5}
                        value={targetSizeMb}
                        onChange={(e) => setTargetSizeMb(Math.max(0.5, Number(e.target.value) || 1))}
                        className="w-20 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono text-xs tabular-nums"
                      />
                      <span>MB</span>
                    </label>
                  </div>
                </div>
              )}

              {/* Pro Mode Sample Rate & Channels */}
              {userMode === 'pro' && (
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <label className="space-y-1 text-xs">
                    <span className="text-slate-500">Sample Rate</span>
                    <select
                      value={sampleRate}
                      onChange={(e) => setSampleRate(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 font-mono text-xs"
                    >
                      <option value={22050}>22.05 kHz</option>
                      <option value={44100}>44.1 kHz</option>
                      <option value={48000}>48 kHz</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="text-slate-500">Channels</span>
                    <select
                      value={channels}
                      onChange={(e) => setChannels(Number(e.target.value) as 1 | 2)}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                    >
                      <option value={1}>Mono (Voice standard)</option>
                      <option value={2}>Stereo (Music / Wide)</option>
                    </select>
                  </label>
                </div>
              )}

              {/* Live Estimated File Size & Recommendation */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 px-4 py-3 text-xs">
                <span className="text-slate-600 dark:text-slate-300">{qualityHint}</span>
                <span className="font-mono font-bold tabular-nums text-slate-900 dark:text-white">
                  Est. Size: ~{formatFileSize(estimatedBytes)}
                </span>
              </div>

              {effects.noiseGate && (
                <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                  <ShieldCheck className="h-4 w-4 shrink-0" />
                  <span>
                    Real-Time Noise Gate active ({effects.noiseGateDb} dB) — background noise floor will be reduced automatically on export.
                  </span>
                </div>
              )}

              {effects.autoTune && (
                <div className="flex items-center gap-2 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-4 py-2.5 text-xs font-medium text-indigo-700 dark:text-indigo-300">
                  <Music2 className="h-4 w-4 shrink-0" />
                  <span>
                    Auto-Tune Pitch Correction active ({effects.autoTuneKey}{' '}
                    {MUSICAL_SCALES[effects.autoTuneScale].label}, {effects.autoTuneStrength}%) — vocal pitch will be corrected automatically on export.
                  </span>
                </div>
              )}

              {effects.dynamicsProcessor && (
                <div
                  data-testid="export-dynamics-badge"
                  className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs font-medium text-amber-700 dark:text-amber-300"
                >
                  <Gauge className="h-4 w-4 shrink-0" />
                  <span>
                    Dynamics Processor active ({effects.dynamicsRatio.toFixed(1)}:1 at{' '}
                    {effects.dynamicsThresholdDb} dB, limiter ceiling{' '}
                    {effects.limiterCeilingDb.toFixed(1)} dBFS) — volume levels will be evened and clipping prevented on export.
                  </span>
                </div>
              )}

              {(isTrackEqActive(mainTrackControl.eq) ||
                overlayTracks.some((t) => isTrackEqActive(t.eq))) && (
                <div
                  data-testid="export-eq-badge"
                  className="flex items-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-2.5 text-xs font-medium text-cyan-700 dark:text-cyan-300"
                >
                  <SlidersHorizontal className="h-4 w-4 shrink-0" />
                  <span>
                    Per-Track 3-Band Parametric EQ active — custom Low, Mid, and High shelf curves will be rendered cleanly on export.
                  </span>
                </div>
              )}

              {overlayTracks.length > 0 && (
                <div className="flex items-center gap-2 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-2.5 text-xs font-medium text-blue-700 dark:text-blue-300">
                  <Layers className="h-4 w-4 shrink-0" />
                  <span>
                    Multi-Track Overlay active ({overlayTracks.length + 1} tracks) — all active tracks with 3-Band EQ, gain, stereo pan, and solo/mute settings will be mixed down on export.
                  </span>
                </div>
              )}
            </div>

            {/* Metadata / Tag Editor */}
            <div className="space-y-3 border-t border-slate-100 dark:border-slate-800 pt-4">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Track Details & Cover Art
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="space-y-1 text-xs">
                  <span className="text-slate-500">Title</span>
                  <input
                    type="text"
                    value={metadata.title}
                    onChange={(e) => {
                      setMetadata({ ...metadata, title: e.target.value });
                      onChangeTitle(e.target.value);
                    }}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-white"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-slate-500">Artist / Speaker</span>
                  <input
                    type="text"
                    placeholder="Your name..."
                    value={metadata.artist}
                    onChange={(e) => setMetadata({ ...metadata, artist: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-white"
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-slate-500">Album / Show</span>
                  <input
                    type="text"
                    value={metadata.album}
                    onChange={(e) => setMetadata({ ...metadata, album: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-white"
                  />
                </label>
              </div>
              <div className="flex items-center gap-3">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
                  <ImageIcon className="h-3.5 w-3.5 text-blue-500" />
                  <span>{metadata.coverDataUrl ? 'Change Cover Image' : 'Add Optional Cover Image'}</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      const reader = new FileReader();
                      reader.onload = () =>
                        setMetadata((m) => ({ ...m, coverDataUrl: String(reader.result) }));
                      reader.readAsDataURL(f);
                    }}
                  />
                </label>
                {metadata.coverDataUrl && (
                  <img
                    src={metadata.coverDataUrl}
                    alt="Track cover preview"
                    className="h-9 w-9 rounded-md object-cover border border-slate-200 dark:border-slate-700"
                  />
                )}
              </div>
            </div>

            {/* Primary Download + Web Share Actions */}
            <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 dark:border-slate-800 pt-4">
              <button
                type="button"
                disabled={isExporting}
                onClick={handleExportAudio}
                className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                <span>
                  {isExporting
                    ? `Encoding ${format.toUpperCase()}...`
                    : `Export ${format.toUpperCase()} Audio`}
                </span>
              </button>

              {lastExport && (
                <button
                  type="button"
                  onClick={handleNativeShare}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 text-sm font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <Share2 className="h-4 w-4 text-blue-500" />
                  <span>Share to WhatsApp / Email / Drive</span>
                </button>
              )}
            </div>

            {lastExport && (
              <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                <CheckCircle2 className="h-4 w-4" />
                <span>
                  Ready: {lastExport.filename} ({formatFileSize(lastExport.sizeBytes)})
                </span>
              </div>
            )}
          </div>

          {/* Video Audio Replacement Export Card (shown when user imported a video) */}
          {importedVideo && (
            <div className="rounded-2xl border border-blue-500/40 bg-blue-500/8 p-5 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <Video className="h-4 w-4 text-blue-500" />
                    <span>Video Audio Replacement Export</span>
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
                    Re-attach your newly cleaned studio audio right back onto "{importedVideo.name}".
                  </p>
                </div>
                <button
                  type="button"
                  disabled={videoExportProgress !== null}
                  onClick={handleReplaceVideoAudio}
                  className="rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
                >
                  {videoExportProgress !== null
                    ? `Rendering Video ${videoExportProgress}%`
                    : 'Export Cleaned Video'}
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Right: One-Click Audiogram Social Video Exporter (5 cols) */}
        <aside className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-5 space-y-4">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Film className="h-4.5 w-4.5 text-blue-500" />
              <span>One-Click Audiogram Video</span>
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Turn your audio into a shareable vertical (Reels / TikTok / WhatsApp Status) or square social video with animated waveform bars.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 p-0.5">
              {(['9:16', '1:1'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAudiogramAspect(a)}
                  className={`rounded-md px-3 py-1 text-xs font-semibold ${
                    audiogramAspect === a
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {a === '9:16' ? '9:16 Vertical' : '1:1 Square'}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5">
              {(['midnight', 'sunrise', 'studio'] as const).map((th) => (
                <button
                  key={th}
                  type="button"
                  onClick={() => setAudiogramTheme(th)}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium capitalize ${
                    audiogramTheme === th
                      ? 'border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-300'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {th}
                </button>
              ))}
            </div>
          </div>

          {/* Animation Style Picker + Live Preview Toggle */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              role="group"
              aria-label="Audiogram animation style"
              className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 p-0.5"
            >
              {(
                [
                  { id: 'bars', label: 'Pulse Bars' },
                  { id: 'radial', label: 'Radial Halo' },
                  { id: 'wave', label: 'Smooth Wave' },
                ] as const
              ).map((st) => (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => setAudiogramStyle(st.id)}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                    audiogramStyle === st.id
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {st.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setPreviewAnimated((v) => !v)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {previewAnimated ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              <span>{previewAnimated ? 'Pause Preview' : 'Animate Preview'}</span>
            </button>
          </div>

          <div className="flex justify-center rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950 p-4">
            <canvas
              ref={previewCanvasRef}
              data-testid="audiogram-preview-canvas"
              className="rounded-xl shadow-md max-h-[340px] w-auto"
            />
          </div>

          <button
            type="button"
            disabled={audiogramProgress !== null}
            onClick={handleGenerateAudiogram}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 dark:bg-white px-4 py-3 text-xs font-bold text-white dark:text-slate-900 hover:opacity-90 disabled:opacity-50"
          >
            <Video className="h-4 w-4" />
            <span>
              {audiogramProgress !== null
                ? `Rendering Animated Video (${audiogramProgress}%)...`
                : `Export ${audiogramAspect} Animated Audiogram`}
            </span>
          </button>
        </aside>
      </div>
    </div>
  );
}
