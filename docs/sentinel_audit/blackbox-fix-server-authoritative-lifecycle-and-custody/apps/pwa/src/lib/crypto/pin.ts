/**
 * PIN hashing (W6). The closure pin and duress pin are stored only as PBKDF2
 * hashes (never plaintext), using the same primitives the W3 spec reserved for
 * BYOK key handling. The raw pin never leaves the device; the closure request
 * sent to the Worker carries the salted hash, which the Worker records but does
 * not validate (closure is gated by the contact's approval, not by the server).
 */

const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

export interface StoredPin {
  saltB64: string;
  hashB64: string;
  iterations: number;
}

function toB64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromB64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPin(pin: string): Promise<StoredPin> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(pin, salt, ITERATIONS);
  return { saltB64: toB64(salt), hashB64: toB64(hash), iterations: ITERATIONS };
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export async function verifyPin(pin: string, stored: StoredPin): Promise<boolean> {
  const salt = fromB64(stored.saltB64);
  const expected = fromB64(stored.hashB64);
  const actual = await derive(pin, salt, stored.iterations);
  return constantTimeEqual(actual, expected);
}

/** The salted-hash string sent to the Worker (recorded, not validated). */
export function pinHashWithSalt(stored: StoredPin): string {
  return `pbkdf2$${stored.iterations}$${stored.saltB64}$${stored.hashB64}`;
}

/**
 * Closure pin (Brief 9): a 3-digit pin whose duress signal is "the last digit
 * altered". Stored ON-DEVICE only as TWO hashes — the full pin and its
 * (n-1)-digit prefix — so duress can be detected without ever keeping the
 * plaintext and without transmitting anything. The pin itself is NEVER sent; the
 * eval result (sat | duress | wrong) is the only thing that leaves the device.
 */
export interface ClosurePin {
  full: StoredPin;
  prefix: StoredPin;
}

export async function hashClosurePin(pin: string): Promise<ClosurePin> {
  return { full: await hashPin(pin), prefix: await hashPin(pin.slice(0, -1)) };
}

export type ClosureEval = 'sat' | 'duress' | 'wrong';

/**
 * On-device evaluation. Correct pin → SAT. First (n-1) digits correct but the
 * last differs → DURESS (UNSAT). Anything else → WRONG (typo).
 */
export async function evalClosurePin(entered: string, stored: ClosurePin): Promise<ClosureEval> {
  if (await verifyPin(entered, stored.full)) {
    return 'sat';
  }
  if (entered.length >= 2 && (await verifyPin(entered.slice(0, -1), stored.prefix))) {
    return 'duress';
  }
  return 'wrong';
}
