import { Download, Loader2, Play, Sliders, Sparkles, Square, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { encodeWavPCM } from '../../utils/audioDsp';
import type { NtkRecordingItem, NtkSeparatedStems, NtkStemGains } from '../types';
import { decodeBlobToAudioBuffer, encodeAudioBufferToMp3Blob } from '../services/ntkAudioEngine';
import { ntkVoiceApi } from '../services/ntkVoiceApi';
import {
  downsampleChannelsForPreview,
  splitFourStemsRuleBasedPCM,
  triggerFileDownload,
  uint8ToBase64,
} from '../utils/ntkAudioUtils';

interface StemMixerPanelProps {
  recording: NtkRecordingItem;
  stemConfigured: boolean;
  onSaveStems: (stems: NtkSeparatedStems) => Promise<void>;
  onOpenManage: () => void;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
}

type StemKey = 'vocals' | 'drums' | 'bass' | 'other';

const STEM_META: Array<{ key: StemKey; label: string; hint: string; color: string }> = [
  { key: 'vocals', label: 'Vocals', hint: 'Spoken & lead voices', color: 'bg-blue-600' },
  { key: 'drums', label: 'Drums', hint: 'Percussion & beats', color: 'bg-rose-500' },
  { key: 'bass', label: 'Bass', hint: 'Low bass & rumble', color: 'bg-amber-500' },
  { key: 'other', label: 'Other Instruments', hint: 'Keys, guitar, ambient', color: 'bg-emerald-600' },
];

export function StemMixerPanel({
  recording,
  stemConfigured,
  onSaveStems,
  onOpenManage,
  onNotify,
}: StemMixerPanelProps) {
  const [separating, setSeparating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [gains, setGains] = useState<NtkStemGains>({
    vocals: 1,
    drums: 1,
    bass: 1,
    other: 1,
    muted: { vocals: false, drums: false, bass: false, other: false },
    solo: null,
  });

  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodesRef = useRef<Partial<Record<StemKey, GainNode>>>({});
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const decodedStemsRef = useRef<Partial<Record<StemKey, AudioBuffer>>>({});

  const stopPlayback = () => {
    sourcesRef.current.forEach((s) => {
      try {
        s.stop();
      } catch {
        // ignore
      }
    });
    sourcesRef.current = [];
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
    gainNodesRef.current = {};
    setIsPlaying(false);
  };

  useEffect(() => {
    return () => stopPlayback();
  }, [recording.id]);

  // Apply live gain/mute/solo changes immediately while playing
  useEffect(() => {
    (['vocals', 'drums', 'bass', 'other'] as StemKey[]).forEach((k) => {
      const node = gainNodesRef.current[k];
      if (!node || !audioCtxRef.current) return;
      const audible = !gains.muted[k] && (gains.solo === null || gains.solo === k);
      node.gain.setTargetAtTime(audible ? gains[k] : 0, audioCtxRef.current.currentTime, 0.02);
    });
  }, [gains]);

  const effectiveGain = (k: StemKey): number => {
    const audible = !gains.muted[k] && (gains.solo === null || gains.solo === k);
    return audible ? gains[k] : 0;
  };

  const handleSeparate = async () => {
    setSeparating(true);
    try {
      const buf = await decodeBlobToAudioBuffer(recording.audioBlob);
      const rawChs: Float32Array[] = [];
      for (let c = 0; c < buf.numberOfChannels; c++) rawChs.push(buf.getChannelData(c));

      // Keep 4-track stem separation lightweight for 1 GB RAM devices when clips exceed 45s
      const prepared =
        buf.duration > 45
          ? downsampleChannelsForPreview(rawChs, buf.sampleRate, 22050)
          : { channels: rawChs, sampleRate: buf.sampleRate };

      const stemsPcm = splitFourStemsRuleBasedPCM(prepared.channels, prepared.sampleRate);
      const toWavDataUrl = (stemChs: Float32Array[]) => {
        const bytes = encodeWavPCM(stemChs, prepared.sampleRate);
        return `data:audio/wav;base64,${uint8ToBase64(bytes)}`;
      };

      const nextStems: NtkSeparatedStems = {
        vocals: toWavDataUrl(stemsPcm.vocals),
        drums: toWavDataUrl(stemsPcm.drums),
        bass: toWavDataUrl(stemsPcm.bass),
        other: toWavDataUrl(stemsPcm.other),
        source: 'offline-rule-based',
        createdAt: Date.now(),
      };
      await onSaveStems(nextStems);
      decodedStemsRef.current = {};
      onNotify(
        '4-track stems separated locally offline! Adjust the faders to isolate or lower any track.',
        'success'
      );
    } catch {
      onNotify('Could not separate stems locally from this audio clip.', 'error');
    } finally {
      setSeparating(false);
    }
  };

  const handleSeparateCloud = async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      onNotify('You are offline — use the built-in 100% offline rule-based stem split instead.', 'info');
      return;
    }
    setSeparating(true);
    try {
      const buf = await decodeBlobToAudioBuffer(recording.audioBlob);
      const chs: Float32Array[] = [];
      for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
      const wavBytes = encodeWavPCM(chs, buf.sampleRate);
      const res = await ntkVoiceApi.separateStems({
        audioBase64: uint8ToBase64(wavBytes),
        mimeType: 'audio/wav',
      });
      const nextStems: NtkSeparatedStems = {
        ...res.stems,
        source: res.source,
        createdAt: Date.now(),
      };
      await onSaveStems(nextStems);
      decodedStemsRef.current = {};
      onNotify('Cloud AI stems separated! Adjust the faders to isolate or lower any track.', 'success');
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'Optional Cloud stem separation failed. Built-in offline split still works.',
        'warning'
      );
    } finally {
      setSeparating(false);
    }
  };

  const loadDecodedStems = async (): Promise<Partial<Record<StemKey, AudioBuffer>>> => {
    if (!recording.stems) return {};
    const out: Partial<Record<StemKey, AudioBuffer>> = { ...decodedStemsRef.current };
    for (const k of ['vocals', 'drums', 'bass', 'other'] as StemKey[]) {
      if (out[k]) continue;
      const src = recording.stems[k];
      if (!src) continue;
      const res = await fetch(src);
      const blob = await res.blob();
      out[k] = await decodeBlobToAudioBuffer(blob);
    }
    decodedStemsRef.current = out;
    return out;
  };

  const handleTogglePlay = async () => {
    if (isPlaying) {
      stopPlayback();
      return;
    }
    if (!recording.stems) return;
    try {
      const buffers = await loadDecodedStems();
      const entries = Object.entries(buffers) as Array<[StemKey, AudioBuffer]>;
      if (entries.length === 0) {
        onNotify('No playable stem audio tracks were returned by the stem endpoint.', 'warning');
        return;
      }
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const startedSources: AudioBufferSourceNode[] = [];
      let endedCount = 0;

      for (const [k, buf] of entries) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const gn = ctx.createGain();
        gn.gain.value = effectiveGain(k);
        src.connect(gn);
        gn.connect(ctx.destination);
        src.onended = () => {
          endedCount++;
          if (endedCount >= entries.length) stopPlayback();
        };
        gainNodesRef.current[k] = gn;
        startedSources.push(src);
      }
      const startAt = ctx.currentTime + 0.04;
      startedSources.forEach((s) => s.start(startAt));
      sourcesRef.current = startedSources;
      setIsPlaying(true);
    } catch {
      onNotify('Could not decode stem tracks for playback.', 'error');
      stopPlayback();
    }
  };

  const handleExportCustomMix = async (format: 'wav' | 'mp3') => {
    if (!recording.stems) return;
    setExporting(true);
    try {
      const buffers = await loadDecodedStems();
      const entries = Object.entries(buffers) as Array<[StemKey, AudioBuffer]>;
      if (entries.length === 0) throw new Error('No stem buffers available.');
      const sr = entries[0][1].sampleRate;
      const maxLen = Math.max(...entries.map(([, b]) => b.length));
      const chCount = Math.max(...entries.map(([, b]) => b.numberOfChannels));

      const offline = new OfflineAudioContext(chCount, maxLen, sr);
      for (const [k, buf] of entries) {
        const src = offline.createBufferSource();
        src.buffer = buf;
        const gn = offline.createGain();
        gn.gain.value = effectiveGain(k);
        src.connect(gn);
        gn.connect(offline.destination);
        src.start(0);
      }
      const rendered = await offline.startRendering();
      const safe = (recording.title || 'custom-mix').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40);
      if (format === 'mp3') {
        triggerFileDownload(encodeAudioBufferToMp3Blob(rendered, 160), `${safe}_stems_mix.mp3`);
      } else {
        const chs: Float32Array[] = [];
        for (let c = 0; c < rendered.numberOfChannels; c++) chs.push(rendered.getChannelData(c));
        const wav = encodeWavPCM(chs, rendered.sampleRate);
        const copy = new Uint8Array(wav.length);
        copy.set(wav);
        triggerFileDownload(new Blob([copy.buffer], { type: 'audio/wav' }), `${safe}_stems_mix.wav`);
      }
      onNotify(`Exported custom 4-track stem mix (${format.toUpperCase()}).`, 'success');
    } catch {
      onNotify('Could not export custom stem mix.', 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      data-testid="ntk-stem-mixer"
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 p-4 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
            <Sliders className="h-4 w-4 text-blue-600" />
            <span>4-Track Sound &amp; Stem Mixer (Offline Rule-Based)</span>
          </h4>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Isolate Vocals, Drums, Bass &amp; Other Instruments 100% locally offline (no internet or API key required).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={separating}
            onClick={handleSeparate}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {separating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sliders className="h-3.5 w-3.5" />
            )}
            <span>{recording.stems ? 'Re-Split Offline' : 'Split 4 Stems (Offline)'}</span>
          </button>
          {stemConfigured && (
            <button
              type="button"
              disabled={separating}
              onClick={handleSeparateCloud}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 disabled:opacity-60"
            >
              <Sparkles className="h-3.5 w-3.5 text-blue-600" />
              <span>Optional Cloud AI Split</span>
            </button>
          )}
        </div>
      </div>

      {/* 4 Stem Faders (always visible so users see the mixer layout clearly) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {STEM_META.map((stem) => {
          const val = gains[stem.key];
          const muted = gains.muted[stem.key];
          const soloed = gains.solo === stem.key;
          return (
            <div
              key={stem.key}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131822] p-3 space-y-2.5"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${stem.color}`} />
                  <div>
                    <div className="text-xs font-bold text-slate-900 dark:text-white">
                      {stem.label}
                    </div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">
                      {stem.hint}
                    </div>
                  </div>
                </div>
                <span className="font-mono text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                  {Math.round(val * 100)}%
                </span>
              </div>

              <input
                type="range"
                aria-label={`${stem.label} volume`}
                min={0}
                max={1.5}
                step={0.05}
                value={val}
                onChange={(e) => setGains({ ...gains, [stem.key]: Number(e.target.value) })}
                className="w-full accent-blue-600"
              />

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    setGains({
                      ...gains,
                      muted: { ...gains.muted, [stem.key]: !muted },
                    })
                  }
                  className={`flex-1 inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold ${
                    muted
                      ? 'border-rose-500 bg-rose-500 text-white'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
                  <span>{muted ? 'Muted' : 'Mute'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setGains({ ...gains, solo: soloed ? null : stem.key })}
                  className={`flex-1 rounded-lg border px-2 py-1 text-[11px] font-semibold ${
                    soloed
                      ? 'border-amber-500 bg-amber-500 text-white'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  Solo
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {recording.stems ? (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <button
            type="button"
            onClick={handleTogglePlay}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-white px-3.5 py-2 text-xs font-semibold text-white dark:text-slate-900"
          >
            {isPlaying ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            <span>{isPlaying ? 'Stop Stem Preview' : 'Play Custom Stem Mix'}</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={exporting}
              onClick={() => handleExportCustomMix('wav')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export Mix WAV</span>
            </button>
            <button
              type="button"
              disabled={exporting}
              onClick={() => handleExportCustomMix('mp3')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export Mix MP3</span>
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Click <strong>Split 4 Stems (Offline)</strong> above to isolate Vocals, Drums, Bass, and Other Instruments right on your device.
          {!stemConfigured && (
            <>
              {' '}
              (Or optionally connect an external Cloud HTDemucs Space in{' '}
              <button type="button" onClick={onOpenManage} className="underline font-semibold text-blue-600 dark:text-blue-400">
                Manage
              </button>
              .)
            </>
          )}
        </p>
      )}
    </div>
  );
}
