/**
 * Audio waveform peaks, computed on this device from the already-decrypted recording.
 *
 * IN MEMORY, AND NOWHERE ELSE. The input is the same Blob the player is using — bytes that
 * were decrypted in this tab and are released when the screen closes. Nothing is written to
 * disk, nothing is cached, and no peak data outlives the review. A waveform persisted to
 * storage would be a lasting, unencrypted trace of the recording's shape.
 *
 * IT MUST NEVER BE LOAD-BEARING. A waveform is a convenience for scrubbing; it is not the
 * evidence. Decoding can legitimately fail — a codec the browser will not decode, a partial
 * final segment, a device refusing an AudioContext — and every failure path returns null so
 * the transport keeps working without it. Losing the picture must never cost her the audio.
 */

/** Peak amplitudes, 0..1, one per horizontal slot. */
export type Waveform = Float32Array;

/**
 * Decode and reduce to `buckets` peaks.
 *
 * Returns null rather than throwing: the caller renders a plain progress bar instead. The
 * AudioContext is closed in a finally block, because a leaked context holds the audio hardware
 * open and on mobile that is a battery cost paid for a decoration.
 */
export async function computeWaveform(blob: Blob, buckets = 480): Promise<Waveform | null> {
  const Ctor: typeof AudioContext | undefined =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;

  let ctx: AudioContext | null = null;
  try {
    const bytes = await blob.arrayBuffer();
    ctx = new Ctor();
    const audio = await ctx.decodeAudioData(bytes);
    return reduceToPeaks(audio, buckets);
  } catch {
    // A recording we cannot draw is still a recording she can hear.
    return null;
  } finally {
    // Safari rejects close() on an already-closed context; a failure here is inert.
    try {
      await ctx?.close();
    } catch {
      /* nothing to do — the context is going away with the screen */
    }
  }
}

/**
 * Peak (not mean) amplitude per bucket, across all channels.
 *
 * Peak is the right reducer for this screen: averaging flattens a single shout into the
 * surrounding quiet, and the loud moment is exactly what she is looking for when she scrubs.
 */
export function reduceToPeaks(audio: AudioBuffer, buckets: number): Waveform {
  const out = new Float32Array(buckets);
  const perBucket = Math.max(1, Math.floor(audio.length / buckets));

  for (let ch = 0; ch < audio.numberOfChannels; ch += 1) {
    const data = audio.getChannelData(ch);
    for (let b = 0; b < buckets; b += 1) {
      const start = b * perBucket;
      const end = Math.min(data.length, start + perBucket);
      let peak = 0;
      for (let i = start; i < end; i += 1) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
      }
      if (peak > out[b]) out[b] = peak;
    }
  }

  // Normalise to the loudest moment so a quiet recording is still legible. Scaling the
  // PICTURE does not change the audio, and the transport reports real time either way.
  let max = 0;
  for (const v of out) if (v > max) max = v;
  if (max > 0) {
    for (let i = 0; i < out.length; i += 1) out[i] /= max;
  }
  return out;
}

/** Build an SVG polygon for a waveform in a `width` x `height` box, centred on its midline. */
export function waveformPath(peaks: Waveform, width: number, height: number): string {
  if (peaks.length === 0) return '';
  const mid = height / 2;
  const step = width / peaks.length;
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i < peaks.length; i += 1) {
    const x = (i * step).toFixed(2);
    // A floor of 0.5px keeps silence visible as a line rather than a gap, so a gap in the
    // drawing always means missing audio and never merely quiet audio.
    const h = Math.max(0.5, peaks[i] * mid);
    top.push(`${x},${(mid - h).toFixed(2)}`);
    bottom.push(`${x},${(mid + h).toFixed(2)}`);
  }
  return [...top, ...bottom.reverse()].join(' ');
}
