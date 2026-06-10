/**
 * HMAC request signing shared by the PWA (browser) and the Worker (Cloudflare).
 * Both sides run the exact same code so signatures always match. Uses only Web
 * Crypto (`crypto.subtle`), available in both runtimes — no dependencies.
 *
 * Canonical string signed: `METHOD\npathname\ntimestamp\nsha256(body)`.
 */

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  // Cast across the TS 5.7 typed-array generic (Uint8Array<ArrayBufferLike>) to
  // the BufferSource the Web Crypto API expects; the bytes are unchanged.
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return toHex(digest);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toHex(signature);
}

export function buildCanonical(
  method: string,
  path: string,
  timestamp: number,
  bodyHashHex: string,
): string {
  return [method.toUpperCase(), path, String(timestamp), bodyHashHex].join('\n');
}

export interface SignedHeaders {
  'X-Event-Id': string;
  'X-Timestamp': string;
  'X-Signature': string;
}

export interface SignRequestParams {
  secret: string;
  eventId: string;
  method: string;
  path: string;
  timestamp: number;
  body: Uint8Array;
}

export async function signRequest(params: SignRequestParams): Promise<SignedHeaders> {
  const bodyHash = await sha256Hex(params.body);
  const canonical = buildCanonical(params.method, params.path, params.timestamp, bodyHash);
  const signature = await hmacSha256Hex(params.secret, canonical);
  return {
    'X-Event-Id': params.eventId,
    'X-Timestamp': String(params.timestamp),
    'X-Signature': signature,
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface VerifyRequestParams {
  secret: string;
  method: string;
  path: string;
  timestamp: number;
  body: Uint8Array;
  signature: string;
  maxSkewMs?: number;
  now?: number;
}

export async function verifyRequest(params: VerifyRequestParams): Promise<boolean> {
  const now = params.now ?? Date.now();
  const maxSkewMs = params.maxSkewMs ?? 300_000;
  if (!Number.isFinite(params.timestamp) || Math.abs(now - params.timestamp) > maxSkewMs) {
    return false;
  }
  const bodyHash = await sha256Hex(params.body);
  const canonical = buildCanonical(params.method, params.path, params.timestamp, bodyHash);
  const expected = await hmacSha256Hex(params.secret, canonical);
  return timingSafeEqual(expected, params.signature);
}

/** Cryptographically random hex string, generated server-side per event. */
export function randomHex(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
