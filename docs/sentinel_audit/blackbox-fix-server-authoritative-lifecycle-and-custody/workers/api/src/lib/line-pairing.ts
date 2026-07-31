/**
 * QR-connect LINE pairing (Brief 18). A user NEVER types or looks up a LINE
 * userId — neither their own nor a contact's. To attach LINE to a slot:
 *
 *  1. Start a pairing for (user, slot) → we mint a nonce and a StillPoint Official
 *     Account deep link carrying a single prefilled token message (`BBX-<nonce>`).
 *  2. We render that deep link as a QR (server-side, never a third-party service).
 *  3. The contact scans/taps it in LINE and sends the prefilled message — no typing.
 *  4. The webhook receives that message: its `source.userId` is the contact's real
 *     U… id. We look up the nonce and bind the userId to the slot automatically.
 *
 * The userId is never shown, typed, or searched for. A LINE contact cannot exist
 * without a userId captured this way (the manual destination path is refused).
 */

import { randomHex } from '@blackbox/shared';
import type { Env } from '../types';
import { qrSvg } from './qr';
import { upsertSlot, type SlotKey } from './roles';

const PAIRING_TTL_MS = 15 * 60 * 1000; // 15 minutes to complete the scan
const DEFAULT_OA_BASIC_ID = '@346hrzaa'; // StillPoint.Life OA (overridable via env)
const TOKEN_RE = /BBX-([0-9a-f]{8,})/i;

function oaBasicId(env: Env): string {
  return env.LINE_OA_BASIC_ID || DEFAULT_OA_BASIC_ID;
}

/** Deep link that opens the OA chat with the one-tap prefilled pairing token. The
 *  basic id keeps its literal `@` (a valid path char; LINE's router does not decode
 *  a percent-encoded `@`); only the message text is percent-encoded. */
function oaMessageDeepLink(env: Env, nonce: string): string {
  return `https://line.me/R/oaMessage/${oaBasicId(env)}/?${encodeURIComponent(`BBX-${nonce}`)}`;
}

export interface StartedPairing {
  nonce: string;
  deepLink: string;
  qrSvg: string;
  expiresAt: number;
}

/** Begin a pairing for (user, slot). Replaces any prior pending pairing for the
 *  same user+slot so a restarted flow never leaves a stale token live. */
export async function startLinePairing(
  env: Env,
  userId: string,
  slot: string,
  contactName: string,
): Promise<StartedPairing> {
  const now = Date.now();
  const nonce = randomHex(12);
  const expiresAt = now + PAIRING_TTL_MS;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM line_pairings WHERE userId = ? AND slot = ? AND status = 'pending'").bind(userId, slot),
    env.DB.prepare(
      'INSERT INTO line_pairings (nonce, userId, slot, contactName, status, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(nonce, userId, slot, contactName, 'pending', now, expiresAt),
  ]);
  const deepLink = oaMessageDeepLink(env, nonce);
  return { nonce, deepLink, qrSvg: qrSvg(deepLink), expiresAt };
}

export interface PairingStatus {
  status: 'pending' | 'connected' | 'expired';
  slot: string;
}

/** Status for the client poll. Never returns the captured userId. */
export async function pairingStatus(
  env: Env,
  userId: string,
  nonce: string,
): Promise<PairingStatus | null> {
  const row = await env.DB.prepare(
    'SELECT slot, status, expiresAt FROM line_pairings WHERE nonce = ? AND userId = ?',
  )
    .bind(nonce, userId)
    .first<{ slot: string; status: string; expiresAt: number }>();
  if (!row) {
    return null;
  }
  if (row.status === 'pending' && Date.now() > row.expiresAt) {
    return { status: 'expired', slot: row.slot };
  }
  return { status: row.status === 'connected' ? 'connected' : 'pending', slot: row.slot };
}

/**
 * Try to bind an inbound LINE message to a pending pairing. Called from the
 * webhook for every message: if the text carries a live `BBX-<nonce>` token, the
 * sender's userId is bound to that slot (a contact LINE endpoint is created) and
 * the pairing is marked connected. Returns true when a bind happened.
 */
export async function bindLinePairingFromMessage(
  env: Env,
  channelUserId: string,
  text: string | undefined,
): Promise<boolean> {
  if (!text) {
    return false;
  }
  const m = TOKEN_RE.exec(text);
  if (!m) {
    return false;
  }
  const nonce = m[1]!.toLowerCase();
  const pairing = await env.DB.prepare(
    "SELECT userId, slot, contactName, expiresAt, status FROM line_pairings WHERE nonce = ?",
  )
    .bind(nonce)
    .first<{ userId: string; slot: string; contactName: string | null; expiresAt: number; status: string }>();
  if (!pairing || pairing.status !== 'pending' || Date.now() > pairing.expiresAt) {
    return false;
  }
  const user = await env.DB.prepare('SELECT name FROM users WHERE id = ?')
    .bind(pairing.userId)
    .first<{ name: string | null }>();
  // Bind the captured userId to the slot — this is the ONLY way a LINE endpoint is
  // created, so a LINE contact always has a real, push-deliverable userId.
  await upsertSlot(env, pairing.userId, pairing.slot as SlotKey, {
    contactName: pairing.contactName ?? 'LINE contact',
    userDisplayName: user?.name ?? 'BLACK BOX user',
    channel: 'line',
    destination: channelUserId,
  });
  await env.DB.prepare(
    "UPDATE line_pairings SET status = 'connected', channelUserId = ?, connectedAt = ? WHERE nonce = ?",
  )
    .bind(channelUserId, Date.now(), nonce)
    .run();
  return true;
}
