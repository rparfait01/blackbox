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
  private readonly options: MediaCaptureOptions;

  constructor(options: MediaCaptureOptions) {
    this.options = options;
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
      const constraints: MediaStreamConstraints = {
        audio: true,
        video: this.options.mode === 'audio-video' ? { facingMode: 'user' } : false,
      };
      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

      const mimeType = pickMimeType(this.options.mode);
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

  stop(): void {
    try {
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.stop();
      }
    } catch (error) {
      log.error('recorder stop failed', error);
    }
    this.recorder = null;
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
  }
}
