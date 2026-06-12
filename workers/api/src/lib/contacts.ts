/**
 * Contact registry queries (W-spine). A contact is a person (keyed by the user's
 * hash); their reach methods live in contact_endpoints, tried in priority order
 * by the NotificationRouter. v0 keeps exactly one contact per userHash (the
 * pilot is 1:1), but that contact may now have multiple endpoints.
 */

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

/** Resolve the contact for an event, preferring its userId, then legacy userHash. */
export async function getContactForEvent(
  env: Env,
  event: { userId: string | null; userHash: string | null },
): Promise<ContactRow | null> {
  if (event.userId) {
    const byUser = await getContactByUserId(env, event.userId);
    if (byUser) {
      return byUser;
    }
  }
  return event.userHash ? getContact(env, event.userHash) : null;
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
    const { results } = await env.DB.prepare(
      "SELECT id, displayName, role FROM contacts WHERE userId = ? AND role IN ('contact','guardian') ORDER BY CASE role WHEN 'guardian' THEN 1 ELSE 0 END, priority ASC",
    )
      .bind(event.userId)
      .all<{ id: string; displayName: string; role: string | null }>();
    // The 'emergency' slot is NOT in the cascade — it is the fallback fired only
    // after the chain completes unclaimed (Brief 11).
    const rows = (results ?? []).filter((r) => r.role !== 'guardian' || guardianEnabled);
    if (rows.length > 0) {
      return rows.map((r) => ({ id: r.id, displayName: r.displayName }));
    }
  }
  const legacy = await getContactForEvent(env, event);
  return legacy ? [{ id: legacy.id, displayName: legacy.displayName }] : [];
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
