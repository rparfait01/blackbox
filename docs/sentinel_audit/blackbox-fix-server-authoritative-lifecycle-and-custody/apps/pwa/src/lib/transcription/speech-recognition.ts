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
}

/**
 * Continuous Web Speech transcription with auto-restart. Final fragments are
 * emitted via `onFinal` (the activation lifecycle routes them into the W3
 * transcript buffer); interim text is kept available for the classifier in real
 * time. If SpeechRecognition is unsupported, this is a silent no-op — recording
 * continues regardless.
 */
export class TranscriptionService {
  private recognition: SpeechRecognitionLike | null = null;
  private active = false;
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

  start(): void {
    if (this.active) {
      return;
    }
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      log.debug('SpeechRecognition unsupported; transcription disabled');
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
        // 'no-speech' and 'aborted' are routine; everything else is logged.
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          log.error('speech recognition error', event.error);
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
