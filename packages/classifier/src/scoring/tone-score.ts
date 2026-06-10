import type { ToneIndicator, ToneSnapshot } from '../types';

// Pure tone scoring. Maps an acoustic snapshot to indicators + a weight.

const INDICATOR_WEIGHT: Record<ToneIndicator, number> = {
  'elevated-volume': 1.5,
  'elevated-pitch': 1,
  'multi-speaker': 1,
  'rapid-speech': 1,
  'silence-after-activity': 1,
  whisper: 0.5,
};

const ELEVATED_PITCH_HZ = 250;
const RAPID_SPEECH_SEGMENTS_PER_SEC = 3;

export interface ToneScoreResult {
  indicators: ToneIndicator[];
  weight: number;
}

export function scoreTone(snapshot: ToneSnapshot): ToneScoreResult {
  const indicators: ToneIndicator[] = [];

  if (snapshot.volumeBand === 'elevated') {
    indicators.push('elevated-volume');
  }
  if (snapshot.volumeBand === 'whisper') {
    indicators.push('whisper');
  }
  if (snapshot.pitchHz !== null && snapshot.pitchHz > ELEVATED_PITCH_HZ) {
    indicators.push('elevated-pitch');
  }
  if (snapshot.speakerCount >= 2) {
    indicators.push('multi-speaker');
  }
  if (snapshot.speechRate > RAPID_SPEECH_SEGMENTS_PER_SEC) {
    indicators.push('rapid-speech');
  }
  if (snapshot.silenceAfterActivity) {
    indicators.push('silence-after-activity');
  }

  const weight = indicators.reduce((sum, indicator) => sum + INDICATOR_WEIGHT[indicator], 0);
  return { indicators, weight };
}
