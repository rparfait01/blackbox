import type { Env } from '../types';

/**
 * Brief 53 §C — ORG CUSTODY. BUILT DARK, BEHIND A FLAG THAT DEFAULTS OFF.
 *
 * ═══ THE FLAG IS NOT A ROLLOUT CONTROL. IT IS THE §C4 GATE. ═══════════════════════════════════
 *
 * Brief 26 §5 requires two reviews before this reaches production, and BOTH ARE UNMET:
 *
 *   1. INDEPENDENT CRYPTO REVIEW of the primitives and envelope design.
 *      What it needs: an external reviewer with no stake in shipping, given the envelope spec
 *      (per-capture DEK, counter IV, AAD binding, per-seat org-key wrapping) and asked to break
 *      it. The review-answers document in this repo is NOT a substitute — it is our own answers
 *      to our own questions, which is the thing a review exists to check.
 *
 *   2. LEGAL REVIEW OF CHAIN OF CUSTODY — is re-encrypted evidence admissible?
 *      What it needs: counsel in the target jurisdiction (Okinawa/Japan first) answering whether
 *      a recording decrypted and re-encrypted to a recipient still satisfies chain-of-custody
 *      requirements, and what the signed custody manifest must contain to support it.
 *      Perfect cryptography is not admissible evidence.
 *
 * Until both clear, every route in this module refuses. Not "returns empty" — REFUSES, with a
 * named reason, so a caller can never mistake dark for working.
 *
 * ═══ THE TWO POWERS (§C5.4) ══════════════════════════════════════════════════════════════════
 *
 * The ORG KEY OPERATES: a seat can read what the org already holds.
 * The SURVIVOR'S AUTHORITY RELEASES: only she can send content to a third party.
 *
 * These are never one permission check. `recordRelease` requires an explicit survivor
 * authorization that no seat can supply, and the schema makes a release without one unstorable.
 *
 * ═══ WHAT THIS SERVER CAN AND CANNOT DO ══════════════════════════════════════════════════════
 *
 * It cannot rotate, re-wrap, or re-encrypt anything. It holds no plaintext org key and no
 * plaintext DEK — that is the entire point of the design. Every function here RECORDS an act
 * performed client-side by a seat holding real key material, and verifies what it can. A server
 * that could perform these operations would be a server that could read every capture.
 */

/** Why a call was refused. Never an empty success. */
export type CustodyRefusal = 'dark_pending_review' | 'not_authorized' | 'invalid_input' | 'unknown_org';

export interface CustodyResult<T> {
  ok: boolean;
  refusal?: CustodyRefusal;
  detail?: string;
  value?: T;
}

/**
 * §C4 — is org custody armed?
 *
 * Default FALSE, and deliberately not a truthiness check on an unset variable: an absent binding
 * and an explicit 'false' must behave identically, and only the exact string 'true' arms it. The
 * inverse convention to the capture-path flags is intentional — those fail OPEN because a
 * survivor mid-incident must keep recording, and this fails CLOSED because releasing a survivor's
 * evidence to a third party on an unreviewed crypto design is the harm, not the mitigation.
 */
export function orgCustodyArmed(env: Env): boolean {
  return (env.ORG_CUSTODY_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/** The refusal every route returns while the §C4 gates are open. */
export function darkRefusal<T>(): CustodyResult<T> {
  return {
    ok: false,
    refusal: 'dark_pending_review',
    detail:
      'Org custody is not enabled. It ships dark until two gates clear: an independent crypto ' +
      'review of the envelope design, and a legal review of whether re-encrypted evidence is ' +
      'admissible as chain of custody. Both are unmet.',
  };
}

export interface RotationRecord {
  orgId: string;
  fromGeneration: number;
  toGeneration: number;
  reason: 'seat_offboarded' | 'scheduled' | 'suspected_compromise';
  performedBySeatId: string;
  departedSeatId: string | null;
  seatsRewrapped: number;
  signature: string | null;
  signatureAlgId: string | null;
}

/**
 * §C2 state 8 — record a rotation a SEAT performed.
 *
 * The server witnesses; it does not rotate. The re-wrap itself happens client-side because the
 * server has no plaintext org key to re-wrap with, and if it did, offboarding a seat would be
 * theatre — the server could read everything the departed seat could.
 *
 * The generation must ADVANCE. A rotation that does not increase the generation would leave the
 * departed seat's grant valid at the current generation, which is the precise failure this
 * operation exists to prevent, and it would look like a successful offboarding in the log.
 */
export async function recordRotation(env: Env, input: RotationRecord): Promise<CustodyResult<{ id: string }>> {
  if (!orgCustodyArmed(env)) return darkRefusal();
  if (input.toGeneration <= input.fromGeneration) {
    return {
      ok: false,
      refusal: 'invalid_input',
      detail:
        `rotation must ADVANCE the generation (${input.fromGeneration} → ${input.toGeneration}); ` +
        'a non-advancing rotation leaves the departed seat’s grant valid and still reads as success',
    };
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO org_key_rotations (id, orgId, fromGeneration, toGeneration, reason, performedBySeatId, ' +
      'departedSeatId, seatsRewrapped, signature, signatureAlgId, createdAt) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      id,
      input.orgId,
      input.fromGeneration,
      input.toGeneration,
      input.reason,
      input.performedBySeatId,
      input.departedSeatId,
      input.seatsRewrapped,
      input.signature,
      input.signatureAlgId,
      Date.now(),
    )
    .run();
  return { ok: true, value: { id } };
}

export interface ReleaseRecord {
  eventId: string;
  orgId: string | null;
  /** THE SURVIVOR. A seat cannot supply this, and the schema will not store a release without it. */
  authorizedByUserId: string;
  recipientLabel: string;
  recipientPubkey: string;
  algId: string;
  purpose: string | null;
  wrappedDek: string;
  expiresAt: number | null;
}

/**
 * §C2 state 7 — record a release the SURVIVOR authorized.
 *
 * Never a download-and-forward and never a standing copy: the DEK is re-wrapped to one named
 * recipient's key, and the row names who, when, why, and until when.
 *
 * The authorization is checked against the event's OWNER. An org seat with every permission the
 * console can grant cannot release a survivor's evidence — that is §C5.4 made structural rather
 * than procedural, and it is the difference between a shelter that operates on her behalf and a
 * shelter that can publish her recordings.
 */
export async function recordRelease(env: Env, input: ReleaseRecord): Promise<CustodyResult<{ id: string }>> {
  if (!orgCustodyArmed(env)) return darkRefusal();
  if (!input.authorizedByUserId || !input.recipientPubkey || !input.wrappedDek) {
    return { ok: false, refusal: 'invalid_input', detail: 'authorization, recipient key and wrapped DEK are all required' };
  }

  // THE SURVIVOR, verified server-side against the event's owner — never taken on the caller's word.
  const owner = await env.DB.prepare('SELECT userId FROM events WHERE id = ?')
    .bind(input.eventId)
    .first<{ userId: string | null }>();
  if (!owner) return { ok: false, refusal: 'invalid_input', detail: 'no such event' };
  if (owner.userId !== input.authorizedByUserId) {
    return {
      ok: false,
      refusal: 'not_authorized',
      detail:
        'release must be authorized by the event owner. Operating on a survivor’s behalf is not ' +
        'the same power as releasing her evidence to a third party (§C5.4).',
    };
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO release_grants (id, eventId, orgId, authorizedByUserId, recipientLabel, recipientPubkey, ' +
      'algId, purpose, wrappedDek, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      id,
      input.eventId,
      input.orgId,
      input.authorizedByUserId,
      input.recipientLabel,
      input.recipientPubkey,
      input.algId,
      input.purpose,
      input.wrappedDek,
      input.expiresAt,
      Date.now(),
    )
    .run();
  return { ok: true, value: { id } };
}

/**
 * §C2 — the watermark, and the access log that makes it useful.
 *
 * Derived from the identifiers a leak investigation needs to walk backwards: org, seat, event,
 * generation. It is recorded on EVERY decrypt, export and release, because a watermark nobody
 * logged is a string in a file that proves nothing about who put it there.
 *
 * §C3 is blunt about what this is for. Re-wrapping on offboarding stops future server-mediated
 * access; it cannot un-see what a seat already saw. Watermarking and audit are the real control,
 * and the DPA says so rather than implying revocation is retroactive.
 */
export function watermarkFor(input: {
  eventId: string;
  orgId: string | null;
  seatUserId: string;
  keyGeneration: number | null;
  at: number;
}): string {
  return [
    'bbx',
    input.orgId ?? 'noorg',
    input.seatUserId,
    input.eventId,
    `g${input.keyGeneration ?? 0}`,
    String(input.at),
  ].join(':');
}

export async function logCaptureAccess(
  env: Env,
  input: {
    eventId: string;
    sequence: number | null;
    orgId: string | null;
    seatUserId: string;
    keyGeneration: number | null;
    accessKind: 'decrypt' | 'export' | 'release';
  },
): Promise<CustodyResult<{ watermark: string }>> {
  if (!orgCustodyArmed(env)) return darkRefusal();
  const at = Date.now();
  const watermark = watermarkFor({ ...input, at });
  await env.DB.prepare(
    'INSERT INTO capture_access_log (id, eventId, sequence, orgId, seatUserId, keyGeneration, watermark, accessKind, createdAt) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      crypto.randomUUID(),
      input.eventId,
      input.sequence,
      input.orgId,
      input.seatUserId,
      input.keyGeneration,
      watermark,
      input.accessKind,
      at,
    )
    .run();
  return { ok: true, value: { watermark } };
}

/**
 * §C2 decision B — store a location point SEALED.
 *
 * `wrapped_locations` has no lat/lon column: the point is unrepresentable in plaintext here.
 *
 * The plaintext `locations_index` still exists and is still what the live responder map reads
 * DURING an incident. Cutting that over is a separate flagged step after §C4, and it is not done
 * quietly as part of this: a survivor mid-event is not the person to discover an encryption
 * migration, and a responder who cannot see her position is a worse outcome than a server that
 * can.
 */
export async function storeWrappedLocation(
  env: Env,
  input: { eventId: string; sequence: number; orgId: string | null; algId: string; iv: string; ciphertext: string; recordedAt: number },
): Promise<CustodyResult<{ id: string }>> {
  if (!orgCustodyArmed(env)) return darkRefusal();
  if (!input.iv || !input.ciphertext) {
    return { ok: false, refusal: 'invalid_input', detail: 'iv and ciphertext are required' };
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT OR REPLACE INTO wrapped_locations (id, eventId, sequence, orgId, algId, iv, ciphertext, recordedAt, createdAt) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, input.eventId, input.sequence, input.orgId, input.algId, input.iv, input.ciphertext, input.recordedAt, Date.now())
    .run();
  return { ok: true, value: { id } };
}
