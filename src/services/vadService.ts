import { linearToDb } from '../utils/audioDsp';

export type VadSensitivity = 'low' | 'medium' | 'high';

export const VAD_SENSITIVITY_PRESETS: Record<
  VadSensitivity,
  { thresholdDb: number; label: string; description: string }
> = {
  low: {
    thresholdDb: -32,
    label: 'Low',
    description: 'Best for noisy rooms — pauses unless you speak clearly into the mic.',
  },
  medium: {
    thresholdDb: -40,
    label: 'Medium',
    description: 'Balanced speech detection for typical home or office rooms.',
  },
  high: {
    thresholdDb: -48,
    label: 'High',
    description: 'Sensitive detection for quiet studios or soft-spoken voices.',
  },
};

export interface VadStateMachineOptions {
  thresholdDb: number;
  silenceHoldMs?: number; // Default 2000ms (2 seconds)
}

export type VadDecision = 'speaking' | 'waiting' | 'paused';

/**
 * Pure deterministic VAD state machine (easily unit-testable without AudioContext).
 * Tracks continuous silence duration and transitions to 'paused' once audio stays
 * below thresholdDb for more than silenceHoldMs (default 2000ms).
 */
export class VadStateMachine {
  private thresholdDb: number;
  private silenceHoldMs: number;
  private silenceStartedAtMs: number | null = null;
  private isPaused = false;

  constructor(options: VadStateMachineOptions) {
    this.thresholdDb = options.thresholdDb;
    this.silenceHoldMs = options.silenceHoldMs ?? 2000;
  }

  setThresholdDb(db: number): void {
    this.thresholdDb = db;
  }

  getThresholdDb(): number {
    return this.thresholdDb;
  }

  reset(): void {
    this.silenceStartedAtMs = null;
    this.isPaused = false;
  }

  evaluate(levelDb: number, nowMs: number): {
    state: VadDecision;
    shouldPause: boolean;
    shouldResume: boolean;
    silenceElapsedMs: number;
  } {
    if (levelDb >= this.thresholdDb) {
      const wasPaused = this.isPaused;
      this.silenceStartedAtMs = null;
      this.isPaused = false;
      return {
        state: 'speaking',
        shouldPause: false,
        shouldResume: wasPaused,
        silenceElapsedMs: 0,
      };
    }

    if (this.silenceStartedAtMs === null) {
      this.silenceStartedAtMs = nowMs;
    }

    const elapsed = Math.max(0, nowMs - this.silenceStartedAtMs);
    if (!this.isPaused && elapsed >= this.silenceHoldMs) {
      this.isPaused = true;
      return {
        state: 'paused',
        shouldPause: true,
        shouldResume: false,
        silenceElapsedMs: elapsed,
      };
    }

    return {
      state: this.isPaused ? 'paused' : 'waiting',
      shouldPause: false,
      shouldResume: false,
      silenceElapsedMs: elapsed,
    };
  }
}

export interface VoiceActivityDetectorOptions {
  analyser: AnalyserNode;
  thresholdDb?: number;
  silenceHoldMs?: number; // Default 2000ms
  pollIntervalMs?: number;
  onAutoPause: () => void;
  onAutoResume: () => void;
  onLevelUpdate?: (info: { rmsDb: number; silenceElapsedMs: number; state: VadDecision }) => void;
}

/**
 * Web Audio API Voice Activity Detection (VAD) service backed by AnalyserNode.
 * Monitors live time-domain RMS energy and automatically triggers pause when
 * signal remains below the configurable threshold for more than 2 seconds.
 */
export class VoiceActivityDetector {
  private analyser: AnalyserNode;
  private stateMachine: VadStateMachine;
  private pollIntervalMs: number;
  private onAutoPause: () => void;
  private onAutoResume: () => void;
  private onLevelUpdate?: VoiceActivityDetectorOptions['onLevelUpdate'];
  private timerId: number | null = null;
  private enabled = false;
  private timeDomainBuffer: Float32Array<ArrayBuffer>;

  constructor(options: VoiceActivityDetectorOptions) {
    this.analyser = options.analyser;
    this.stateMachine = new VadStateMachine({
      thresholdDb: options.thresholdDb ?? VAD_SENSITIVITY_PRESETS.medium.thresholdDb,
      silenceHoldMs: options.silenceHoldMs ?? 2000,
    });
    this.pollIntervalMs = options.pollIntervalMs ?? 60;
    this.onAutoPause = options.onAutoPause;
    this.onAutoResume = options.onAutoResume;
    this.onLevelUpdate = options.onLevelUpdate;
    this.timeDomainBuffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
  }

  setThresholdDb(db: number): void {
    this.stateMachine.setThresholdDb(db);
  }

  setSensitivity(sensitivity: VadSensitivity): void {
    this.stateMachine.setThresholdDb(VAD_SENSITIVITY_PRESETS[sensitivity].thresholdDb);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.stateMachine.reset();
    }
  }

  start(): void {
    if (this.timerId !== null) return;
    this.stateMachine.reset();
    this.timerId = window.setInterval(() => this.sample(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
    this.stateMachine.reset();
  }

  private sample(): void {
    this.analyser.getFloatTimeDomainData(this.timeDomainBuffer);
    let sumSq = 0;
    for (let i = 0; i < this.timeDomainBuffer.length; i++) {
      const s = this.timeDomainBuffer[i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, this.timeDomainBuffer.length));
    const rmsDb = Math.max(-80, Math.round(linearToDb(rms)));

    if (!this.enabled) {
      this.onLevelUpdate?.({ rmsDb, silenceElapsedMs: 0, state: 'speaking' });
      return;
    }

    const res = this.stateMachine.evaluate(rmsDb, performance.now());
    this.onLevelUpdate?.({
      rmsDb,
      silenceElapsedMs: res.silenceElapsedMs,
      state: res.state,
    });

    if (res.shouldPause) {
      this.onAutoPause();
    } else if (res.shouldResume) {
      this.onAutoResume();
    }
  }
}
