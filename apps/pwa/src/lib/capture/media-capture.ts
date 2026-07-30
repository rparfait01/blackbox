import { log } from '@/lib/log';
import type { CaptureMode } from '@/lib/storage/types';

export interface CaptureChunk {
  blob: Blob;
  mimeType: string;
  timestamp: number;
}

export interface MediaCaptureOptions {
  mode: CaptureMode;
  chunkIntervalMs?: number;
  onChunk: (chunk: CaptureChunk) => void;
  onError?: (error: unknown) => void;
}

/**
 * The encoder budget. A chunk has to cross the uplink it actually has, and nothing used to
 * say how big it was allowed to be: prod chunks reached 1.5 MB per second, which no mobile
 * uplink sustains, so the queue fell behind without bound and most of the recording never
 * left the phone.
 *
 * ~720p24 at 800 kbps lands around 108 KB per second — an order of magnitude under what was
 * shipping, and comfortably under the 461 KB/s that was working.
 *
 * EVERY ONE OF THESE IS `ideal`, NEVER `exact`. An exact resolution would add a new hard-fail
 * rung to the acquisition ladder: a device that could not hit it would fall through to
 * audio-only and lose video altogether. Only `facingMode` uses `exact`, only on rung 1, and
 * this budget does not touch camera selection at all.
 */
const VIDEO_QUALITY: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 24 },
};
const VIDEO_BITS_PER_SECOND = 800_000;
const AUDIO_BITS_PER_SECOND = 64_000;

function pickMimeType(mode: CaptureMode): string {
  // Prefer MP4/AAC so the recording is decodable in iOS Safari (which cannot
  // play webm/opus) on the contact dashboard; fall back to webm/opus on browsers
  // that only record webm (e.g. older Android Chrome), then the browser default.
  const candidates =
    mode === 'audio-video'
      ? ['video/mp4;codecs=h264,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm'];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}

/**
 * Thin MediaRecorder wrapper. Records in chunks and hands each chunk to the
 * caller via `onChunk`. Permission is requested only when `start()` is called
 * — never preemptively — and a denial is handled silently (internal log, no UI
 * alarm). The OS-level recording indicator will appear; that is OS-mandated and
 * we do not attempt to suppress it.
 */
export class MediaCapture {
  private mediaStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private videoSink: HTMLVideoElement | null = null;
  private activeMode: CaptureMode;
  private readonly options: MediaCaptureOptions;

  constructor(options: MediaCaptureOptions) {
    this.options = options;
    this.activeMode = options.mode;
  }

  get isRecording(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording';
  }

  /**
   * Read-only access to the live capture stream, so the tone analyzer can attach
   * to it without a second getUserMedia. Null until `start()` succeeds.
   */
  get stream(): MediaStream | null {
    return this.mediaStream;
  }

  async start(): Promise<boolean> {
    if (this.isRecording) {
      return true;
    }
    try {
      this.mediaStream = await this.acquireStream();
      // The effective mode may have downgraded to audio if no camera was
      // available; pick the mime type for what we actually captured.
      this.activeMode = this.mediaStream.getVideoTracks().length > 0 ? 'audio-video' : 'audio';

      // Overt video capture: mount a hidden <video playsinline muted> sink and
      // play() it from the activation gesture so the camera stays live (iOS
      // autoplay policy). Covert mode never reaches here with video.
      if (this.activeMode === 'audio-video') {
        this.mountVideoSink(this.mediaStream);
      }

      const mimeType = pickMimeType(this.activeMode);
      const recorder = this.makeRecorder(this.mediaStream, mimeType);
      this.recorder = recorder;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          this.options.onChunk({
            blob: event.data,
            mimeType: recorder.mimeType || mimeType,
            timestamp: Date.now(),
          });
        }
      };
      recorder.onerror = (event: Event) => {
        log.error('media recorder error', event);
        this.options.onError?.(event);
      };

      recorder.start(this.options.chunkIntervalMs ?? 1000);
      return true;
    } catch (error) {
      // Permission denied or no device. No UI alarm — internal log only.
      log.error('capture start failed', error);
      this.options.onError?.(error);
      this.stop();
      return false;
    }
  }

  /**
   * Acquire the capture stream. In overt (audio-video) mode, prefer the REAR
   * (`environment`) camera: in an emergency the survivor will not turn the phone
   * around, so the front lens records her own face while the rear lens faces
   * away from her — toward whatever is happening. Rear is the evidentiary
   * default.
   *
   * The ladder degrades but never fails on the way down, because capture
   * availability outranks capture quality:
   *   1. exact rear    — guarantees the rear lens whenever the device has one
   *   2. ideal rear    — any camera, rear preferred (devices that don't report
   *                      facingMode, e.g. many desktop webcams)
   *   3. any camera    — some video beats none
   *   4. audio only    — never lose audio + location just because there is no
   *                      usable camera
   */
  private async acquireStream(): Promise<MediaStream> {
    if (this.options.mode === 'audio-video') {
      // Camera SELECTION is the facingMode rungs and is settled; the spread only adds a
      // quality preference to each rung. Rung 3 still constrains no camera whatsoever.
      const videoConstraints: MediaTrackConstraints[] = [
        { facingMode: { exact: 'environment' }, ...VIDEO_QUALITY },
        { facingMode: { ideal: 'environment' }, ...VIDEO_QUALITY },
        { ...VIDEO_QUALITY },
      ];
      for (const video of videoConstraints) {
        try {
          return await navigator.mediaDevices.getUserMedia({ audio: true, video });
        } catch (error) {
          // Expected on front-camera-only devices for the `exact` rung; the
          // loop simply relaxes the constraint. Only the last failure means we
          // genuinely have no camera.
          log.error('camera constraint unavailable; relaxing', error);
        }
      }
      log.error('video capture unavailable; falling back to audio-only');
    }
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }

  /**
   * Build the recorder, degrading through the options rather than losing the recording.
   *
   * The bitrate budget must never cost us a capture, so it is the FIRST thing surrendered
   * when a browser objects — and the mime type is surrendered only after it, because a
   * container the contact's phone cannot decode is worse than a large one. Same rule as the
   * acquisition ladder: availability outranks quality.
   *
   *   1. mime + budget   — what we want
   *   2. mime only       — keep an iOS-decodable container, lose the budget
   *   3. budget only     — browser default container
   *   4. nothing         — whatever the browser gives us
   *
   * If even (4) throws, `start()` catches it and reports honestly; it does not pretend to
   * record. Bitrate hints are advisory anyway, so the real proof of this is the measured
   * chunk size on a device, not the presence of the option.
   */
  private makeRecorder(stream: MediaStream, mimeType: string): MediaRecorder {
    const budget: MediaRecorderOptions =
      this.activeMode === 'audio-video'
        ? { videoBitsPerSecond: VIDEO_BITS_PER_SECOND, audioBitsPerSecond: AUDIO_BITS_PER_SECOND }
        : { audioBitsPerSecond: AUDIO_BITS_PER_SECOND };
    const attempts: MediaRecorderOptions[] = mimeType
      ? [{ mimeType, ...budget }, { mimeType }, { ...budget }, {}]
      : [{ ...budget }, {}];
    for (const options of attempts) {
      try {
        return new MediaRecorder(stream, options);
      } catch (error) {
        log.error('recorder options rejected; relaxing', error);
      }
    }
    // Every option was refused. Let the bare constructor's own error surface to start().
    return new MediaRecorder(stream);
  }

  /** Mount an off-screen muted video sink and play the stream from the gesture. */
  private mountVideoSink(stream: MediaStream): void {
    if (typeof document === 'undefined') {
      return;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    // Off-screen, 1px: kept in the DOM so iOS keeps the camera track live.
    video.style.cssText =
      'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:0';
    video.srcObject = stream;
    document.body.appendChild(video);
    this.videoSink = video;
    void video.play().catch((error) => log.error('video sink play failed', error));
  }

  stop(): void {
    try {
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.stop();
      }
    } catch (error) {
      log.error('recorder stop failed', error);
    }
    this.recorder = null;
    if (this.videoSink) {
      try {
        this.videoSink.pause();
        this.videoSink.srcObject = null;
        this.videoSink.remove();
      } catch (error) {
        log.error('video sink teardown failed', error);
      }
      this.videoSink = null;
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
  }
}
