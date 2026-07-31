/**
 * Chain verdict (Brief 37 §E) — the four outcomes a verifier must be able to tell apart.
 *
 * These are DIFFERENT FINDINGS about different situations, and collapsing any two destroys
 * the diagnostic value of the whole chain:
 *
 *   VERIFIED            the chain is complete and internally consistent, and the objects it
 *                       attests to are present.
 *   INCOMPLETE          a gap was DECLARED at a known sequence (§B). The capture kept
 *                       running and the evidence was retained; one or more records did not
 *                       make it into the chain, and the chain says so rather than quietly
 *                       being shorter.
 *   PURGED_BY_CONSENT   the chain is intact and its records verify, but the objects it
 *                       attests to were deliberately destroyed on recorded owner consent.
 *   BROKEN              the head does not correspond to a stored record, or a hash does not
 *                       match. This is the tamper signal, and it must mean only that.
 *
 * PURGED_BY_CONSENT IS MANDATORY, NOT OPTIONAL, and production is the reason. At 13c539f,
 * 62 capture objects were purged on the owner's recorded consent while their 63 chain records
 * were deliberately kept — deleting evidence and erasing the record that evidence existed are
 * different acts, and only the first was authorised. Without this outcome the very first
 * export off production would read as BROKEN: a chain attesting to objects that are not
 * there. A verifier that cries tamper over a consented purge is a verifier nobody will
 * believe the day it cries tamper for real.
 *
 * The distinction is not inferred from absence. It is verified against the
 * `chunks.purged_owner_consent` audit row, which names the D1 restore point and the export
 * manifest — so "purged" is a claim with provenance, not the mere fact that bytes are gone.
 */

import { getChain, getChainGaps, getChainHead, hashString } from './integrity';
import type { Env } from '../types';

export type ChainOutcome = 'VERIFIED' | 'INCOMPLETE' | 'PURGED_BY_CONSENT' | 'BROKEN';

export interface ChainVerdict {
  outcome: ChainOutcome;
  /** Human-readable, and specific: a verifier that says only "BROKEN" is not much use. */
  detail: string;
  records: number;
  headSeq: number | null;
  /** Present for INCOMPLETE — the sequence after which the chain is known to be missing. */
  incompleteAtSeq?: number;
  /** Present for PURGED_BY_CONSENT — when consent was recorded, and against what. */
  purge?: { at: number; chunks: number; restorePoint: string | null };
}

/**
 * Compute the verdict for one event. Ordered so the most serious finding wins: a chain that
 * is BOTH broken and purged is BROKEN, because the purge cannot excuse a bad hash.
 */
export async function verifyChain(env: Env, eventId: string): Promise<ChainVerdict> {
  const [records, head, gaps] = await Promise.all([
    getChain(env, eventId),
    getChainHead(env, eventId),
    getChainGaps(env, eventId),
  ]);

  // ---- BROKEN: structural failures, checked before anything can excuse them -------------
  if (head && records.length === 0) {
    return { outcome: 'BROKEN', detail: 'a signed head exists but no records are stored', records: 0, headSeq: head.seq };
  }
  if (records.length > 0) {
    if (!head) {
      return { outcome: 'BROKEN', detail: 'records are stored but no head was ever signed', records: records.length, headSeq: null };
    }
    const last = records[records.length - 1]!;
    // THE EXACT DEFECT THIS BRIEF FIXES: the head naming a record that was never inserted.
    if (head.seq !== last.seq || head.chainHead !== last.chainHash) {
      return {
        outcome: 'BROKEN',
        detail: `head (seq ${head.seq}) does not correspond to the last stored record (seq ${last.seq})`,
        records: records.length,
        headSeq: head.seq,
      };
    }
    // Re-link the whole chain. Every prevHash must be its predecessor's chainHash, and every
    // chainHash must be the hash of (prevHash + recordHash) — recomputed, never trusted.
    let expectedPrev = '0'.repeat(64);
    for (let i = 0; i < records.length; i += 1) {
      const r = records[i]!;
      if (r.seq !== i) {
        return {
          outcome: 'BROKEN',
          detail: `sequence is not contiguous: expected ${i}, found ${r.seq}`,
          records: records.length,
          headSeq: head.seq,
        };
      }
      if (r.prevHash !== expectedPrev) {
        return { outcome: 'BROKEN', detail: `broken link at sequence ${r.seq}`, records: records.length, headSeq: head.seq };
      }
      if ((await hashString(`${r.prevHash}${r.recordHash}`)) !== r.chainHash) {
        return { outcome: 'BROKEN', detail: `hash mismatch at sequence ${r.seq}`, records: records.length, headSeq: head.seq };
      }
      expectedPrev = r.chainHash;
    }
  }

  // ---- INCOMPLETE: a declared gap (§B) --------------------------------------------------
  // Checked BEFORE the purge check: a chain that is both incomplete and purged is
  // INCOMPLETE, because the missing record is a property of the chain itself while the
  // purge is a property of the objects it points at.
  if (gaps.length > 0) {
    const first = gaps[0]!;
    return {
      outcome: 'INCOMPLETE',
      detail: `chain incomplete at sequence ${first.seq}: ${gaps.length} record(s) were not appended (${first.reason})`,
      records: records.length,
      headSeq: head?.seq ?? null,
      incompleteAtSeq: first.seq,
    };
  }

  // ---- PURGED_BY_CONSENT: intact chain, objects deliberately destroyed ------------------
  const purge = await env.DB.prepare(
    "SELECT timestamp, metadataJson FROM audit_log WHERE eventId = ? AND action = 'chunks.purged_owner_consent' ORDER BY timestamp DESC LIMIT 1",
  )
    .bind(eventId)
    .first<{ timestamp: number; metadataJson: string | null }>();
  if (purge) {
    let chunks = 0;
    let restorePoint: string | null = null;
    try {
      const meta = purge.metadataJson ? (JSON.parse(purge.metadataJson) as { chunks?: number; restorePoint?: string }) : null;
      chunks = Number(meta?.chunks ?? 0);
      restorePoint = meta?.restorePoint ?? null;
    } catch {
      /* a malformed metadata blob must not turn a consented purge into a tamper report */
    }
    return {
      outcome: 'PURGED_BY_CONSENT',
      detail: `chain intact; ${chunks} attested object(s) destroyed on recorded owner consent`,
      records: records.length,
      headSeq: head?.seq ?? null,
      purge: { at: purge.timestamp, chunks, restorePoint },
    };
  }

  return {
    outcome: 'VERIFIED',
    detail: records.length === 0 ? 'no records to verify' : `${records.length} record(s) verified and contiguous`,
    records: records.length,
    headSeq: head?.seq ?? null,
  };
}
