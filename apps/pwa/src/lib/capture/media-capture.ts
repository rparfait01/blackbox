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
      const recorder = mimeType
        ? new MediaRecorder(this.mediaStream, { mimeType })
        : new MediaRecorder(this.mediaStream);
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
   * Acquire the capture stream. In overt (audio-video) mode, fall back to
   * audio-only if the camera is missing or denied — never lose audio + location
   * just because there is no camera.
   */
  private async acquireStream(): Promise<MediaStream> {
    if (this.options.mode === 'audio-video') {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: 'user' } });
      } catch (error) {
        log.error('video capture unavailable; falling back to audio-only', error);
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
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
