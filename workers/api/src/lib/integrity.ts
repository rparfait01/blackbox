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
import { runVaultScan } from './vault-scan';
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

export interface AppendOutcome {
  ok: boolean;
  seq?: number;
  chainHash?: string;
  /** Set when ok is false. `collision` is the §B condition; others are storage failures. */
  error?: 'collision' | 'storage' | 'transport';
  /** True when this was a REPLAY of an earlier idempotency key — nothing was appended. */
  replayed?: boolean;
}

/**
 * THE SERIALIZED APPEND (Brief 37 §A/§B/§C). Called ONLY from inside the per-event
 * IntegrityChain Durable Object, which supplies the sequence and prevHash from ITS OWN
 * strongly-consistent storage.
 *
 * The sequence is a PARAMETER, not something this function derives. That is the correction
 * the first implementation needed: deriving it here meant re-reading the head from D1, and
 * D1 serves reads from replicas, so a perfectly ordered append could still read the head as
 * it was before its predecessor wrote. The observed result was record seq 1 carrying a
 * prevHash that no stored record had produced.
 *
 * WHAT CHANGED FROM THE VERSION THIS REPLACES:
 *
 *   - `INSERT OR IGNORE` is GONE. A conflicting record insert is an ERROR, surfaced to the
 *     caller and audited. Previously the losing insert was silently dropped while its head
 *     upsert still landed, so the signed head named a record that was never stored.
 *   - The head write is now unconditional AND safe, because the only writer is the DO and it
 *     hands us the sequence it has already reserved. The record insert's primary key remains
 *     the independent backstop: if the DO's view were ever wrong, the insert fails loudly
 *     rather than overwriting somebody else's record.
 *   - Record and head still move in ONE D1 batch, so the head can never advance without its
 *     record.
 *
 * It STILL never throws. A failed append must not fail a capture (§B) — the caller records a
 * declared gap and keeps uploading.
 */
export async function appendAtSequence(
  env: Env,
  input: {
    eventId: string;
    seq: number;
    prevHash: string;
    recordType: string;
    recordRef: string;
    recordHash: string;
    idempotencyKey?: string;
  },
): Promise<AppendOutcome> {
  const { eventId, seq, prevHash, recordType, recordRef, recordHash, idempotencyKey } = input;
  try {
    // §C - replay first. A repeated key returns the ORIGINAL result and appends nothing.
    if (idempotencyKey) {
      const prior = await env.DB.prepare(
        'SELECT seq, chainHash FROM integrity_idempotency WHERE eventId = ? AND idempotencyKey = ?',
      )
        .bind(eventId, idempotencyKey)
        .first<{ seq: number; chainHash: string }>();
      if (prior) {
        return { ok: true, seq: prior.seq, chainHash: prior.chainHash, replayed: true };
      }
    }

    const chainHash = await hashString(`${prevHash}${recordHash}`);
    const now = Date.now();
    const tz = nowOffset();

    const statements = [
      // No OR IGNORE. The (eventId, seq) primary key IS the collision detector, and a
      // collision has to reach the caller rather than vanish.
      env.DB.prepare(
        'INSERT INTO integrity_records (eventId, seq, recordType, recordRef, recordHash, prevHash, chainHash, createdAt, tzOffsetMinutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(eventId, seq, recordType, recordRef, recordHash, prevHash, chainHash, now, tz),
      env.DB.prepare(
        'INSERT INTO integrity_heads (eventId, seq, chainHead, updatedAt, tzOffsetMinutes) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(eventId) DO UPDATE SET seq = excluded.seq, chainHead = excluded.chainHead, updatedAt = excluded.updatedAt',
      ).bind(eventId, seq, chainHash, now, tz),
    ];
    if (idempotencyKey) {
      statements.push(
        env.DB.prepare(
          'INSERT INTO integrity_idempotency (eventId, idempotencyKey, seq, chainHash, createdAt) VALUES (?, ?, ?, ?, ?)',
        ).bind(eventId, idempotencyKey, seq, chainHash, now),
      );
    }
    await env.DB.batch(statements);
    return { ok: true, seq, chainHash };
  } catch (error) {
    // A primary-key conflict on integrity_records means the sequence was already taken -
    // which, with the DO owning sequence allocation, means something is badly wrong rather
    // than merely contended. Loud, distinguishable, audited; never a silent short chain.
    const detail = String(error);
    const collision = /UNIQUE|PRIMARY KEY|constraint/i.test(detail);
    console.log(
      JSON.stringify({
        level: 'error',
        alert: collision ? 'integrity_sequence_collision' : 'integrity_append_failed',
        eventId,
        seq,
        recordType,
        recordRef,
        detail: detail.slice(0, 200),
      }),
    );
    return { ok: false, error: collision ? 'collision' : 'storage' };
  }
}

/**
 * Append one record to an event's chain, THROUGH the serialization point.
 *
 * Every caller in the worker comes here, and this function's only job is to route to the
 * per-event Durable Object. It keeps the old name and the old never-throws contract so the
 * capture path is unchanged in shape: a chain failure returns null and the caller carries on.
 * What is new is that the failure is now RECORDED as a declared gap (§B) instead of being a
 * null that nobody ever sees.
 */
export async function appendToChain(
  env: Env,
  eventId: string,
  recordType: string,
  recordRef: string,
  recordHash: string,
  idempotencyKey?: string,
): Promise<string | null> {
  try {
    if (!env.INTEGRITY_DO) {
      // No binding (local dev, or a deployment without the DO). Fall back to the SAME
      // serialized routine, accepting that cross-request ordering is unprotected there.
      // Deliberately loud: a production deployment without this binding is a
      // misconfiguration, and the chain's correctness depends on it.
      console.log(JSON.stringify({ level: 'error', alert: 'integrity_do_unbound', eventId }));
      const head = await getHead(env, eventId);
      const direct = await appendAtSequence(env, {
        eventId,
        seq: head ? head.seq + 1 : 0,
        prevHash: head ? head.chainHead : GENESIS,
        recordType,
        recordRef,
        recordHash,
        idempotencyKey,
      });
      if (!direct.ok) {
        await recordChainGap(env, eventId, recordType, recordRef, direct.error ?? 'storage');
      }
      return direct.chainHash ?? null;
    }
    const stub = env.INTEGRITY_DO.get(env.INTEGRITY_DO.idFromName(eventId));
    const res = await stub.fetch('https://integrity-do/append', {
      method: 'POST',
      body: JSON.stringify({ eventId, recordType, recordRef, recordHash, idempotencyKey }),
    });
    const outcome = (await res.json()) as AppendOutcome;
    if (!outcome.ok) {
      await recordChainGap(env, eventId, recordType, recordRef, outcome.error ?? 'storage');
      return null;
    }
    return outcome.chainHash ?? null;
  } catch (error) {
    console.log(JSON.stringify({ level: 'error', message: 'appendToChain failed', detail: String(error) }));
    await recordChainGap(env, eventId, recordType, recordRef, 'transport');
    return null;
  }
}

/**
 * §B - declare a gap. The capture is NOT failed: the chunk still uploads and the evidence is
 * still retained, because losing evidence to protect a hash chain inverts the priority. What
 * we refuse to do is pretend the chain is whole. A verifier reads this and reports INCOMPLETE
 * at a named sequence rather than silently accepting a shorter chain that is internally
 * consistent and quietly missing a record.
 */
export async function recordChainGap(
  env: Env,
  eventId: string,
  recordType: string,
  recordRef: string,
  reason: string,
): Promise<void> {
  try {
    const head = await getHead(env, eventId);
    await env.DB.prepare(
      'INSERT OR REPLACE INTO integrity_gaps (eventId, seq, recordType, recordRef, reason, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(eventId, head?.seq ?? -1, recordType, recordRef, reason, Date.now())
      .run();
    await env.DB.prepare(
      'INSERT INTO audit_log (id, eventId, action, actorHash, timestamp, metadataJson) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        crypto.randomUUID(),
        eventId,
        'integrity.chain_gap',
        null,
        Date.now(),
        JSON.stringify({ recordRef, reason }),
      )
      .run();
  } catch (error) {
    console.log(JSON.stringify({ level: 'error', message: 'recordChainGap failed', detail: String(error) }));
  }
}

export interface ChainGapRow {
  seq: number;
  recordType: string;
  recordRef: string;
  reason: string;
  createdAt: number;
}

export async function getChainGaps(env: Env, eventId: string): Promise<ChainGapRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT seq, recordType, recordRef, reason, createdAt FROM integrity_gaps WHERE eventId = ? ORDER BY seq ASC',
  )
    .bind(eventId)
    .all<ChainGapRow>();
  return results ?? [];
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

async function importVerifyKey(publicKeyB64Value: string): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.importKey(
      'spki',
      b64ToBytes(publicKeyB64Value) as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
  } catch (error) {
    console.log(JSON.stringify({ level: 'error', message: 'integrity verify-key import failed', detail: String(error) }));
    return null;
  }
}

/**
 * Verify an Ed25519 signature (base64) over `data` against a published SPKI
 * public key (base64). Defaults to this deployment's INTEGRITY_PUBLIC_KEY so a
 * verifier can check a package with no extra config. Returns false on any
 * failure (bad key, bad signature, tampered data) — never throws (Brief 15 §F).
 */
export async function verify(
  data: string,
  signatureB64: string,
  publicKeyB64Value: string,
): Promise<boolean> {
  try {
    const key = await importVerifyKey(publicKeyB64Value);
    if (!key) return false;
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      b64ToBytes(signatureB64) as BufferSource,
      new TextEncoder().encode(data) as BufferSource,
    );
  } catch {
    return false;
  }
}

/**
 * Verify a signed export manifest: strip its `signature`, re-canonicalize the
 * remaining fields exactly as `exportPackage` did (JSON.stringify of the
 * unsigned object), and check the Ed25519 signature against the manifest's own
 * published `publicKey`. Tampering with any signed byte flips this to false.
 */
export async function verifyManifest(
  manifest: Record<string, unknown> & { signature?: string; publicKey?: string },
): Promise<boolean> {
  const { signature, ...unsigned } = manifest;
  const pub = (manifest.publicKey as string | undefined) ?? '';
  if (!signature || !pub) return false;
  // The signed payload is the manifest WITHOUT the signature field, in the same
  // key order exportPackage produced (publicKey is part of the signed body).
  return verify(JSON.stringify(unsigned), signature, pub);
}

/**
 * Scheduled integrity scan (#C4). Re-hash every sealed vault object and compare
 * to its recorded packageHash. On mismatch: open an investigation + alert the
 * deployment security contact. Updates lastVerifiedAt on a clean pass.
 */
/**
 * Vault integrity scan (#C4) — DELEGATED to lib/vault-scan.ts (Brief 40 §A).
 *
 * This used to be a capped batch (`ORDER BY sealedAt ASC LIMIT 50`) that re-examined the same
 * fifty rows on every run, so past fifty eligible objects the tail was never reached and
 * nothing said so. Coverage is now proven by a durable cursor and recorded per pass; the
 * implementation moved out because it grew a state machine and belongs beside its own tests.
 */
export async function runIntegrityScan(env: Env, workerOrigin: string): Promise<void> {
  await runVaultScan(env, workerOrigin);
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
