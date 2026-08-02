/**
 * Brief 2 Fix A — AN IDENTIFIER IS NOT AN AUTHORITY.
 *
 * `userHash` did two jobs: it named the account and it authorized event operations. Anyone who
 * learned it could open an event on that account, resume one, or write to it. It is long-lived,
 * sits in client storage, and cannot be rotated without breaking the account. The threat is not
 * abstract: an abuser who has had the survivor's phone keeps that value afterwards.
 *
 * A device credential separates the two. The account is still LOOKED UP by identifier; the write
 * is AUTHORIZED by a signature only that device can produce.
 *
 * ═══ §0 GOVERNS EVERYTHING BELOW ═══════════════════════════════════════════════════════════════
 *
 * A credential check must never stand between a survivor and an alert. Two consequences, both
 * load-bearing:
 *
 *   1. THE TRIGGER IS NOT GATED. `POST /v1/events` does not call any of this. Opening an event is
 *      accepted on whatever the caller presents, exactly as before, and the credential is
 *      reconciled afterwards. §0 says so in as many words: "accept the event provisionally and
 *      reconcile asynchronously. Never gate."
 *   2. EVERY COMPARISON HERE FAILS OPEN. On the signup path, refuse-everyone is an outage; on the
 *      alert path it is a survivor who cannot call for help. So an unarmed account, a missing
 *      credential, an unreadable key, or a storage error all resolve to ACCEPT — and say why.
 *      The only outcome that refuses is a signature that was PRESENTED and was WRONG, on an
 *      account that has been deliberately armed.
 *
 * ═══ §E1 MIGRATION — PER ACCOUNT, NEVER A FLAG DATE ════════════════════════════════════════════
 *
 * Existing accounts have no credential. A cutover requiring one before the next trigger would
 * disarm every live user simultaneously. So: provision on next launch, keep accepting `userHash`
 * for an account until that account has a credential, then stop accepting it FOR THAT ACCOUNT.
 * `users.deviceCredentialArmedAt` is the switch and it is per row. There is no global flag and no
 * date, because a date is a promise about every account at once and this cannot be that.
 *
 * ═══ §E3 SHIP DARK ════════════════════════════════════════════════════════════════════════════
 *
 * `DEVICE_CREDENTIAL_ENFORCED` gates arming, not the credential machinery. While it is off,
 * provisioning works, signatures are checked and RECORDED, and nothing is ever refused. That is
 * the Brief 36 pattern: gather evidence that enforcement would not have broken anyone, then arm
 * per account. A global flag that reads armed while still accepting `userHash` is the defect class
 * this project has hit three times, so the flag deliberately cannot express that state — arming is
 * a per-account timestamp, and the flag only decides whether that timestamp may be set.
 */
import { deviceCanonical } from '@blackbox/shared';
import type { Env } from '../types';

/** §C — how far a device clock may be wrong and still be believed. */
export const DEVICE_SKEW_MS = 5 * 60 * 1000;

export type DeviceDecision =
  /** Verified: a signature was presented and it checked out. */
  | 'VERIFIED'
  /** Accepted without a signature because this account is not armed yet (§E1). */
  | 'ACCEPTED_UNARMED'
  /** Accepted despite a problem, because refusing would be worse (§0). Always recorded. */
  | 'ACCEPTED_FAIL_OPEN'
  /** The only refusal: armed account, signature presented, signature wrong. */
  | 'REFUSED';

export interface DeviceVerdict {
  decision: DeviceDecision;
  /** Always populated — a decision an operator cannot explain is not reviewable. */
  detail: string;
  credentialId?: string;
}

export interface DeviceProof {
  credentialId?: string | null;
  signature?: string | null;
  timestamp?: number | null;
}

// §B — THE CANONICAL FORM LIVES IN @blackbox/shared AND BOTH SIDES IMPORT IT.
// Two implementations of the same string can drift — a reordered field, a different separator, a
// lower-cased method — and the symptom would be every signature failing verification, which on an
// armed account means refused writes on the capture path. One function makes that unrepresentable
// rather than merely tested for. Re-exported so existing callers are unaffected.
export { deviceCanonical };

const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Is this account armed? NULL means no — which is the default and the safe answer. */
export async function isAccountArmed(env: Env, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const row = await env.DB.prepare('SELECT deviceCredentialArmedAt FROM users WHERE id = ?')
    .bind(userId)
    .first<{ deviceCredentialArmedAt: number | null }>();
  return row?.deviceCredentialArmedAt != null;
}

/**
 * Verify an event-scoped write. Returns a VERDICT rather than a boolean, because "accepted" and
 * "accepted because we could not check" are different facts and the second one has to be visible.
 *
 * Never throws. A thrown exception here would become a 500 on the capture path.
 */
export async function verifyDeviceProof(
  env: Env,
  input: {
    userId: string | null;
    eventId: string;
    method: string;
    path: string;
    bodyDigestHex: string;
    proof: DeviceProof;
    now?: number;
  },
): Promise<DeviceVerdict> {
  const now = input.now ?? Date.now();
  try {
    const armed = await isAccountArmed(env, input.userId);

    if (!input.proof.credentialId || !input.proof.signature) {
      // §E1 — an account with no credential yet is the normal state during migration, not a fault.
      return armed
        ? {
            decision: 'ACCEPTED_FAIL_OPEN',
            detail: 'account is armed but the write carried no device proof — accepted, and recorded',
          }
        : { decision: 'ACCEPTED_UNARMED', detail: 'account has no device credential yet (§E1 migration)' };
    }

    const cred = await env.DB.prepare(
      'SELECT id, publicKey, revokedAt FROM device_credentials WHERE id = ? AND userId = ?',
    )
      .bind(input.proof.credentialId, input.userId ?? '')
      .first<{ id: string; publicKey: string; revokedAt: number | null }>();

    if (!cred) {
      return armed
        ? { decision: 'REFUSED', detail: 'device credential is unknown for this account' }
        : { decision: 'ACCEPTED_UNARMED', detail: 'unknown credential, but this account is not armed' };
    }
    if (cred.revokedAt != null) {
      return armed
        ? { decision: 'REFUSED', detail: 'device credential was revoked', credentialId: cred.id }
        : { decision: 'ACCEPTED_UNARMED', detail: 'revoked credential, but this account is not armed', credentialId: cred.id };
    }

    // §C — clock. A skewed device must still be able to write; the window is generous and the
    // failure is fail-open rather than a refusal, because a wrong clock is not evidence of an
    // attacker and a survivor does not get to fix it mid-incident.
    const ts = Number(input.proof.timestamp);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > DEVICE_SKEW_MS) {
      return {
        decision: 'ACCEPTED_FAIL_OPEN',
        detail: `device timestamp outside the ${DEVICE_SKEW_MS / 60000}-minute window — accepted, and recorded`,
        credentialId: cred.id,
      };
    }

    const key = await crypto.subtle.importKey(
      'spki',
      b64ToBytes(cred.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      hexToBytes(input.proof.signature),
      new TextEncoder().encode(
        deviceCanonical({
          method: input.method,
          path: input.path,
          eventId: input.eventId,
          bodyDigestHex: input.bodyDigestHex,
          timestamp: ts,
        }),
      ),
    );

    if (ok) return { decision: 'VERIFIED', detail: 'device signature verified', credentialId: cred.id };

    // THE ONLY REFUSAL. A signature was presented, the account was armed, and it did not check
    // out. That is the case this whole brief exists to reject.
    return armed
      ? { decision: 'REFUSED', detail: 'device signature did not verify', credentialId: cred.id }
      : {
          decision: 'ACCEPTED_UNARMED',
          detail: 'signature did not verify, but this account is not armed — accepted and recorded',
          credentialId: cred.id,
        };
  } catch (err) {
    // §0 — an infrastructure failure must never become a refusal on the capture path.
    return {
      decision: 'ACCEPTED_FAIL_OPEN',
      detail: `device verification could not run (${String(err).slice(0, 80)}) — accepted, and recorded`,
    };
  }
}

/** §A — register a device. Identity boundary only; never called from the event DO (§E4). */
export async function registerDevice(
  env: Env,
  input: { userId: string; publicKey: string; label?: string | null },
): Promise<{ ok: boolean; id?: string; reason?: string }> {
  const spki = (input.publicKey ?? '').trim();
  if (!spki || spki.length > 1000) return { ok: false, reason: 'invalid_public_key' };
  try {
    // Reject a key we could never verify with, at registration rather than at capture time.
    await crypto.subtle.importKey('spki', b64ToBytes(spki), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    return { ok: false, reason: 'invalid_public_key' };
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO device_credentials (id, userId, publicKey, label, createdAt) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, input.userId, spki, (input.label ?? '').slice(0, 60) || null, Date.now())
    .run();
  return { ok: true, id };
}

/** §D — revocation is immediate. Historical records signed while valid are untouched. */
export async function revokeDevice(
  env: Env,
  input: { userId: string; credentialId: string; reason?: string | null },
): Promise<boolean> {
  const r = await env.DB.prepare(
    'UPDATE device_credentials SET revokedAt = ?, revokedReason = ? WHERE id = ? AND userId = ? AND revokedAt IS NULL',
  )
    .bind(Date.now(), (input.reason ?? '').slice(0, 120) || null, input.credentialId, input.userId)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function listDevices(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    'SELECT id, label, createdAt, lastSeenAt, revokedAt, revokedReason FROM device_credentials WHERE userId = ? ORDER BY createdAt ASC',
  )
    .bind(userId)
    .all();
  return results ?? [];
}

/** Acceptance 10 — per-account credential coverage for the readiness panel. */
export async function credentialCoverage(env: Env) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users) AS accounts,
       (SELECT COUNT(DISTINCT userId) FROM device_credentials WHERE revokedAt IS NULL) AS withCredential,
       (SELECT COUNT(*) FROM users WHERE deviceCredentialArmedAt IS NOT NULL) AS armed`,
  ).first<{ accounts: number; withCredential: number; armed: number }>();
  const accounts = Number(row?.accounts ?? 0);
  const withCredential = Number(row?.withCredential ?? 0);
  const armed = Number(row?.armed ?? 0);
  return {
    accounts,
    withCredential,
    armed,
    // Stated as counts, never as a bare percentage: "94%" hides which accounts are the other 6%.
    summary:
      accounts === 0
        ? 'DEVICE CREDENTIALS: no accounts'
        : `DEVICE CREDENTIALS: ${withCredential}/${accounts} provisioned · ${armed} armed · ` +
          `${accounts - withCredential} still accepting userHash (§E1 migration)`,
  };
}
