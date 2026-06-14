/**
 * LINE webhook (W6). Receives follow + postback events from LINE. Two hard
 * rules: (1) verify the HMAC-SHA256 signature against the Channel Secret before
 * trusting anything, and (2) return 200 fast — LINE times out webhook acks after
 * ~1 second, so all outbound work (closure confirmation push) is deferred to
 * `ctx.waitUntil()`.
 */

import type { Context } from 'hono';
import { audit } from '../lib/audit';
import { recordFollow } from '../lib/contacts';
import type { Env, Vars } from '../types';

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

interface LineEvent {
  type: string;
  source?: { userId?: string };
  postback?: { data?: string };
}

/** base64(HMAC-SHA256(secret, body)) — LINE's x-line-signature scheme. */
async function lineSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  let binary = '';
  for (const byte of new Uint8Array(sig)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function parsePostback(data: string): { action: string; eventId: string } {
  const params = new URLSearchParams(data);
  return { action: params.get('action') ?? '', eventId: params.get('eventId') ?? '' };
}

async function handlePostback(c: Ctx, action: string, eventId: string): Promise<void> {
  const env = c.env;
  switch (action) {
    case 'approve_closure': {
      // Fix Brief 4 S2: a contact / responder can NEVER stand the alert down.
      // Only the user's verified lock code closes an event. We record the
      // contact's intent for the trail, but the event stays active.
      await audit(env, eventId, 'closure.contact_approve_noop', null, null);
      return;
    }
    case 'hold_closure':
      await audit(env, eventId, 'closure.hold', null, null);
      return;
    case 'duress_ack':
      await audit(env, eventId, 'closure.duress_ack', null, null);
      return;
    case 'responding':
      await audit(env, eventId, 'contact.responding', null, null);
      return;
    default:
      return;
  }
}

export async function handleLineWebhook(c: Ctx): Promise<Response> {
  const secret = c.env.LINE_CHANNEL_SECRET;
  const rawBody = await c.req.text();
  const signature = c.req.header('x-line-signature') ?? '';

  if (!secret) {
    // Not configured — acknowledge so LINE does not retry, but do nothing.
    return c.json({ ok: true }, 200);
  }
  const expected = await lineSignature(secret, rawBody);
  if (!constantTimeEqual(expected, signature)) {
    return c.json({ error: 'bad signature' }, 401);
  }

  let events: LineEvent[] = [];
  try {
    events = (JSON.parse(rawBody) as { events?: LineEvent[] }).events ?? [];
  } catch {
    return c.json({ ok: true }, 200);
  }

  for (const event of events) {
    if ((event.type === 'follow' || event.type === 'message') && event.source?.userId) {
      // Record the sender's userId so it can be paired to a contact slot. Follow
      // fires once (and not again for an existing follower), so ANY message also
      // captures it — that is how an already-following user surfaces their real
      // userId on demand. Stored in D1 only — never written to console logs.
      await recordFollow(c.env, event.source.userId);
      await audit(c.env, null, event.type === 'follow' ? 'line.follow' : 'line.message', null, null);
    } else if (event.type === 'postback' && event.postback?.data) {
      const { action, eventId } = parsePostback(event.postback.data);
      if (action && eventId) {
        await handlePostback(c, action, eventId);
      }
    }
  }

  return c.json({ ok: true }, 200);
}
