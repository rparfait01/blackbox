/**
 * Export = custody transfer + sealed vault (Fix Brief 2 #C3).
 *
 * On export we assemble a signed package (event record + integrity chain + a
 * file list with each chunk's SHA-256), record a custody-transfer event (who
 * RCP-id, DTG, full package hash), and SEAL the canonical signed manifest into a
 * write-once vault object with 36-month retention. The recipient receives a
 * verifiable working copy that references the same package hash; the original
 * never "leaves" — a sealed, verifiable reference remains in the operator vault.
 *
 * Canonical time is UTC ms + offset; DTG is render-only (#C6).
 */

import { formatDtg } from '@blackbox/shared';
import type { Env } from '../types';
import { getChain, getChainHead, hashString, publicKeyB64, sign } from './integrity';
import { verifyChain } from './chain-verdict';
import { logRecipientAction } from './recipients';

const RETENTION_MONTHS = 36;

function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

interface EventRow {
  id: string;
  createdAt: number;
  status: string;
  source: string | null;
  locale: string | null;
  tzOffsetMinutes: number | null;
  closedAt: number | null;
  closedBy: string | null;
}

export interface SignedManifest {
  version: string;
  eventId: string;
  generatedAt: number;
  generatedDtg: string;
  event: {
    id: string;
    createdAt: number;
    createdDtg: string;
    status: string;
    source: string | null;
    locale: string | null;
    tzOffsetMinutes: number | null;
    closedAt: number | null;
    closedBy: string | null;
  };
  files: Array<{ name: string; r2Key: string; sha256: string | null; bytes: number; downloadPath: string }>;
  chain: {
    algorithm: string;
    /** Brief 37 §E — VERIFIED | INCOMPLETE | PURGED_BY_CONSENT | BROKEN. Four distinct
     *  findings; collapsing any two destroys the chain's diagnostic value. */
    outcome: string;
    outcomeDetail: string;
    /** Set for INCOMPLETE: the sequence after which the chain is known to be missing. */
    incompleteAtSeq: number | null;
    /** Set for PURGED_BY_CONSENT: when consent was recorded, and against what. */
    purge: { at: number; chunks: number; restorePoint: string | null } | null;
    head: string | null;
    records: Array<{
      seq: number;
      recordType: string;
      recordRef: string;
      recordHash: string;
      prevHash: string;
      chainHash: string;
    }>;
  };
  publicKey: string | null;
  signature: string | null;
}

export interface ExportResult {
  manifest: SignedManifest;
  packageHash: string;
  vaultKey: string | null;
  custodyId: string;
}

/**
 * Build, sign, seal, and record a custody package for an event on behalf of a
 * verified recipient. Idempotent on identical content (content-addressed vault
 * key), so repeated exports of unchanged evidence don't duplicate the seal.
 */
export async function exportPackage(
  env: Env,
  eventId: string,
  workerOrigin: string,
  recipientId: string,
): Promise<ExportResult | null> {
  // Brief 35 §C — a canary event is NEVER sealed. The vault is write-once with a 36-month
  // retention and no delete-before-expiry, so a fixture sealed into it could not be taken
  // back out by the purge; it would sit in the chain of custody, signed, for three years,
  // among artifacts whose whole value is that everything in there is real. `isTest = 0` in
  // this lookup means a canary event simply has no exportable package.
  const event = await env.DB.prepare(
    'SELECT id, createdAt, status, source, locale, tzOffsetMinutes, closedAt, closedBy FROM events WHERE id = ? AND isTest = 0',
  )
    .bind(eventId)
    .first<EventRow>();
  if (!event) {
    return null;
  }

  const { results: chunkRows } = await env.DB.prepare(
    'SELECT sequence, r2Key, sizeBytes, mimeType, sha256 FROM chunks_index WHERE eventId = ? ORDER BY sequence ASC',
  )
    .bind(eventId)
    .all<{ sequence: number; r2Key: string; sizeBytes: number; mimeType: string; sha256: string | null }>();

  const chain = await getChain(env, eventId);
  const head = await getChainHead(env, eventId);
  // Brief 37 §E — the manifest carries the chain's VERDICT, computed server-side by
  // re-linking and re-hashing every record. Without it a verifier can only tell
  // 'hashes match' from 'hashes do not', and would read a consented purge as tampering.
  const verdict = await verifyChain(env, eventId);
  const now = Date.now();

  // Build the manifest in a FIXED key order so JSON.stringify is deterministic
  // and the signature/hash are reproducible by the verifier.
  const manifestUnsigned: Omit<SignedManifest, 'signature'> = {
    version: 'blackbox-custody-1',
    eventId,
    generatedAt: now,
    generatedDtg: formatDtg(now),
    event: {
      id: event.id,
      createdAt: event.createdAt,
      createdDtg: formatDtg(event.createdAt),
      status: event.status,
      source: event.source,
      locale: event.locale,
      tzOffsetMinutes: event.tzOffsetMinutes,
      closedAt: event.closedAt,
      closedBy: event.closedBy,
    },
    files: (chunkRows ?? []).map((r) => ({
      name: `chunks/${r.sequence}`,
      r2Key: r.r2Key,
      sha256: r.sha256,
      bytes: r.sizeBytes,
      // Absolute path (recipient appends their access token to download).
      downloadPath: `${workerOrigin}/v1/c/${eventId}/audio/${r.sequence}`,
    })),
    chain: {
      algorithm: 'sha256-linked',
      // VERIFIED | INCOMPLETE | PURGED_BY_CONSENT | BROKEN — four distinct findings. The
      // third is mandatory: production holds chain records attesting to objects purged on
      // recorded owner consent, and without it the first export would read as tampered.
      outcome: verdict.outcome,
      outcomeDetail: verdict.detail,
      incompleteAtSeq: verdict.incompleteAtSeq ?? null,
      purge: verdict.purge ?? null,
      head: head?.chainHead ?? null,
      records: chain.map((r) => ({
        seq: r.seq,
        recordType: r.recordType,
        recordRef: r.recordRef,
        recordHash: r.recordHash,
        prevHash: r.prevHash,
        chainHash: r.chainHash,
      })),
    },
    publicKey: publicKeyB64(env),
  };

  const canonical = JSON.stringify(manifestUnsigned);
  const signature = await sign(env, canonical);
  const manifest: SignedManifest = { ...manifestUnsigned, signature };
  const envelope = JSON.stringify(manifest);
  const packageHash = await hashString(envelope);
  const manifestHash = await hashString(canonical);

  // Seal into the write-once vault (content-addressed key → idempotent). We
  // never overwrite an existing sealed object and never delete before expiry.
  let vaultKey: string | null = null;
  if (env.VAULT) {
    vaultKey = `vault/${eventId}/${packageHash}.json`;
    const existing = await env.VAULT.head(vaultKey);
    if (!existing) {
      await env.VAULT.put(vaultKey, envelope, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { eventId, sealedAt: String(now), retentionMonths: String(RETENTION_MONTHS) },
      });
    }
    await env.DB.prepare(
      'INSERT OR IGNORE INTO vault_objects (vaultKey, eventId, packageHash, sealedAt, expiresAt, tzOffsetMinutes) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(vaultKey, eventId, packageHash, now, addMonths(now, RETENTION_MONTHS), event.tzOffsetMinutes)
      .run();
  }

  const custodyId = `CUS-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'INSERT INTO custody_transfers (id, eventId, recipientId, packageHash, manifestHash, vaultKey, createdAt, tzOffsetMinutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(custodyId, eventId, recipientId, packageHash, manifestHash, vaultKey ?? '', now, event.tzOffsetMinutes)
    .run();
  await logRecipientAction(env, recipientId, eventId, 'export', `package ${packageHash.slice(0, 12)}`);

  return { manifest, packageHash, vaultKey, custodyId };
}

/** Recipient acknowledges custody — feeds the trust record (#C5). */
export async function acknowledgeCustody(
  env: Env,
  custodyId: string,
  recipientId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT id, recipientId, createdAt, acknowledgedAt FROM custody_transfers WHERE id = ?',
  )
    .bind(custodyId)
    .first<{ id: string; recipientId: string; createdAt: number; acknowledgedAt: number | null }>();
  if (!row || row.recipientId !== recipientId) {
    return false;
  }
  if (row.acknowledgedAt == null) {
    await env.DB.prepare('UPDATE custody_transfers SET acknowledgedAt = ? WHERE id = ?')
      .bind(Date.now(), custodyId)
      .run();
  }
  return true;
}
