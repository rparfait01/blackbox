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
import { consentGateEnforced } from './consent';
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
  /** The PREFERRED channel (endpoint priority 1) — tried first. */
  channel: string | null;
  destination: string | null;
  /** The FALLBACK channel (endpoint priority 2), tried only if the preferred one
   *  fails. Null when the contact has just one channel. */
  fallbackChannel: string | null;
  fallbackDestination: string | null;
  /** Consent status (§0). Only a 'confirmed' contact is ever dispatched to. Null
   *  for an empty slot. */
  status: 'pending' | 'confirmed' | 'declined' | null;
}

interface ContactRowLite {
  id: string;
  role: string | null;
  priority: number | null;
  contactName: string | null;
  status: string | null;
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
    'SELECT id, role, priority, contactName, status FROM contacts WHERE userId = ?',
  )
    .bind(userId)
    .all<ContactRowLite>();
  const rows = results ?? [];

  const slots: Record<SlotKey, SlotView> = {
    primary: { slot: 'primary', filled: false, id: null, contactName: null, channel: null, destination: null, fallbackChannel: null, fallbackDestination: null, status: null },
    secondary: { slot: 'secondary', filled: false, id: null, contactName: null, channel: null, destination: null, fallbackChannel: null, fallbackDestination: null, status: null },
    tertiary: { slot: 'tertiary', filled: false, id: null, contactName: null, channel: null, destination: null, fallbackChannel: null, fallbackDestination: null, status: null },
    guardian: { slot: 'guardian', filled: false, id: null, contactName: null, channel: null, destination: null, fallbackChannel: null, fallbackDestination: null, status: null },
    emergency: { slot: 'emergency', filled: false, id: null, contactName: null, channel: null, destination: null, fallbackChannel: null, fallbackDestination: null, status: null },
  };

  for (const row of rows) {
    const key = keyFor(row.role, row.priority);
    if (!key) {
      continue;
    }
    // Read BOTH endpoints in fire order: priority 1 is the preferred channel, 2 is
    // the fallback. Previously this took only the first (LIMIT 1), which is why a
    // second channel would have been invisible to the UI even once stored.
    const { results: eps } = await env.DB.prepare(
      'SELECT channel, channelIdentifier FROM contact_endpoints WHERE contactId = ? ORDER BY priority ASC LIMIT 2',
    )
      .bind(row.id)
      .all<{ channel: string; channelIdentifier: string }>();
    const [preferred, fallback] = eps ?? [];
    slots[key] = {
      slot: key,
      filled: true,
      id: row.id,
      contactName: row.contactName,
      channel: preferred?.channel ?? null,
      destination: preferred?.channelIdentifier ?? null,
      fallbackChannel: fallback?.channel ?? null,
      fallbackDestination: fallback?.channelIdentifier ?? null,
      status: (row.status as SlotView['status']) ?? 'confirmed',
    };
  }
  return [slots.primary, slots.secondary, slots.tertiary, slots.guardian, slots.emergency];
}

/**
 * Insert or replace a single slot with its PREFERRED channel and, optionally, a
 * FALLBACK channel (§2).
 *
 * The fallback is what makes the dispatcher's retry loop real. `dispatch()` has
 * always walked a contact's endpoints in priority order until one delivers — but
 * this function only ever wrote ONE endpoint, so no contact ever had a second
 * channel and the fallback path could never fire. The machinery existed with
 * nothing to feed it. A second endpoint at priority 2 is the whole fix.
 */
export interface UpsertResult {
  /** The consent status the contact was written with. */
  status: 'pending' | 'confirmed';
  /** True when a confirmation SMS must be sent (a new/changed SMS number). */
  confirmationNeeded: boolean;
}

export async function upsertSlot(
  env: Env,
  userId: string,
  slot: SlotKey,
  input: {
    contactName: string;
    userDisplayName: string;
    channel: string;
    /** Already NORMALIZED by the route (E.164 for sms) before it reaches here. */
    destination: string;
    /** Optional second channel, tried only if the preferred one fails. */
    fallbackChannel?: string | null;
    fallbackDestination?: string | null;
  },
): Promise<UpsertResult> {
  const addr = slotAddress(slot);
  if (!addr) {
    return { status: 'confirmed', confirmationNeeded: false };
  }
  // Capture the prior status + prior preferred endpoint for this slot BEFORE the
  // delete below, so consent survives an innocent edit but is re-sought on a real
  // change. This function tears down and rebuilds the whole contact on every save,
  // so without this a rename would silently reset a confirmed contact to pending.
  const prior = await env.DB.prepare(
    `SELECT c.status AS status,
            (SELECT ep.channel FROM contact_endpoints ep WHERE ep.contactId = c.id ORDER BY ep.priority ASC LIMIT 1) AS chan,
            (SELECT ep.channelIdentifier FROM contact_endpoints ep WHERE ep.contactId = c.id ORDER BY ep.priority ASC LIMIT 1) AS dest
       FROM contacts c
      WHERE c.userId = ? AND c.role = ? AND ((? IS NULL AND c.priority IS NULL) OR c.priority = ?)`,
  )
    .bind(userId, addr.role, addr.priority, addr.priority)
    .first<{ status: string | null; chan: string | null; dest: string | null }>();

  // CONSENT BY CHANNEL:
  //  - SMS is the only channel with a live confirm flow. A brand-new number, or a
  //    changed number, is pending and gets the confirmation SMS. The SAME number on
  //    an already-confirmed contact keeps its consent (a rename is not a re-consent).
  //  - Anything else (email — retiring, no confirm flow) is grandfathered confirmed,
  //    matching the 0030 backfill. LINE never comes through here (it is confirmed at
  //    QR pairing), but if it did, treat it as already-consented.
  let status: 'pending' | 'confirmed' = 'confirmed';
  let confirmationNeeded = false;
  if (input.channel === 'sms') {
    const sameNumber = prior?.chan === 'sms' && prior?.dest === input.destination;
    if (sameNumber && prior?.status === 'confirmed') {
      status = 'confirmed';
    } else {
      status = 'pending';
      confirmationNeeded = true;
    }
  }
  const now = Date.now();

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
      'INSERT INTO contacts (id, userHash, userId, displayName, contactName, role, priority, createdAt, status, statusUpdatedAt) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(contactId, userId, input.userDisplayName, input.contactName, addr.role, addr.priority, now, status, now),
    env.DB.prepare(
      'INSERT INTO contact_endpoints (id, contactId, channel, channelIdentifier, priority, verifiedAt, createdAt) VALUES (?, ?, ?, ?, 1, ?, ?)',
    ).bind(crypto.randomUUID(), contactId, input.channel, input.destination, now, now),
  );
  // Priority 2 = the fallback. dispatch() tries priority 1 first and only reaches
  // this if that channel actually failed — so a contact with two channels is
  // reported "not reached" only after BOTH have failed. Ignored when it duplicates
  // the preferred channel: two endpoints on the same broken vendor is not a
  // fallback, it is the same failure twice.
  if (input.fallbackChannel && input.fallbackDestination && input.fallbackChannel !== input.channel) {
    statements.push(
      env.DB.prepare(
        'INSERT INTO contact_endpoints (id, contactId, channel, channelIdentifier, priority, verifiedAt, createdAt) VALUES (?, ?, ?, ?, 2, ?, ?)',
      ).bind(
        crypto.randomUUID(),
        contactId,
        input.fallbackChannel,
        input.fallbackDestination,
        Date.now(),
        Date.now(),
      ),
    );
  }
  await env.DB.batch(statements);
  return { status, confirmationNeeded };
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
  // ARMED requires a CONFIRMED recipient once the gate is armed (Contact Consent §3):
  // a contact who is deliverable but has not agreed to the role does NOT make an
  // account Armed — an alert that would fire at someone who never consented is the
  // exact gap this brief closes. Behind the flag so armable and dispatch always
  // agree: while the gate is off, this is unchanged reachability (no regression).
  const { results } = await env.DB.prepare(
    "SELECT c.role AS role, ep.channel AS channel, c.status AS status FROM contacts c JOIN contact_endpoints ep ON ep.contactId = c.id WHERE c.userId = ? AND c.role IN ('contact','guardian')",
  )
    .bind(userId)
    .all<{ role: string; channel: string; status: string | null }>();
  const gate = consentGateEnforced(env);
  const recipients = (results ?? [])
    .filter((r) => !gate || r.status === 'confirmed')
    .map((r) => ({
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
