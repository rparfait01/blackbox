import { LocalClassifier, type Classification } from '@blackbox/classifier';
import { append, clear, getBuffer, type BufferedFragment } from '@/lib/transcript-buffer';
import {
  getClassifications,
  getLatestClassification,
  setStoredDuressPin,
  setStoredPin,
  type StoredClassification,
} from '@/lib/storage';
import { hashPin } from '@/lib/crypto/pin';
import { API_BASE_URL } from '@/lib/env';

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
  getCurrentClassification: (sessionId: string) => Promise<StoredClassification | null>;
  getAllClassifications: (sessionId: string) => Promise<StoredClassification[]>;
}

/** Pilot-only admin/config helpers (W6). Dev builds only. */
interface ContactsDevApi {
  /** List server-side contacts. Pass the ADMIN_TOKEN (kept out of source). */
  list: (adminToken: string) => Promise<unknown>;
}

interface PinDevApi {
  /** Store the hashed closure pin for the user (the normal pin). */
  set: (digits: string) => Promise<void>;
  /** Store the hashed duress pin (same first 3 digits, different 4th). */
  setDuress: (digits: string) => Promise<void>;
}

interface StillpointDevGlobal {
  classifier: ClassifierDevApi;
  contacts: ContactsDevApi;
  pin: PinDevApi;
}

type GlobalWithDev = typeof globalThis & { __stillpoint?: StillpointDevGlobal };

const classifier = new LocalClassifier();

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
    getCurrentClassification: (sessionId) => getLatestClassification(sessionId),
    getAllClassifications: (sessionId) => getClassifications(sessionId),
  };

  const contactsApi: ContactsDevApi = {
    list: async (adminToken) => {
      const response = await fetch(`${API_BASE_URL}/v1/admin/contacts`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      return response.json();
    },
  };

  const pinApi: PinDevApi = {
    set: async (digits) => setStoredPin(await hashPin(digits)),
    setDuress: async (digits) => setStoredDuressPin(await hashPin(digits)),
  };

  (globalThis as GlobalWithDev).__stillpoint = {
    classifier: classifierApi,
    contacts: contactsApi,
    pin: pinApi,
  };
}
