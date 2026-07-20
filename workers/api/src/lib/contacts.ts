/**
 * Contact registry queries (W-spine). A contact is a person (keyed by the user's
 * hash); their reach methods live in contact_endpoints, tried in priority order
 * by the NotificationRouter. v0 keeps exactly one contact per userHash (the
 * pilot is 1:1), but that contact may now have multiple endpoints.
 */

import { consentGateEnforced } from './consent';
import type { ContactEndpointRow, ContactRow, Env } from '../types';

export interface EndpointInput {
  channel: string;
  channelIdentifier: string;
  priority: number;
}

export async function getContact(env: Env, userHash: string): Promise<ContactRow | null> {
  if (!userHash) {
    return null;
  }
  const row = await env.DB.prepare(
    'SELECT id, userHash, displayName, createdAt FROM contacts WHERE userHash = ?',
  )
    .bind(userHash)
    .first<ContactRow>();
  return row ?? null;
}

export async function getContactByUserId(env: Env, userId: string): Promise<ContactRow | null> {
  if (!userId) {
    return null;
  }
  const row = await env.DB.prepare(
    'SELECT id, userHash, displayName, createdAt FROM contacts WHERE userId = ?',
  )
    .bind(userId)
    .first<ContactRow>();
  return row ?? null;
}

/**
 * Resolve the single contact for an event, preferring its userId, then legacy
 * userHash. CONSENT-GATED (§4): only a `confirmed` contact is returned — this is a
 * recipient resolver (escalation, legacy check-in), so an unconfirmed contact must
 * never surface here. Contact creation uses getContactByUserId directly and is
 * deliberately NOT gated.
 */
export async function getContactForEvent(
  env: Env,
  event: { userId: string | null; userHash: string | null },
): Promise<ContactRow | null> {
  const gate = consentGateEnforced(env) ? "AND status = 'confirmed'" : '';
  if (event.userId) {
    const byUser = await env.DB.prepare(
      `SELECT id, userHash, displayName, createdAt FROM contacts WHERE userId = ? ${gate} ORDER BY CASE role WHEN 'guardian' THEN 1 ELSE 0 END, priority ASC LIMIT 1`,
    )
      .bind(event.userId)
      .first<ContactRow>();
    if (byUser) {
      return byUser;
    }
  }
  if (event.userHash) {
    return (
      (await env.DB.prepare(
        `SELECT id, userHash, displayName, createdAt FROM contacts WHERE userHash = ? ${gate}`,
      )
        .bind(event.userHash)
        .first<ContactRow>()) ?? null
    );
  }
  return null;
}

/**
 * All contacts the activation alert fans out to (Brief 10 P0 + Brief 9 roles):
 * every Contact in priority order, then the Guardian if enabled. Resolved fresh
 * each call (no stale/cached recipient list) so a newly added contact is always
 * included. Falls back to the single legacy contact for pre-roles events.
 */
export async function listReachableContacts(
  env: Env,
  event: { userId: string | null; userHash: string | null },
): Promise<Array<{ id: string; displayName: string }>> {
  if (event.userId) {
    const user = await env.DB.prepare('SELECT guardianEnabled FROM users WHERE id = ?')
      .bind(event.userId)
      .first<{ guardianEnabled: number }>();
    const guardianEnabled = (user?.guardianEnabled ?? 1) === 1;
    // CONSENT GATE (Contact Consent §4): once armed, only a `confirmed` contact is
    // ever notified — trigger, escalation, closure ping, check-in, all of it. A
    // pending/declined contact is excluded here, at the single point every alert
    // path resolves its recipients, so no outbound route can leak past it. The
    // guardian is gated with zero exception: notifying someone who never agreed to
    // the role is the exact harm this brief closes. Behind the flag (infra first).
    const { results } = await env.DB.prepare(
      "SELECT id, displayName, role, status FROM contacts WHERE userId = ? AND role IN ('contact','guardian') ORDER BY CASE role WHEN 'guardian' THEN 1 ELSE 0 END, priority ASC",
    )
      .bind(event.userId)
      .all<{ id: string; displayName: string; role: string | null; status: string | null }>();
    const gate = consentGateEnforced(env);
    const rows = (results ?? [])
      .filter((r) => r.role !== 'guardian' || guardianEnabled)
      .filter((r) => !gate || r.status === 'confirmed');
    if (rows.length > 0) {
      return rows.map((r) => ({ id: r.id, displayName: r.displayName }));
    }
  }
  const legacy = await getContactForEvent(env, event);
  return legacy ? [{ id: legacy.id, displayName: legacy.displayName }] : [];
}

/**
 * The full ACTIVATION cascade list, in fire order: priority contacts → guardian →
 * emergency (last). Same as listReachableContacts but with the 'emergency' slot
 * appended as the final step, so when populated it fires at its cascade window
 * (T + interval*lastIndex) if no coordinator has claimed by then. Emergency is the
 * cascade tail ONLY — closure/escalation pings still use listReachableContacts.
 */
export async function listCascadeContacts(
  env: Env,
  event: { userId: string | null; userHash: string | null },
): Promise<Array<{ id: string; displayName: string }>> {
  const base = await listReachableContacts(env, event);
  if (!event.userId) {
    return base;
  }
  const emergency = await env.DB.prepare(
    "SELECT id, displayName FROM contacts WHERE userId = ? AND role = 'emergency' LIMIT 1",
  )
    .bind(event.userId)
    .first<{ id: string; displayName: string }>();
  return emergency ? [...base, { id: emergency.id, displayName: emergency.displayName }] : base;
}

/** Get-or-create the contact row for a user (used when a guardian accepts). */
export async function ensureContactForUser(
  env: Env,
  userId: string,
  displayName: string,
): Promise<string> {
  const existing = await getContactByUserId(env, userId);
  if (existing) {
    return existing.id;
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO contacts (id, userHash, userId, displayName, createdAt) VALUES (?, NULL, ?, ?, ?)',
  )
    .bind(id, userId, displayName, Date.now())
    .run();
  return id;
}

/** Append one endpoint to a contact at the given priority. */
export async function addEndpoint(
  env: Env,
  contactId: string,
  channel: string,
  channelIdentifier: string,
  priority: number,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO contact_endpoints (id, contactId, channel, channelIdentifier, priority, verifiedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(crypto.randomUUID(), contactId, channel, channelIdentifier, priority, Date.now(), Date.now())
    .run();
}

/**
 * Set the contact's single preferred endpoint at priority 1 (Fix Brief 3 contact
 * setup). The user picks ONE channel + destination; this replaces the contact's
 * endpoints with that one at priority 1. Returns the contactId.
 */
export async function setPrimaryEndpoint(
  env: Env,
  userId: string,
  displayName: string,
  channel: string,
  channelIdentifier: string,
): Promise<string> {
  const contactId = await ensureContactForUser(env, userId, displayName);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM contact_endpoints WHERE contactId = ?').bind(contactId),
    env.DB.prepare(
      'INSERT INTO contact_endpoints (id, contactId, channel, channelIdentifier, priority, verifiedAt, createdAt) VALUES (?, ?, ?, ?, 1, ?, ?)',
    ).bind(crypto.randomUUID(), contactId, channel, channelIdentifier, Date.now(), Date.now()),
  ]);
  return contactId;
}

export async function getContactEndpoints(
  env: Env,
  contactId: string,
): Promise<ContactEndpointRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, contactId, channel, channelIdentifier, priority, verifiedAt, createdAt FROM contact_endpoints WHERE contactId = ? ORDER BY priority ASC',
  )
    .bind(contactId)
    .all<ContactEndpointRow>();
  return results ?? [];
}

/**
 * Upsert the single contact for a userHash and replace its endpoints. Deletes
 * any existing contact (and its endpoints) for the userHash first, so this stays
 * 1:1 in v0.
 */
export async function upsertContact(
  env: Env,
  input: { userHash: string; displayName: string; endpoints: EndpointInput[] },
): Promise<{ contact: ContactRow; endpointCount: number }> {
  const contact: ContactRow = {
    id: crypto.randomUUID(),
    userHash: input.userHash,
    displayName: input.displayName,
    createdAt: Date.now(),
  };

  const statements = [
    // Remove endpoints of any prior contact(s) for this userHash, then the
    // contact(s), then insert the fresh contact + endpoints.
    env.DB.prepare(
      'DELETE FROM contact_endpoints WHERE contactId IN (SELECT id FROM contacts WHERE userHash = ?)',
    ).bind(input.userHash),
    env.DB.prepare('DELETE FROM contacts WHERE userHash = ?').bind(input.userHash),
    env.DB.prepare(
      'INSERT INTO contacts (id, userHash, displayName, createdAt) VALUES (?, ?, ?, ?)',
    ).bind(contact.id, contact.userHash, contact.displayName, contact.createdAt),
    ...input.endpoints.map((e) =>
      env.DB.prepare(
        'INSERT INTO contact_endpoints (id, contactId, channel, channelIdentifier, priority, verifiedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        crypto.randomUUID(),
        contact.id,
        e.channel,
        e.channelIdentifier,
        e.priority,
        null,
        Date.now(),
      ),
    ),
  ];
  await env.DB.batch(statements);
  return { contact, endpointCount: input.endpoints.length };
}

/** List contacts with their endpoints, for admin viewing / pairing setup. */
export async function listContacts(
  env: Env,
): Promise<Array<ContactRow & { endpoints: ContactEndpointRow[] }>> {
  const { results: contacts } = await env.DB.prepare(
    'SELECT id, userHash, displayName, createdAt FROM contacts ORDER BY createdAt DESC',
  ).all<ContactRow>();
  const out: Array<ContactRow & { endpoints: ContactEndpointRow[] }> = [];
  for (const contact of contacts ?? []) {
    out.push({ ...contact, endpoints: await getContactEndpoints(env, contact.id) });
  }
  return out;
}

/** Record a LINE follow so the admin can look up the contact's channelUserId. */
export async function recordFollow(env: Env, channelUserId: string): Promise<void> {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO line_pairing (channelUserId, followedAt) VALUES (?, ?)',
  )
    .bind(channelUserId, Date.now())
    .run();
}

export async function listFollows(
  env: Env,
): Promise<Array<{ channelUserId: string; followedAt: number }>> {
  const { results } = await env.DB.prepare(
    'SELECT channelUserId, followedAt FROM line_pairing ORDER BY followedAt DESC',
  ).all<{ channelUserId: string; followedAt: number }>();
  return results ?? [];
}
