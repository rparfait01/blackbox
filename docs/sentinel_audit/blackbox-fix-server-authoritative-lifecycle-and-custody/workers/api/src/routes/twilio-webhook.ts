/**
 * Twilio inbound SMS webhook (Contact Consent §2). Receives a pending contact's
 * YES / NO / STOP / HELP reply and updates their consent status.
 *
 * Mirrors the LINE webhook's discipline (routes/line-webhook.ts): verify the
 * provider signature before trusting anything, do the work, ack fast. Twilio's
 * scheme differs from LINE's, so the specifics are Twilio's:
 *   - signature: base64(HMAC-SHA1(authToken, fullURL + sorted POST params))
 *   - body: application/x-www-form-urlencoded (From, Body, MessageSid, …)
 *   - reply: TwiML <Response> (a <Message> to answer, empty to stay silent)
 *
 * Silence is never consent: a no-reply contact is never touched here — this only
 * ever runs in response to an actual inbound message.
 */

import type { Context } from 'hono';
import { audit } from '../lib/audit';
import { normalizePhone } from '../lib/users';
import { confirmedReply, declinedReply, helpReply } from '../lib/consent';
import type { Env, Vars } from '../types';

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

/** base64(HMAC-SHA1(secret, message)) — Twilio's X-Twilio-Signature scheme. */
async function twilioSignature(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
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

/**
 * Twilio signs `url + <params sorted by key, concatenated as key immediately
 * followed by value, no separators>`. The url is the exact endpoint Twilio was
 * configured to POST to.
 */
function signatureBase(url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  let base = url;
  for (const k of sortedKeys) {
    base += k + params[k];
  }
  return base;
}

export type Intent = 'confirm' | 'decline' | 'stop' | 'help' | 'unknown';

/**
 * Read intent from the FIRST word only. The brief's contract is YES/Y and NO/N
 * (case-insensitive); reading just the first token lets "yes please" / "no thanks"
 * work without inferring consent from a casual "ok" or "sure" — consent has to be
 * unambiguous. STOP and its carrier synonyms are opt-out; HELP asks for info.
 */
export function parseIntent(body: string): Intent {
  const first = (body.trim().toUpperCase().split(/[\s,.!]+/)[0] ?? '').replace(/[^A-Z]/g, '');
  if (first === 'YES' || first === 'Y' || first === 'YEAH' || first === 'YEP' || first === 'CONFIRM') {
    return 'confirm';
  }
  if (first === 'NO' || first === 'N' || first === 'NOPE' || first === 'DECLINE') {
    return 'decline';
  }
  // Carrier opt-out keywords — Twilio also handles these at the compliance layer.
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT'].includes(first)) {
    return 'stop';
  }
  if (first === 'HELP' || first === 'INFO') {
    return 'help';
  }
  return 'unknown';
}

/** Empty TwiML — acknowledge, say nothing back. */
function twimlEmpty(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    headers: { 'Content-Type': 'text/xml' },
  });
}

/** TwiML that replies with a single message from the same number. */
function twimlMessage(text: string): Response {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`,
    { headers: { 'Content-Type': 'text/xml' } },
  );
}

interface MatchedContact {
  id: string;
  displayName: string;
  userId: string | null;
  status: string;
}

/** Every SMS contact reachable at this number (a number may be a contact for more than one survivor). */
async function contactsForNumber(env: Env, phone: string): Promise<MatchedContact[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.id AS id, c.displayName AS displayName, c.userId AS userId, c.status AS status
       FROM contacts c
       JOIN contact_endpoints ep ON ep.contactId = c.id
      WHERE ep.channel = 'sms' AND ep.channelIdentifier = ?`,
  )
    .bind(phone)
    .all<MatchedContact>();
  return results ?? [];
}

async function setStatus(env: Env, contactId: string, status: 'confirmed' | 'declined'): Promise<void> {
  await env.DB.prepare('UPDATE contacts SET status = ?, statusUpdatedAt = ? WHERE id = ?')
    .bind(status, Date.now(), contactId)
    .run();
}

export async function handleTwilioWebhook(c: Ctx): Promise<Response> {
  const authToken = c.env.TWILIO_AUTH_TOKEN;
  const rawBody = await c.req.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(rawBody)) {
    params[k] = v;
  }

  if (!authToken) {
    // Not configured — ack so Twilio does not retry, do nothing.
    return twimlEmpty();
  }
  const expected = await twilioSignature(authToken, signatureBase(c.req.url, params));
  const provided = c.req.header('x-twilio-signature') ?? '';
  if (!constantTimeEqual(expected, provided)) {
    return c.json({ error: 'bad signature' }, 403);
  }

  const from = normalizePhone(params.From ?? '');
  const intent = parseIntent(params.Body ?? '');
  if (!from) {
    return twimlEmpty();
  }

  const matches = await contactsForNumber(c.env, from);
  // A number with no contact on file (or one that isn't ours) gets no reply — we do
  // not confirm to a stranger that this system knows their number.
  if (matches.length === 0) {
    return twimlEmpty();
  }
  const survivorName = matches[0]!.displayName || 'the person who added you';

  if (intent === 'confirm') {
    for (const m of matches) {
      if (m.status !== 'declined') await setStatus(c.env, m.id, 'confirmed');
    }
    await audit(c.env, null, 'consent.confirmed', null, { n: matches.length });
    return twimlMessage(confirmedReply(survivorName));
  }
  if (intent === 'decline') {
    for (const m of matches) await setStatus(c.env, m.id, 'declined');
    await audit(c.env, null, 'consent.declined', null, { n: matches.length });
    return twimlMessage(declinedReply(survivorName));
  }
  if (intent === 'stop') {
    // Opt-out. Set declined for the record, but send NOTHING back: Twilio's
    // compliance layer owns the carrier opt-out confirmation, and double-texting an
    // opt-out is itself a violation.
    for (const m of matches) await setStatus(c.env, m.id, 'declined');
    await audit(c.env, null, 'consent.opted_out', null, { n: matches.length });
    return twimlEmpty();
  }
  if (intent === 'help') {
    // Info only — never changes consent state.
    return twimlMessage(helpReply());
  }

  // Unrecognized. Do NOT change status, and do NOT loop a confused recipient with
  // repeated asks — one silent ack. They still hold YES / NO / STOP.
  await audit(c.env, null, 'consent.reply_unrecognized', null, null);
  return twimlEmpty();
}
