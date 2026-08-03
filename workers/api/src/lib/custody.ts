/**
 * Export = custody transfer + sealed vault (Fix Brief 2 #C3).
 *
 * On export we assemble a signed package (event record + integrity chain + a
 * file list with each chunk's SHA-256), record a custody-transfer event (who
 * RCP-id, DTG, full package hash), and SEAL the canonical signed manifest into a
 * sealed vault object retained for 36 months by a storage-layer lock rule that binds the
 * OPERATOR (Brief 40 §D — it is not write-once, and the account holder can remove the
 * rule; see scripts/vault-lock.mjs for the full limits). The recipient receives a
 * verifiable working copy that references the same package hash; the original
 * never "leaves" — a sealed, verifiable reference remains in the operator vault.
 *
 * Canonical time is UTC ms + offset; DTG is render-only (#C6).
 */

import { formatDtg } from '@blackbox/shared';
import type { Env } from '../types';
import { getChain, getChainHead, hashString, publicKeyB64, sign } from './integrity';
import { TRUST_SET_VERSION, fingerprintSpki } from '@blackbox/shared';
import { verifyChain } from './chain-verdict';
import { getCompleteness } from './completeness';
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
  /** Brief 38 — capture completeness, INDEPENDENT of the chain outcome below. */
  completeness: {
    state: string;
    lastSequence: number | null;
    statement: string;
  };
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
  /** Brief 39 §B — sha256 of the signer SPKI, `sha256:`-prefixed. This is what the verifier
   *  looks up in the trust set it carries; `publicKey` above is an assertion to be checked,
   *  never the authority that checks. */
  signerFingerprint: string;
  trustSetVersion: string;
  signature: string | null;
}

export interface ExportResult {
  manifest: SignedManifest;
  packageHash: string;
  vaultKey: string | null;
  custodyId: string;
}

/** What sealing produces. No recipient and no custody id — those belong to an export. */
export interface SealResult {
  manifest: SignedManifest;
  packageHash: string;
  manifestHash: string;
  vaultKey: string | null;
  tzOffsetMinutes: number | null;
}

/**
 * §F5 — SEAL. Build, sign and seal an event's custody package into the vault.
 *
 * THE SPLIT THIS IS HALF OF. Sealing and exporting used to be one function reachable only
 * through a verified recipient, so a capture nobody exported was never sealed — on production
 * that was every capture ever recorded. Recipient verification gates ACCESS to an artifact; it
 * must not decide whether the artifact EXISTS. Those are different questions and conflating
 * them meant the vault stayed empty while the documentation described it as full.
 *
 * Takes no recipient. Called by the cron drain on every terminal state, including the ones
 * where nobody is left to act.
 *
 * §F4 — IDEMPOTENT. The vault key is content-addressed, the object is never overwritten, and
 * the index insert is OR IGNORE, so a second attempt returns the existing manifest and seals
 * nothing new. Re-export never re-seals.
 */
export async function sealEvent(
  env: Env,
  eventId: string,
  workerOrigin: string,
): Promise<SealResult | null> {
  // Brief 35 §C — a canary event is NEVER sealed. The vault is retained under a 36-month
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
  // Brief 38 — the SECOND, orthogonal axis. Chain integrity asks whether the record is
  // trustworthy; completeness asks whether the recording ended normally. A purged capture
  // keeps the completeness it held at purge, so both render and neither can be mistaken for
  // the other.
  const completeness = await getCompleteness(env, eventId);
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
    completeness: {
      state: completeness.state,
      lastSequence: completeness.lastSequence,
      // §E — the exact sentence, carried in the artifact so the verifier and the report
      // cannot describe the same capture differently.
      statement: completeness.statement,
    },
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
    // Brief 39 §B — the FINGERPRINT of the signer, so a reviewer can name who vouched for
    // this package against a trust set they hold themselves. `publicKey` above stays in the
    // manifest because a reader may want the bytes, but it is an ASSERTION TO BE CHECKED and
    // never the authority that checks: the verifier looks this fingerprint up in its own set
    // and verifies against its own copy.
    signerFingerprint: await fingerprintSpki(publicKeyB64(env) || ''),
    trustSetVersion: TRUST_SET_VERSION,
  };

  const canonical = JSON.stringify(manifestUnsigned);
  const signature = await sign(env, canonical);
  const manifest: SignedManifest = { ...manifestUnsigned, signature };
  const envelope = JSON.stringify(manifest);
  const packageHash = await hashString(envelope);
  const manifestHash = await hashString(canonical);

  // Seal into the vault (content-addressed key → idempotent). We never overwrite an existing
  // sealed object and never delete before expiry. The APPLICATION-level guarantee is this code
  // path; the STORAGE-level one is the R2 lock rule asserted at deploy (Brief 40 §C). Brief 40's
  // correction is explicit that this comment is not retention — the rule is.
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
      'INSERT OR IGNORE INTO vault_objects (vaultKey, eventId, packageHash, sealedAt, expiresAt, tzOffsetMinutes, orgId) VALUES (?, ?, ?, ?, ?, ?, (SELECT orgId FROM events WHERE id = ?))',
    )
      .bind(vaultKey, eventId, packageHash, now, addMonths(now, RETENTION_MONTHS), event.tzOffsetMinutes, eventId)
      .run();
  }

  return { manifest, packageHash, manifestHash, vaultKey, tzOffsetMinutes: event.tzOffsetMinutes };
}

/**
 * §F5 — EXPORT. Hand a verified recipient the sealed package and record the custody transfer.
 *
 * The seal is produced by `sealEvent` and normally already exists by the time anyone asks: it
 * is written on close, by the cron, with nobody acting. This function seals on demand only as
 * a fallback for an event the drain has not reached yet, and that call is idempotent, so an
 * export never creates a second seal.
 *
 * Recipient verification is enforced by the ROUTE, before this is reached. That gate governs
 * who may receive the artifact — never whether it exists.
 */
export async function exportPackage(
  env: Env,
  eventId: string,
  workerOrigin: string,
  recipientId: string,
): Promise<ExportResult | null> {
  const sealed = await sealEvent(env, eventId, workerOrigin);
  if (!sealed) {
    return null;
  }
  const custodyId = `CUS-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'INSERT INTO custody_transfers (id, eventId, recipientId, packageHash, manifestHash, vaultKey, createdAt, tzOffsetMinutes, orgId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT orgId FROM events WHERE id = ?))',
  )
    .bind(
      custodyId,
      eventId,
      recipientId,
      sealed.packageHash,
      sealed.manifestHash,
      sealed.vaultKey ?? '',
      Date.now(),
      sealed.tzOffsetMinutes,
      eventId,
    )
    .run();
  await logRecipientAction(env, recipientId, eventId, 'export', `package ${sealed.packageHash.slice(0, 12)}`);

  return {
    manifest: sealed.manifest,
    packageHash: sealed.packageHash,
    vaultKey: sealed.vaultKey,
    custodyId,
  };
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
