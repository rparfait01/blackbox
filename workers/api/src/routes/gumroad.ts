/**
 * Consumer purchase → access code (Brief 30 §C).
 *
 * A verified sale mints ONE consumer enrollment code and delivers it to the buyer. That
 * code is what gets them through the signup gate — so this endpoint is the only thing
 * standing between "anyone can create an account" and "only people who bought or were
 * issued a code can".
 *
 * FAIL-CLOSED, ABSOLUTELY. No secret configured, missing signature, or wrong signature →
 * 401 and NO code is issued. An unverified callback must never mint an access code: that
 * would hand the product away to anyone who can find the URL. Same HMAC discipline as the
 * Brief 28 activation webhook, deliberately — one pattern, not two.
 *
 * DELIBERATELY SEPARATE from the institutional path. A DV shelter's codes come from the
 * operator's admin endpoints and never touch payment, Gumroad, or this file.
 */
import { Hono } from 'hono';

import { audit } from '../lib/audit';
import { createEnrollmentCode } from '../lib/org';
import { groupCode } from '../lib/readable-code';
import { sendEmail } from '../channels/sendgrid-email';
import type { Env, Vars } from '../types';

export const gumroadRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

/** hex(HMAC-SHA256(secret, body)) — identical to the activation webhook's. */
async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Gumroad Ping posts form-encoded; a JSON relay is also accepted. Both land as a flat map. */
function parseBody(raw: string, contentType: string): Record<string, string> {
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v ?? '')]));
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

function codeEmail(code: string): { subject: string; text: string; html: string } {
  const grouped = groupCode(code);
  const subject = 'Your BLACK BOX access code';
  const text = [
    'Thank you for your purchase.',
    '',
    `Your access code is: ${grouped}`,
    '',
    'Enter it when you create your account. It can be used once.',
    'Upper/lower case and the dashes do not matter.',
  ].join('\n');
  const html =
    `<p>Thank you for your purchase.</p>` +
    `<p>Your access code is:</p>` +
    `<p style="font:600 22px ui-monospace,monospace;letter-spacing:.06em">${grouped}</p>` +
    `<p>Enter it when you create your account. It can be used once. ` +
    `Upper/lower case and the dashes do not matter.</p>`;
  return { subject, text, html };
}

/**
 * POST /webhooks/gumroad/sale — the seller's server-to-server sale callback.
 *
 * Public (no session), authenticated ENTIRELY by the HMAC signature over the raw body.
 */
gumroadRoutes.post('/sale', async (c) => {
  const secret = c.env.ACTIVATION_WEBHOOK_SECRET;
  const rawBody = await c.req.text();
  const signature = c.req.header('x-activation-signature') ?? '';

  // FAIL-CLOSED. Both branches issue nothing and touch no state.
  if (!secret) {
    return c.json({ error: 'not_configured' }, 401);
  }
  const expected = await hmacHex(secret, rawBody);
  if (!signature || !constantTimeEqual(expected, signature)) {
    await audit(c.env, null, 'gumroad.rejected', null, { reason: 'bad_signature' });
    return c.json({ error: 'bad_signature' }, 401);
  }

  const body = parseBody(rawBody, c.req.header('content-type') ?? '');
  const saleId = (body.sale_id ?? body.saleId ?? '').trim();
  const buyerEmail = (body.email ?? body.buyer_email ?? '').trim();
  if (!saleId) {
    return c.json({ error: 'sale_id_required' }, 400);
  }

  // If the product is pinned, a sale for anything else is not ours to fulfil.
  const productId = (body.product_id ?? body.productId ?? '').trim();
  if (c.env.GUMROAD_PRODUCT_ID && productId && productId !== c.env.GUMROAD_PRODUCT_ID) {
    await audit(c.env, null, 'gumroad.rejected', null, { reason: 'product_mismatch', saleId });
    return c.json({ error: 'product_mismatch' }, 400);
  }

  // IDEMPOTENT on sale_id: Gumroad retries, and a retry must not mint a second code the
  // buyer never asked for. createdBy carries the sale so the check needs no new column.
  const marker = `gumroad:${saleId}`;
  const existing = await c.env.DB.prepare(
    "SELECT code FROM enrollment_codes WHERE createdBy = ? AND source = 'consumer' LIMIT 1",
  )
    .bind(marker)
    .first<{ code: string }>();
  if (existing) {
    return c.json({ ok: true, code: existing.code, deduped: true }, 200);
  }

  // ONE generator, shared with the institutional path (Brief 30 §B). Consumer codes carry
  // NO orgId — enforced by a DB CHECK, not by convention.
  const row = await createEnrollmentCode(c.env, {
    orgId: null,
    source: 'consumer',
    role: 'survivor',
    maxUses: 1,
    createdBy: marker,
    buyerEmail: buyerEmail || null,
  });

  // Deliver it. Reserved-address suppression (Brief 31) still applies, so a TEST sale to
  // an @example.com buyer mints a real code but spends no production delivery quota.
  let delivered = false;
  if (buyerEmail) {
    const mail = codeEmail(row.code);
    const sent = await sendEmail(c.env, { to: buyerEmail, ...mail }, 'access_code');
    delivered = sent.ok;
  }

  await audit(c.env, null, 'gumroad.code_issued', null, { saleId, delivered });
  // The code is returned so a success page can pre-fill it into onboarding — the buyer is
  // never dependent on an email arriving to use what they paid for.
  return c.json({ ok: true, code: row.code, delivered }, 201);
});
