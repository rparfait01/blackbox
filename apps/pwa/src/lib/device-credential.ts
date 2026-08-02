/**
 * Brief 2 Fix A §A/§E2 — THE DEVICE HALF OF THE CREDENTIAL.
 *
 * `userHash` is a hash of a UUID in localStorage. It identifies the account and, until this brief,
 * authorized event operations — so anyone who read it could write to the account. It cannot be
 * rotated without breaking the account, and an abuser who has had the phone keeps it.
 *
 * This generates a keypair whose private half is NON-EXPORTABLE. `extractable: false` means the
 * browser will not hand the bytes to JavaScript at all: not to this code, not to an XSS payload,
 * not to anyone with the device unlocked who opens devtools. The key can only be USED, and only
 * from this origin. That is the property `userHash` never had.
 *
 * ═══ NOTHING HERE MAY EVER BLOCK A CAPTURE ═══════════════════════════════════════════════════
 *
 * Every function below either returns a usable value or returns null. None of them throw, none of
 * them retry in a loop, and no caller awaits them on the trigger path. If key generation fails, if
 * IndexedDB is unavailable, if the registration request 500s — capture proceeds unsigned, exactly
 * as it does today for every existing account. The server treats an unsigned write from an unarmed
 * account as normal (§E1), and fails open even for an armed one.
 *
 * That is not defensive habit, it is the brief: on the alert path a refusal is a survivor who
 * cannot call for help. A credential that could prevent a recording would be worse than no
 * credential at all.
 *
 * ═══ §E2 CLEARED STORAGE ══════════════════════════════════════════════════════════════════════
 *
 * Private browsing, "clear site data", a new profile — the key vanishes. That is not an error
 * state and must never surface as one. `ensureDeviceCredential` simply finds no key, makes a new
 * one, registers it through the session that is already live, and continues. The account ends up
 * with an extra credential row, each independently revocable, which is the correct outcome: the
 * old key genuinely is gone and nothing should still trust it.
 */
import { deviceCanonical } from '@blackbox/shared';

import { api } from './api';

const DB_NAME = 'stillpoint-identity';
const DB_VERSION = 1;
const STORE = 'device_key';
const RECORD = 'current';
/** The server-side credential id for the key we hold. Not secret; it names a row. */
const CREDENTIAL_ID_KEY = 'stillpoint:device-credential-id';

export interface DeviceCredential {
  credentialId: string;
  privateKey: CryptoKey;
}

let cached: DeviceCredential | null = null;
let inFlight: Promise<DeviceCredential | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
      r.onsuccess = () => resolve();
      r.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

const readCredentialId = (): string | null => {
  try {
    return localStorage.getItem(CREDENTIAL_ID_KEY);
  } catch {
    return null;
  }
};
const writeCredentialId = (id: string): void => {
  try {
    localStorage.setItem(CREDENTIAL_ID_KEY, id);
  } catch {
    /* private mode; the key still works for this session and re-registers next launch */
  }
};

const toB64 = (buf: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(buf)));
const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Get the credential, provisioning one if this device has none.
 *
 * Idempotent and single-flight: called on launch and again before the first signed write, and two
 * concurrent callers share one registration rather than racing to create two rows.
 */
export async function ensureDeviceCredential(): Promise<DeviceCredential | null> {
  if (cached) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const db = await openDb();
      if (!db) return null;

      const existingKey = (await idbGet(db, RECORD)) as CryptoKeyPair | undefined;
      const existingId = readCredentialId();
      if (existingKey?.privateKey && existingId) {
        cached = { credentialId: existingId, privateKey: existingKey.privateKey };
        return cached;
      }

      // §E2 — no key, or a key whose server row we have lost. Either way: make one and register
      // it. Not an error, not a prompt, not a dead end.
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
      const res = await api<{ credentialId?: string }>('/v1/me/devices', {
        body: { publicKey: toB64(spki), label: navigator.userAgent.slice(0, 60) },
      });
      if (!res.ok || !res.data?.credentialId) return null;

      // Store only AFTER the server accepted it. A key on disk with no row behind it would be
      // presented on every write and rejected forever.
      await idbPut(db, RECORD, pair);
      writeCredentialId(res.data.credentialId);
      cached = { credentialId: res.data.credentialId, privateKey: pair.privateKey };
      return cached;
    } catch {
      // Provisioning is best-effort by design. See the header: capture proceeds unsigned.
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * §B — sign one event-scoped write. Returns headers to merge, or an EMPTY object.
 *
 * The empty return is the important case and it is not an error path: an unprovisioned device, a
 * revoked key, a browser without WebCrypto, a failed signature — all produce `{}` and the upload
 * goes out exactly as it does today. There is no branch in the caller for "signing failed",
 * because there must not be one.
 */
export async function deviceSignatureHeaders(input: {
  method: string;
  path: string;
  eventId: string;
  bodyDigestHex: string;
}): Promise<Record<string, string>> {
  try {
    const cred = await ensureDeviceCredential();
    if (!cred) return {};
    const timestamp = Date.now();
    // THE SAME FUNCTION the server verifies with, imported from @blackbox/shared. Not "matching"
    // the server's form — literally it. Drift is not expressible.
    const canonical = deviceCanonical({ ...input, timestamp });
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      cred.privateKey,
      new TextEncoder().encode(canonical),
    );
    return {
      'X-Device-Id': cred.credentialId,
      'X-Device-Signature': toHex(sig),
      'X-Device-Timestamp': String(timestamp),
    };
  } catch {
    return {};
  }
}

/** §E2 — after a revocation or a wipe, forget locally so the next call re-provisions cleanly. */
export function forgetDeviceCredential(): void {
  cached = null;
  try {
    localStorage.removeItem(CREDENTIAL_ID_KEY);
  } catch {
    /* nothing to do */
  }
}
