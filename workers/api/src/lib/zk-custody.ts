/**
 * Zero-knowledge custody storage (Brief 26, Phase 1) — server-side helpers. The server
 * stores ONLY public keys, wrapped keys (ciphertext under a public key), hashes, and
 * commitments. Nothing here can decrypt anything: there is no plaintext-data-key and no
 * private-key column in the schema, by construction.
 *
 * Dormant until the ENVELOPE_ENCRYPTION_ENABLED flag is armed and the client is uploading
 * envelope material; with the flag off, none of these are called.
 */
import type { Env, OrgKeyGrantRow } from '../types';

/** Store the survivor's public key (SPKI base64). Idempotent — overwrites. */
export async function setUserPubkey(env: Env, userId: string, pubkey: string): Promise<void> {
  await env.DB.prepare('UPDATE users SET pubkey = ?, updatedAt = ? WHERE id = ?')
    .bind(pubkey, Date.now(), userId)
    .run();
}

/** Store the survivor's recovery-wrapped private key (decision A) — opaque to the
 *  server (code-derived key never reaches it). Enables new-device restore with the code. */
export async function setRecoveryKey(env: Env, userId: string, wrapped: string): Promise<void> {
  await env.DB.prepare('UPDATE users SET recoveryWrappedKey = ?, updatedAt = ? WHERE id = ?')
    .bind(wrapped, Date.now(), userId)
    .run();
}
export async function getRecoveryKey(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT recoveryWrappedKey FROM users WHERE id = ?')
    .bind(userId)
    .first<{ recoveryWrappedKey: string | null }>();
  return row?.recoveryWrappedKey ?? null;
}

export interface AccountKeys {
  pubkey: string | null;
  org: { orgPubkey: string; generation: number } | null;
}

/** The keys a capture client needs to wrap a DEK to: its own public key, and (if
 *  enrolled) the org's public key + rotation generation. */
export async function getAccountKeys(env: Env, userId: string): Promise<AccountKeys> {
  const u = await env.DB.prepare(
    'SELECT u.pubkey AS pubkey, o.orgPubkey AS orgPubkey, o.orgPubkeyGeneration AS generation FROM users u LEFT JOIN organizations o ON o.id = u.orgId WHERE u.id = ?',
  )
    .bind(userId)
    .first<{ pubkey: string | null; orgPubkey: string | null; generation: number | null }>();
  return {
    pubkey: u?.pubkey ?? null,
    org: u?.orgPubkey ? { orgPubkey: u.orgPubkey, generation: Number(u.generation ?? 0) } : null,
  };
}

export interface OrgKeyUpload {
  orgPubkey: string;
  generation: number;
  grants: Array<{ seatUserId: string; algId: string; wrappedOrgPrivKey: string }>;
}

/** Set/rotate the org public key + generation, and upsert the per-seat wrapped copies of
 *  the org private key (§5). Full re-wrap on rotation (operator decision): the caller
 *  supplies a grant for every remaining seat at the new generation. */
export async function setOrgKeys(env: Env, orgId: string, upload: OrgKeyUpload): Promise<void> {
  await env.DB.prepare('UPDATE organizations SET orgPubkey = ?, orgPubkeyGeneration = ? WHERE id = ?')
    .bind(upload.orgPubkey, upload.generation, orgId)
    .run();
  const now = Date.now();
  for (const g of upload.grants) {
    await env.DB.prepare(
      `INSERT INTO org_key_grants (id, orgId, seatUserId, keyGeneration, algId, wrappedOrgPrivKey, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(orgId, seatUserId, keyGeneration)
         DO UPDATE SET algId = excluded.algId, wrappedOrgPrivKey = excluded.wrappedOrgPrivKey`,
    )
      .bind(crypto.randomUUID(), orgId, g.seatUserId, upload.generation, g.algId, g.wrappedOrgPrivKey, now)
      .run();
  }
}

/** The calling seat's grant at the current org generation (the wrapped org private key
 *  it opens with its own key). Returns null if none — the seat has no operating access. */
export async function getOrgGrant(env: Env, orgId: string, seatUserId: string): Promise<OrgKeyGrantRow | null> {
  return env.DB.prepare(
    `SELECT g.id, g.orgId, g.seatUserId, g.keyGeneration, g.algId, g.wrappedOrgPrivKey, g.createdAt
       FROM org_key_grants g JOIN organizations o ON o.id = g.orgId
       WHERE g.orgId = ? AND g.seatUserId = ? AND g.keyGeneration = o.orgPubkeyGeneration`,
  )
    .bind(orgId, seatUserId)
    .first<OrgKeyGrantRow>();
}
