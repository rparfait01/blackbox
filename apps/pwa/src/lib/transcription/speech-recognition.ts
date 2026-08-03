import { log } from '@/lib/log';

// Minimal Web Speech API typings. SpeechRecognition is not in the standard DOM
// lib (it is vendor-prefixed and unstandardized), so we declare what we use.
interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const scope = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export interface TranscriptionOptions {
  /** Called with each committed (final) fragment. */
  onFinal: (text: string, timestamp: number) => void;
  /** Called with the latest interim (low-confidence) text, if a consumer wants it. */
  onInterim?: (text: string) => void;
  /** BCP-47 language tag. Defaults to navigator.language, then 'en-US'. */
  lang?: string;
  /**
   * Brief 50 §C — transcription state, reported upward so a failure is DECLARED.
   *
   * Fires once per transition, not per event. `unavailable` means nothing will be transcribed for
   * this capture; `degraded` means a recoverable error occurred. Recording continues in both
   * cases — transcription is never a precondition for capture.
   */
  onStatus?: (status: { state: 'unavailable' | 'degraded'; detail: string }) => void;
}

/**
 * Continuous Web Speech transcription with auto-restart. Final fragments are
 * emitted via `onFinal` (the activation lifecycle routes them into the W3
 * transcript buffer); interim text is kept available for the classifier in real
 * time.
 *
 * ═══ Brief 50 §C — FAILURE IS DECLARED, NEVER SILENT ═════════════════════════════════════════
 *
 * This class used to document itself as "a silent no-op" when SpeechRecognition was unsupported,
 * and that sentence was the defect. Recording continued, nothing was transcribed, and the
 * coordinator was shown a blank summary panel — which does not read as "we could not transcribe."
 * It reads as NOTHING WAS SAID, at the one moment that distinction decides whether someone comes.
 *
 * Every terminal failure now routes to `onStatus`, which the activation lifecycle reports to the
 * survivor, the coordinator surface, and the record. Recording still continues regardless —
 * transcription is not a precondition for capture, and it never becomes one — but its ABSENCE is
 * now a stated fact rather than an empty panel.
 */
export class TranscriptionService {
  private recognition: SpeechRecognitionLike | null = null;
  private active = false;
  /** Last reported state, so a repeating error does not spam one transition. */
  private lastStatus: 'unavailable' | 'degraded' | null = null;
  private latestInterim = '';
  private readonly options: TranscriptionOptions;
  private readonly lang: string;

  constructor(options: TranscriptionOptions) {
    this.options = options;
    this.lang = options.lang ?? navigator.language ?? 'en-US';
  }

  get supported(): boolean {
    return getRecognitionCtor() !== null;
  }

  getLatestInterim(): string {
    return this.latestInterim;
  }

  /**
   * Report a transcription state upward. Never throws: a failure to report a failure must not
   * take down the capture it was reporting on.
   */
  private report(state: 'unavailable' | 'degraded', detail: string): void {
    if (this.lastStatus === state) return; // one report per transition, not per event
    this.lastStatus = state;
    try {
      this.options.onStatus?.({ state, detail });
    } catch {
      /* reporting is best-effort; recording is not */
    }
  }

  start(): void {
    if (this.active) {
      return;
    }
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      // NOT a silent no-op. The browser cannot transcribe; say so, and keep recording.
      log.debug('SpeechRecognition unsupported; transcription disabled');
      this.report('unavailable', 'This browser cannot transcribe speech. Audio is still recording.');
      return;
    }
    this.active = true;
    this.spinUp(Ctor);
  }

  private spinUp(Ctor: SpeechRecognitionCtor): void {
    try {
      const recognition = new Ctor();
      recognition.lang = this.lang;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.onresult = (event) => this.handleResult(event);
      recognition.onerror = (event) => {
        // 'no-speech' and 'aborted' are routine; everything else is logged AND declared.
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          log.error('speech recognition error', event.error);
          // A denied or unavailable microphone for recognition is the case Brief 50 §0.2 raised:
          // recognition opens its OWN mic and can lose that race with the recorder. Whatever the
          // cause, the coordinator must not read the result as silence.
          const terminal = event.error === 'not-allowed' || event.error === 'service-not-allowed' || event.error === 'audio-capture';
          this.report(
            terminal ? 'unavailable' : 'degraded',
            terminal
              ? 'Speech transcription could not access the microphone. Audio is still recording.'
              : `Speech transcription error (${event.error}). Audio is still recording.`,
          );
        }
      };
      recognition.onend = () => {
        // Auto-restart for long sessions (recognition stops on natural pauses).
        if (this.active) {
          try {
            recognition.start();
          } catch (error) {
            log.error('speech restart failed', error);
          }
        }
      };
      recognition.start();
      this.recognition = recognition;
    } catch (error) {
      log.error('speech recognition start failed', error);
      this.report('unavailable', 'Speech transcription could not start. Audio is still recording.');
      this.active = false;
    }
  }

  private handleResult(event: SpeechRecognitionEvent): void {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results.item(i);
      const alternative = result.item(0);
      if (result.isFinal) {
        const text = alternative.transcript.trim();
        if (text) {
          this.options.onFinal(text, Date.now());
        }
      } else {
        interim += alternative.transcript;
      }
    }
    this.latestInterim = interim.trim();
    if (this.latestInterim && this.options.onInterim) {
      this.options.onInterim(this.latestInterim);
    }
  }

  stop(): void {
    this.active = false;
    this.latestInterim = '';
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch (error) {
        log.error('speech stop failed', error);
      }
      this.recognition = null;
    }
  }
}
