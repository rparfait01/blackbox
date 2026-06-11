/**
 * Integrity & tamper-evidence (Fix Brief 2 #C2/#C4).
 *
 * Every media chunk (and, at export, the event row) is SHA-256 hashed and linked
 * into an append-only per-event hash chain: chainHash[n] = SHA256(chainHash[n-1]
 * + recordHash[n]). Altering any byte of any record changes its recordHash,
 * which breaks every chainHash from that point forward. The chain HEAD is signed
 * with a server-held Ed25519 private key; the verifier (recipient/court) checks
 * it with the published public key. The signature can't be forged without the
 * private key, and the file hashes can't be satisfied by altered bytes.
 *
 * Canonical time is UTC ms + tz offset (#C6).
 */

import { sha256Hex } from '@blackbox/shared';
import type { Env } from '../types';

export const GENESIS = '0'.repeat(64);

function nowOffset(): number {
  // The Worker runs in UTC; offset is 0. Render uses each record's own offset.
  return 0;
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}

export async function hashString(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value));
}

interface HeadRow {
  seq: number;
  chainHead: string;
}

async function getHead(env: Env, eventId: string): Promise<HeadRow | null> {
  return env.DB.prepare('SELECT seq, chainHead FROM integrity_heads WHERE eventId = ?')
    .bind(eventId)
    .first<HeadRow>();
}

/**
 * Append one record to an event's integrity chain and advance the signed head.
 * Returns the new chainHead. Best-effort: never throws into the write path.
 */
export async function appendToChain(
  env: Env,
  eventId: string,
  recordType: string,
  recordRef: string,
  recordHash: string,
): Promise<string | null> {
  try {
    const head = await getHead(env, eventId);
    const seq = head ? head.seq + 1 : 0;
    const prevHash = head ? head.chainHead : GENESIS;
    const chainHash = await hashString(`${prevHash}${recordHash}`);
    const now = Date.now();
    const tz = nowOffset();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT OR IGNORE INTO integrity_records (eventId, seq, recordType, recordRef, recordHash, prevHash, chainHash, createdAt, tzOffsetMinutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(eventId, seq, recordType, recordRef, recordHash, prevHash, chainHash, now, tz),
      env.DB.prepare(
        'INSERT INTO integrity_heads (eventId, seq, chainHead, updatedAt, tzOffsetMinutes) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(eventId) DO UPDATE SET seq = excluded.seq, chainHead = excluded.chainHead, updatedAt = excluded.updatedAt',
      ).bind(eventId, seq, chainHash, now, tz),
    ]);
    return chainHash;
  } catch (error) {
    console.log(JSON.stringify({ level: 'error', message: 'appendToChain failed', detail: String(error) }));
    return null;
  }
}

export interface IntegrityRecordRow {
  seq: number;
  recordType: string;
  recordRef: string;
  recordHash: string;
  prevHash: string;
  chainHash: string;
  createdAt: number;
  tzOffsetMinutes: number | null;
}

export async function getChain(env: Env, eventId: string): Promise<IntegrityRecordRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT seq, recordType, recordRef, recordHash, prevHash, chainHash, createdAt, tzOffsetMinutes FROM integrity_records WHERE eventId = ? ORDER BY seq ASC',
  )
    .bind(eventId)
    .all<IntegrityRecordRow>();
  return results ?? [];
}

export async function getChainHead(env: Env, eventId: string): Promise<HeadRow | null> {
  return getHead(env, eventId);
}

// --- Ed25519 head signing (server-held private key) ---

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function importSigningKey(env: Env): Promise<CryptoKey | null> {
  if (!env.INTEGRITY_SIGNING_KEY) {
    return null;
  }
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      b64ToBytes(env.INTEGRITY_SIGNING_KEY) as BufferSource,
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
  } catch (error) {
    console.log(JSON.stringify({ level: 'error', message: 'integrity key import failed', detail: String(error) }));
    return null;
  }
}

/** Ed25519-sign an arbitrary string; returns base64 signature, or null if unconfigured. */
export async function sign(env: Env, data: string): Promise<string | null> {
  const key = await importSigningKey(env);
  if (!key) {
    return null;
  }
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(data));
  return bytesToB64(new Uint8Array(sig));
}

/** The published verification public key (SPKI base64), for the manifest + verifier. */
export function publicKeyB64(env: Env): string | null {
  return env.INTEGRITY_PUBLIC_KEY ?? null;
}

/**
 * Scheduled integrity scan (#C4). Re-hash every sealed vault object and compare
 * to its recorded packageHash. On mismatch: open an investigation + alert the
 * deployment security contact. Updates lastVerifiedAt on a clean pass.
 */
export async function runIntegrityScan(env: Env, workerOrigin: string): Promise<void> {
  if (!env.VAULT) {
    return;
  }
  const { results } = await env.DB.prepare(
    'SELECT vaultKey, eventId, packageHash FROM vault_objects ORDER BY sealedAt ASC LIMIT 50',
  ).all<{ vaultKey: string; eventId: string; packageHash: string }>();
  for (const row of results ?? []) {
    try {
      const obj = await env.VAULT.get(row.vaultKey);
      if (!obj) {
        await openInvestigation(env, workerOrigin, {
          eventId: row.eventId,
          kind: 'vault_missing',
          detail: `Sealed object ${row.vaultKey} is missing from the vault.`,
        });
        continue;
      }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const actual = await hashBytes(bytes);
      if (actual !== row.packageHash) {
        await openInvestigation(env, workerOrigin, {
          eventId: row.eventId,
          kind: 'vault_mismatch',
          detail: `Vault object ${row.vaultKey} hash mismatch: expected ${row.packageHash}, got ${actual}.`,
        });
      } else {
        await env.DB.prepare('UPDATE vault_objects SET lastVerifiedAt = ? WHERE vaultKey = ?')
          .bind(Date.now(), row.vaultKey)
          .run();
      }
    } catch (error) {
      console.log(JSON.stringify({ level: 'error', message: 'vault scan failed', detail: String(error) }));
    }
  }
}

/**
 * Open a tamper investigation and alert the security contact (#C4). Idempotent
 * per (eventId, kind, detail-day) is not enforced here; the scan runs every
 * minute, so we only open one OPEN investigation per (eventId, kind) at a time.
 */
export async function openInvestigation(
  env: Env,
  _workerOrigin: string,
  input: { eventId?: string | null; recipientId?: string | null; kind: string; detail: string },
): Promise<void> {
  const existing = await env.DB.prepare(
    "SELECT id FROM investigations WHERE kind = ? AND COALESCE(eventId,'') = ? AND status = 'open' LIMIT 1",
  )
    .bind(input.kind, input.eventId ?? '')
    .first<{ id: string }>();
  if (existing) {
    return; // already tracking this
  }
  const id = `INV-${crypto.randomUUID()}`;
  await env.DB.prepare(
    "INSERT INTO investigations (id, eventId, recipientId, kind, detail, status, openedAt, tzOffsetMinutes) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)",
  )
    .bind(id, input.eventId ?? null, input.recipientId ?? null, input.kind, input.detail, Date.now(), 0)
    .run();

  // Alert the deployment security contact (operator/founder for the pilot).
  if (env.SECURITY_CONTACT_EMAIL && env.SENDGRID_API_KEY) {
    const { sendEmail } = await import('../channels/sendgrid-email');
    await sendEmail(
      env,
      {
        to: env.SECURITY_CONTACT_EMAIL,
        subject: `⚠ BLACK BOX integrity alert — ${input.kind}`,
        html: `<p><b>Integrity alert opened (${id}).</b></p><p>Kind: ${input.kind}</p><p>${input.detail}</p>`,
        text: `Integrity alert opened (${id}). Kind: ${input.kind}. ${input.detail}`,
      },
      'integrity_alert',
    );
  }
}
