import { log } from '@/lib/log';
import type { ToneSnapshot, VolumeBand } from '@blackbox/classifier';

// Browser-only, stateful acoustic analyzer. Pulls from the EXISTING capture
// MediaStream (no second getUserMedia). All thresholds are heuristic and tuned
// for descriptive context, not precision — the snapshot is consumed by the pure
// tone scorer in the classifier package.

const SAMPLE_INTERVAL_MS = 200;
const WINDOW_MS = 3000;
const WINDOW_FRAMES = Math.round(WINDOW_MS / SAMPLE_INTERVAL_MS);

const VOICE_RMS_THRESHOLD = 0.015;
const SILENCE_RMS = 0.01;
const WHISPER_RMS_CEIL = 0.045;
const ELEVATED_RMS_FLOOR = 0.12;

const SPEECH_FOR_SILENCE_MS = 10_000;
const SILENCE_AFTER_MS = 5_000;
const SPEAKER_PITCH_SPLIT_HZ = 165;
const SPEAKER_PITCH_GAP_HZ = 40;

interface Frame {
  rms: number;
  pitch: number | null;
  voiced: boolean;
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function computeRms(buffer: Float32Array): number {
  let sumSquares = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const sample = buffer[i]!;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / buffer.length);
}

/** Autocorrelation pitch estimate (fundamental frequency) or null if unvoiced. */
function estimatePitch(buffer: Float32Array, sampleRate: number): number | null {
  const minLag = Math.floor(sampleRate / 500); // up to 500 Hz
  const maxLag = Math.floor(sampleRate / 70); // down to 70 Hz
  let bestLag = -1;
  let bestCorrelation = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0;
    for (let i = 0; i < buffer.length - lag; i += 1) {
      correlation += buffer[i]! * buffer[i + lag]!;
    }
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }
  if (bestLag <= 0 || bestCorrelation < 0.01) {
    return null;
  }
  return sampleRate / bestLag;
}

/** Rough speaker-count estimate from the spread of voiced pitches. */
function estimateSpeakerCount(pitches: number[], voicedRatio: number): number {
  if (voicedRatio < 0.1 || pitches.length === 0) {
    return 0;
  }
  const low = pitches.filter((p) => p < SPEAKER_PITCH_SPLIT_HZ);
  const high = pitches.filter((p) => p >= SPEAKER_PITCH_SPLIT_HZ);
  if (low.length >= 2 && high.length >= 2 && median(high) - median(low) > SPEAKER_PITCH_GAP_HZ) {
    return 2;
  }
  return 1;
}

function classifyVolume(avgRms: number, voicedRatio: number): VolumeBand {
  if (avgRms < SILENCE_RMS) {
    return 'silent';
  }
  if (avgRms < WHISPER_RMS_CEIL && voicedRatio > 0.1) {
    return 'whisper';
  }
  if (avgRms >= ELEVATED_RMS_FLOOR) {
    return 'elevated';
  }
  return 'conversational';
}

export class ToneAnalyzer {
  private readonly stream: MediaStream;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private timer: number | null = null;
  private timeBuffer = new Float32Array(0);
  private frames: Frame[] = [];

  // Cumulative state for silence-after-activity detection.
  private speechMsAccum = 0;
  private lastVoiceTs = 0;
  private lastSampleTs = 0;

  constructor(stream: MediaStream) {
    this.stream = stream;
  }

  start(): void {
    try {
      const Ctor =
        window.AudioContext ??
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        log.error('AudioContext unavailable; tone analysis disabled');
        return;
      }
      this.context = new Ctor();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.timeBuffer = new Float32Array(this.analyser.fftSize);
      this.source = this.context.createMediaStreamSource(this.stream);
      this.source.connect(this.analyser);
      this.timer = window.setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    } catch (error) {
      log.error('tone analyzer start failed', error);
    }
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.source?.disconnect();
    } catch (error) {
      log.error('tone analyzer disconnect failed', error);
    }
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.analyser = null;
    this.source = null;
    this.frames = [];
  }

  private sample(): void {
    if (!this.analyser || !this.context) {
      return;
    }
    this.analyser.getFloatTimeDomainData(this.timeBuffer);
    const rms = computeRms(this.timeBuffer);
    const voiced = rms > VOICE_RMS_THRESHOLD;
    const pitch = voiced ? estimatePitch(this.timeBuffer, this.context.sampleRate) : null;

    this.frames.push({ rms, pitch, voiced });
    while (this.frames.length > WINDOW_FRAMES) {
      this.frames.shift();
    }

    const now = Date.now();
    const delta = this.lastSampleTs === 0 ? SAMPLE_INTERVAL_MS : now - this.lastSampleTs;
    this.lastSampleTs = now;
    if (voiced) {
      this.speechMsAccum += delta;
      this.lastVoiceTs = now;
    }
  }

  getSnapshot(): ToneSnapshot {
    const now = Date.now();
    if (this.frames.length === 0) {
      return {
        timestamp: now,
        rms: 0,
        volumeBand: 'silent',
        pitchHz: null,
        speechRate: 0,
        speakerCount: 0,
        silenceAfterActivity: false,
      };
    }

    const avgRms = mean(this.frames.map((frame) => frame.rms));
    const voicedFrames = this.frames.filter((frame) => frame.voiced);
    const voicedRatio = voicedFrames.length / this.frames.length;
    const pitches = voicedFrames
      .map((frame) => frame.pitch)
      .filter((pitch): pitch is number => pitch !== null);

    // Speech rate: voiced onsets per second across the window.
    let onsets = 0;
    for (let i = 1; i < this.frames.length; i += 1) {
      if (this.frames[i]!.voiced && !this.frames[i - 1]!.voiced) {
        onsets += 1;
      }
    }
    const windowSeconds = (this.frames.length * SAMPLE_INTERVAL_MS) / 1000;
    const speechRate = windowSeconds > 0 ? onsets / windowSeconds : 0;

    const silenceAfterActivity =
      this.speechMsAccum > SPEECH_FOR_SILENCE_MS &&
      this.lastVoiceTs > 0 &&
      now - this.lastVoiceTs > SILENCE_AFTER_MS;

    return {
      timestamp: now,
      rms: avgRms,
      volumeBand: classifyVolume(avgRms, voicedRatio),
      pitchHz: pitches.length > 0 ? median(pitches) : null,
      speechRate,
      speakerCount: estimateSpeakerCount(pitches, voicedRatio),
      silenceAfterActivity,
    };
  }
}
