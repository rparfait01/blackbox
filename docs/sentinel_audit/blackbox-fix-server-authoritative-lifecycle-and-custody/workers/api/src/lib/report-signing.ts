/**
 * The report-signing key (Brief 30 §1) — ECDSA P-256 / SHA-256.
 *
 * A DEDICATED key, deliberately separate from INTEGRITY_SIGNING_KEY. Different artifact,
 * different audience, different blast radius: the integrity key signs custody export
 * manifests for a named recipient; this one signs survivor-generated reports that go to
 * courts, advocates, and strangers. Compromise of one must not forge the other, and they
 * should be rotatable independently.
 *
 * WHY P-256 RATHER THAN Ed25519. This signature's whole job is to be checkable by people we
 * will never meet, on whatever browser and tooling they have. ECDSA P-256 has been universal
 * in WebCrypto for a decade; Ed25519 only arrived in Chrome 137 (May 2025), Safari 17,
 * Firefox 129. A public verifier that answers "this browser cannot check it" is a trust cost
 * we do not need to pay — the same reasoning the Brief 26 crypto review used to choose P-256
 * over X25519.
 *
 * THE PRIVATE KEY IS SERVER-SIDE ONLY (a Wrangler secret). It is never in the verifier
 * bundle, never in the PWA, never in the repo. A leaked report-signing key means forgeable
 * certifications — see docs/brief30/KEY_CUSTODY.md.
 *
 * Generate with: node scripts/gen-report-keys.mjs
 */
import type { Env } from '../types';

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function importSigningKey(env: Env): Promise<CryptoKey | null> {
  if (!env.REPORT_SIGNING_KEY) {
    return null;
  }
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      b64ToBytes(env.REPORT_SIGNING_KEY) as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
  } catch (error) {
    console.log(JSON.stringify({ level: 'error', message: 'report signing key import failed', detail: String(error) }));
    return null;
  }
}

/**
 * Sign a canonical attestation. Returns base64 of the raw r‖s signature (P1363) — the form
 * WebCrypto produces and every browser verifier consumes. Null when unconfigured, so the
 * caller refuses to certify rather than emitting an unsigned "certified" document.
 */
export async function signReport(env: Env, data: string): Promise<string | null> {
  const key = await importSigningKey(env);
  if (!key) {
    return null;
  }
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(data) as BufferSource,
  );
  return bytesToB64(new Uint8Array(sig));
}

/** The published report-verification public key (SPKI base64). Published so anyone can
 *  verify a report without this server and without the verification page. */
export function reportPublicKey(env: Env): string | null {
  return env.REPORT_PUBLIC_KEY ?? null;
}
