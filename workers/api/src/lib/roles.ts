/**
 * Roles model (Brief 9 + Brief 8 contact tabs). A user has up to three Contacts
 * in priority order (primary → secondary → tertiary) and exactly one Guardian
 * (the zero-fail failsafe + coordinator of last resort), plus a server-side
 * guardian on/off toggle. Each slot maps to at most one contact row carrying a
 * single priority-1 reach endpoint (the chosen channel + destination).
 *
 * Contacts are location-only in the network; the current coordinator gets full
 * access (enforced in the dashboard layer). This module is just the slot CRUD.
 */

import { hasReachableRecipient } from '@blackbox/shared';

import { isChannelDeliverable } from '../channels/router';
import type { Env } from '../types';

export type SlotRole = 'contact' | 'guardian' | 'emergency';
export type SlotKey = 'primary' | 'secondary' | 'tertiary' | 'guardian' | 'emergency';

interface SlotAddress {
  role: SlotRole;
  priority: number | null;
}

/** Map the public slot key to a (role, priority) address. */
export function slotAddress(slot: string): SlotAddress | null {
  switch (slot) {
    case 'primary':
      return { role: 'contact', priority: 1 };
    case 'secondary':
      return { role: 'contact', priority: 2 };
    case 'tertiary':
      return { role: 'contact', priority: 3 };
    case 'guardian':
      return { role: 'guardian', priority: null };
    case 'emergency':
      // The emergency-services fallback target (Brief 11). NOT part of the
      // cascade — fired only after the chain completes unclaimed.
      return { role: 'emergency', priority: null };
    default:
      return null;
  }
}

export interface SlotView {
  slot: SlotKey;
  filled: boolean;
  /** The contact row id (Brief 19 — lets the client designate a check-in
   *  recipient by id). Null for an empty slot. */
  id: string | null;
  contactName: string | null;
  channel: string | null;
  destination: string | null;
}

interface ContactRowLite {
  id: string;
  role: string | null;
  priority: number | null;
  contactName: string | null;
}

function keyFor(role: string | null, priority: number | null): SlotKey | null {
  if (role === 'guardian') {
    return 'guardian';
  }
  if (role === 'emergency') {
    return 'emergency';
  }
  if (role === 'contact') {
    return priority === 1 ? 'primary' : priority === 2 ? 'secondary' : priority === 3 ? 'tertiary' : null;
  }
  return null;
}

/** All four slots for a user (filled or empty), each with its primary endpoint. */
export async function listSlots(env: Env, userId: string): Promise<SlotView[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, role, priority, contactName FROM contacts WHERE userId = ?',
  )
    .bind(userId)
    .all<ContactRowLite>();
  const rows = results ?? [];

  const slots: Record<SlotKey, SlotView> = {
    primary: { slot: 'primary', filled: false, id: null, contactName: null, channel: null, destination: null },
    secondary: { slot: 'secondary', filled: false, id: null, contactName: null, channel: null, destination: null },
    tertiary: { slot: 'tertiary', filled: false, id: null, contactName: null, channel: null, destination: null },
    guardian: { slot: 'guardian', filled: false, id: null, contactName: null, channel: null, destination: null },
    emergency: { slot: 'emergency', filled: false, id: null, contactName: null, channel: null, destination: null },
  };

  for (const row of rows) {
    const key = keyFor(row.role, row.priority);
    if (!key) {
      continue;
    }
    const endpoint = await env.DB.prepare(
      'SELECT channel, channelIdentifier FROM contact_endpoints WHERE contactId = ? ORDER BY priority ASC LIMIT 1',
    )
      .bind(row.id)
      .first<{ channel: string; channelIdentifier: string }>();
    slots[key] = {
      slot: key,
      filled: true,
      id: row.id,
      contactName: row.contactName,
      channel: endpoint?.channel ?? null,
      destination: endpoint?.channelIdentifier ?? null,
    };
  }
  return [slots.primary, slots.secondary, slots.tertiary, slots.guardian, slots.emergency];
}

/** Insert or replace a single slot with its chosen channel + destination. */
export async function upsertSlot(
  env: Env,
  userId: string,
  slot: SlotKey,
  input: { contactName: string; userDisplayName: string; channel: string; destination: string },
): Promise<void> {
  const addr = slotAddress(slot);
  if (!addr) {
    return;
  }
  // Remove any existing row(s) for this slot first (keeps one per slot).
  const existing = await env.DB.prepare(
    'SELECT id FROM contacts WHERE userId = ? AND role = ? AND ((? IS NULL AND priority IS NULL) OR priority = ?)',
  )
    .bind(userId, addr.role, addr.priority, addr.priority)
    .all<{ id: string }>();
  const statements = [];
  for (const row of existing.results ?? []) {
    statements.push(env.DB.prepare('DELETE FROM contact_endpoints WHERE contactId = ?').bind(row.id));
    statements.push(env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(row.id));
  }
  const contactId = crypto.randomUUID();
  statements.push(
    env.DB.prepare(
      'INSERT INTO contacts (id, userHash, userId, displayName, contactName, role, priority, createdAt) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)',
    ).bind(contactId, userId, input.userDisplayName, input.contactName, addr.role, addr.priority, Date.now()),
    env.DB.prepare(
      'INSERT INTO contact_endpoints (id, contactId, channel, channelIdentifier, priority, verifiedAt, createdAt) VALUES (?, ?, ?, ?, 1, ?, ?)',
    ).bind(crypto.randomUUID(), contactId, input.channel, input.destination, Date.now(), Date.now()),
  );
  await env.DB.batch(statements);
}

/**
 * Remove a slot entirely (contact row + endpoints). For the three priority-ordered
 * Contact slots, the remaining contacts REINDEX up to close the gap so priority
 * stays contiguous (1,2,3 — never 1,3): removing 'secondary' makes the old
 * 'tertiary' the new 'secondary' (Brief 13 A5/B7). Guardian and emergency are
 * standalone single slots and never reindex.
 */
export async function removeSlot(env: Env, userId: string, slot: SlotKey): Promise<void> {
  const addr = slotAddress(slot);
  if (!addr) {
    return;
  }
  const existing = await env.DB.prepare(
    'SELECT id FROM contacts WHERE userId = ? AND role = ? AND ((? IS NULL AND priority IS NULL) OR priority = ?)',
  )
    .bind(userId, addr.role, addr.priority, addr.priority)
    .all<{ id: string }>();
  const rows = existing.results ?? [];
  const statements = [];
  for (const row of rows) {
    statements.push(env.DB.prepare('DELETE FROM contact_endpoints WHERE contactId = ?').bind(row.id));
    statements.push(env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(row.id));
  }
  // Close the priority gap left by removing a Contact: every contact below the
  // removed priority shifts up by one, keeping the order contiguous. Only when a
  // row was actually removed, so removing an already-empty slot is a no-op.
  if (rows.length > 0 && addr.role === 'contact' && addr.priority != null) {
    statements.push(
      env.DB.prepare(
        "UPDATE contacts SET priority = priority - 1 WHERE userId = ? AND role = 'contact' AND priority > ?",
      ).bind(userId, addr.priority),
    );
  }
  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
}

/**
 * Whether the account has at least one recipient that would ACTUALLY be reached
 * on activation — any deliverable Contact, or the Guardian when enabled and on a
 * deliverable channel. Deliverability is judged by `isChannelDeliverable` (the
 * single source of truth for "is this channel real in this deployment"). This is
 * the authoritative armability check: an alert that would notify no one is the
 * exact deadlock, so arming/activation is gated on this being true. The
 * 'emergency' fallback slot is intentionally excluded — it fires only after the
 * chain completes unclaimed and can never be the sole path to a coordinator.
 */
export async function hasDeliverableRecipient(env: Env, userId: string): Promise<boolean> {
  if (!userId) {
    return false;
  }
  const user = await env.DB.prepare('SELECT guardianEnabled FROM users WHERE id = ?')
    .bind(userId)
    .first<{ guardianEnabled: number }>();
  const guardianEnabled = (user?.guardianEnabled ?? 1) === 1;
  const { results } = await env.DB.prepare(
    "SELECT c.role AS role, ep.channel AS channel FROM contacts c JOIN contact_endpoints ep ON ep.contactId = c.id WHERE c.userId = ? AND c.role IN ('contact','guardian')",
  )
    .bind(userId)
    .all<{ role: string; channel: string }>();
  const recipients = (results ?? []).map((r) => ({
    role: r.role,
    deliverable: isChannelDeliverable(env, r.channel),
  }));
  return hasReachableRecipient(recipients, guardianEnabled);
}

/** How many OTHER users this guardian (by destination) is also a failsafe for. */
export async function guardianLoad(env: Env, destination: string, exceptUserId: string): Promise<number> {
  if (!destination) {
    return 0;
  }
  const row = await env.DB.prepare(
    "SELECT COUNT(DISTINCT c.userId) AS n FROM contacts c JOIN contact_endpoints e ON e.contactId = c.id WHERE c.role = 'guardian' AND e.channelIdentifier = ? AND c.userId != ?",
  )
    .bind(destination, exceptUserId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
