import { NoOpClassifier, type Classification } from '@blackbox/classifier';
import { append, clear, getBuffer, type BufferedFragment } from '@/lib/transcript-buffer';

/**
 * DEV-only console interface for exercising the classification foundation
 * without speech recognition. Installed onto `globalThis.__stillpoint` only when
 * `import.meta.env.DEV` is true (see main.tsx), so production builds never
 * define it.
 */
interface ClassifierDevApi {
  simulateFragment: (sessionId: string, text: string) => void;
  getBuffer: (sessionId: string) => BufferedFragment[];
  runClassifier: (sessionId: string) => Promise<Classification | null>;
  clearBuffer: (sessionId: string) => void;
}

interface StillpointDevGlobal {
  classifier: ClassifierDevApi;
}

type GlobalWithDev = typeof globalThis & { __stillpoint?: StillpointDevGlobal };

const classifier = new NoOpClassifier();

export function installDevConsole(): void {
  const classifierApi: ClassifierDevApi = {
    simulateFragment: (sessionId, text) => append(sessionId, text, Date.now()),
    getBuffer: (sessionId) => getBuffer(sessionId),
    runClassifier: (sessionId) => {
      const transcript = getBuffer(sessionId)
        .map((fragment) => fragment.text)
        .join(' ');
      return classifier.classify(transcript, {});
    },
    clearBuffer: (sessionId) => clear(sessionId),
  };

  (globalThis as GlobalWithDev).__stillpoint = { classifier: classifierApi };
}
