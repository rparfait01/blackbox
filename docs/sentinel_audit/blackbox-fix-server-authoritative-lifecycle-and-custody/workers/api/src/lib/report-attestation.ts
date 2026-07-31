/**
 * Certified-report attestation (Brief 29 §2) — the server half of the signature.
 *
 * WHAT THIS DOES, PRECISELY: it receives two hashes computed on the survivor's device, and
 * signs them TOGETHER WITH facts the server independently holds — the capture-time
 * plaintext commitments and the event's integrity-chain head. It never receives, requests,
 * or infers the report's content. That is what makes signing compatible with zero-knowledge
 * custody: the operator signs a fingerprint it cannot invert.
 *
 * WHY THE SERVER RE-DERIVES THE CUSTODY FACTS. If the attestation simply signed whatever
 * the device sent, the certification would be circular — it would attest that the device
 * said what the device said. Binding the server's OWN commitments hash and chain head makes
 * the document check out against what BLACK BOX witnessed AT CAPTURE TIME, not against a
 * claim made later. That is the difference between a signature and a rubber stamp.
 *
 * WHAT IT DELIBERATELY DOES NOT ATTEST. The signature says: "this evidence fingerprint was
 * signed by BLACK BOX for this event, and these are the commitments and chain head on
 * record." It does NOT say the recording depicts any particular thing, and it does not
 * cover the survivor's statement. Overclaiming here would be the one way to make a
 * verifiable record untrustworthy.
 *
 * FLAG-GATED. No report may be signed while zero-knowledge custody is off — with the flag
 * down there are no commitments, so a "certified" report would be chained to nothing.
 */
import {
  canonicalHash,
  canonicalize,
  REPORT_DOCUMENT_FORMAT,
  REPORT_SIGNATURE_ALG,
  type ReportAttestation,
  type SignedAttestation,
} from '@blackbox/shared';
import type { Env } from '../types';
import { getChainHead } from './integrity';
import { reportPublicKey, signReport } from './report-signing';

export type AttestationResult =
  | { ok: true; signed: SignedAttestation }
  | { ok: false; reason: 'not_owner' | 'no_commitments' | 'no_signing_key' };

/** The event's capture-time commitments, ordered — the same ordering the device uses, so
 *  both sides hash an identical list. */
async function loadCommitments(env: Env, eventId: string): Promise<Array<{ plaintextHash: string; sequence: number }>> {
  const { results } = await env.DB.prepare(
    'SELECT sequence, plaintextHash FROM plaintext_commitments WHERE eventId = ? ORDER BY sequence',
  )
    .bind(eventId)
    .all<{ sequence: number; plaintextHash: string }>();
  // Key order is irrelevant to canonicalize (it sorts), but the ARRAY order is meaning.
  return (results ?? []).map((r) => ({ plaintextHash: r.plaintextHash, sequence: r.sequence }));
}

/** Is the caller the owner of this event? A report is the SURVIVOR'S — org and operator are
 *  never in the path (§5), and there is no cross-account route to a signature. */
async function ownsEvent(env: Env, userId: string, eventId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT userId FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ userId: string | null }>();
  return !!row && row.userId === userId;
}

/**
 * Build and sign an attestation for one event, on behalf of its owner.
 *
 * Refuses (rather than signing something weaker) when: the caller does not own the event;
 * there are no capture-time commitments to chain to; or no signing key is configured. A
 * report that cannot be honestly certified is not certified at all.
 */
export async function signReportAttestation(
  env: Env,
  input: { userId: string; eventId: string; evidenceHash: string; renderedHash: string; now: number },
): Promise<AttestationResult> {
  if (!(await ownsEvent(env, input.userId, input.eventId))) {
    return { ok: false, reason: 'not_owner' };
  }

  const commitments = await loadCommitments(env, input.eventId);
  if (commitments.length === 0) {
    // No capture-time commitments → nothing to chain the certification to. Refusing is the
    // honest outcome; a signature over an unanchored hash would look like proof and be none.
    return { ok: false, reason: 'no_commitments' };
  }

  const publicKey = reportPublicKey(env);
  if (!publicKey) {
    return { ok: false, reason: 'no_signing_key' };
  }

  const head = await getChainHead(env, input.eventId);
  const attestation: ReportAttestation = {
    format: REPORT_DOCUMENT_FORMAT,
    alg: REPORT_SIGNATURE_ALG,
    eventId: input.eventId,
    evidenceHash: input.evidenceHash,
    renderedHash: input.renderedHash,
    commitmentsHash: await canonicalHash(commitments),
    chainHead: head?.chainHead ?? null,
    chainSeq: head?.seq ?? null,
    signedAt: new Date(input.now).toISOString(),
  };

  const signature = await signReport(env, canonicalize(attestation));
  if (!signature) {
    return { ok: false, reason: 'no_signing_key' };
  }
  return { ok: true, signed: { attestation, signature, publicKey } };
}
