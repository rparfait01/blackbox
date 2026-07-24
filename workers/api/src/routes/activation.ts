/**
 * Web-purchase activation (Brief 28 §3) — SERVER-VERIFIED, provider-agnostic.
 *
 * The one and only way a web purchase activates an account is a signature-verified
 * webhook from the payment provider. Two hard rules (§0):
 *   1. NO client-granted entitlement, ever. A client redirect / success page is never
 *      trusted — only this HMAC-verified server-to-server callback grants.
 *   2. Fail-CLOSED at the auth boundary: if the webhook secret is unset, or the
 *      signature is missing/wrong, the request 401s. An unverified payment callback
 *      never activates anyone. (This is the OPPOSITE of the trigger path, which is
 *      fail-open — because here the risk is a forged grant, not a blocked alarm.)
 *
 * Provider-agnostic seam: the payload is our own envelope, HMAC-SHA256(secret, rawBody)
 * carried hex-encoded in x-activation-signature. When a real provider (Stripe, etc.) is
 * wired, add its native verifier alongside this one; the grant + idempotency logic below
 * is unchanged. Nothing here is provider-specific.
 *
 * Idempotency: each provider event carries a unique id; the receipt row is keyed on it,
 * so a re-delivered webhook is a no-op re-grant (grantEntitlement is itself idempotent).
 * A paid purchase whose email has no account yet is stored as an ORPHAN and surfaced
 * loudly (audit 'activation_orphan') for operator recovery — never silently dropped.
 */
import type { Context } from 'hono';
import { audit } from '../lib/audit';
import { grantEntitlement } from '../lib/entitlement';
import { getUserByEmail, normalizeEmail } from '../lib/users';
import type { Env, Vars } from '../types';

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

interface ActivationWebhookBody {
  /** The provider's unique event id — the idempotency key. */
  providerEventId?: string;
  /** Provider label ('stripe' | 'manual' | ...). Recorded, not trusted for auth. */
  provider?: string;
  /** Purchaser email — how the payment maps to an account. */
  email?: string;
  /** Amount in cents — recorded only. */
  amountCents?: number;
}

/** hex(HMAC-SHA256(secret, body)). */
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

/**
 * Grant entitlement for a verified purchase and record the receipt. Idempotent on
 * providerEventId. Returns the resolved account (or null when the email is unmatched —
 * an orphan). Shared by the webhook and the signed-in confirm path.
 */
async function recordAndGrant(
  env: Env,
  input: { providerEventId: string; provider: string; email: string | null; amountCents: number | null },
): Promise<{ granted: boolean; accountUserId: string | null }> {
  const email = input.email ? normalizeEmail(input.email) : null;
  const account = email ? await getUserByEmail(env, email) : null;
  const accountUserId = account?.id ?? null;
  const status = accountUserId ? 'granted' : 'orphan';

  // Upsert the receipt keyed on the provider event id (idempotent re-delivery).
  await env.DB.prepare(
    `INSERT INTO activation_receipts (providerEventId, provider, email, accountUserId, status, amountCents, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(providerEventId) DO UPDATE SET
       accountUserId = COALESCE(excluded.accountUserId, activation_receipts.accountUserId),
       status = excluded.status`,
  )
    .bind(input.providerEventId, input.provider, email, accountUserId, status, input.amountCents, Date.now())
    .run();

  if (accountUserId) {
    await grantEntitlement(env, accountUserId, 'purchase_web');
    return { granted: true, accountUserId };
  }
  // Paid but unmatched — surface loudly so an operator can reconcile. NEVER dropped.
  await audit(env, null, 'activation_orphan', null, {
    providerEventId: input.providerEventId,
    provider: input.provider,
    email,
  });
  return { granted: false, accountUserId: null };
}

/**
 * POST /v1/activation/webhook — the provider's server-to-server purchase callback.
 * Public (no session), authenticated ENTIRELY by the HMAC signature. Fail-closed.
 */
export async function handleActivationWebhook(c: Ctx): Promise<Response> {
  const secret = c.env.ACTIVATION_WEBHOOK_SECRET;
  const rawBody = await c.req.text();
  const signature = c.req.header('x-activation-signature') ?? '';

  // Secret-gated + fail-closed: no secret, or a missing/wrong signature → 401. An
  // unverified payment callback can never activate an account.
  if (!secret) {
    return c.json({ error: 'not_configured' }, 401);
  }
  const expected = await hmacHex(secret, rawBody);
  if (!signature || !constantTimeEqual(expected, signature)) {
    return c.json({ error: 'bad_signature' }, 401);
  }

  let body: ActivationWebhookBody;
  try {
    body = JSON.parse(rawBody) as ActivationWebhookBody;
  } catch {
    return c.json({ error: 'bad_body' }, 400);
  }
  const providerEventId = (body.providerEventId ?? '').trim();
  if (!providerEventId) {
    return c.json({ error: 'providerEventId_required' }, 400);
  }

  const result = await recordAndGrant(c.env, {
    providerEventId,
    provider: (body.provider ?? 'unknown').trim() || 'unknown',
    email: body.email ?? null,
    amountCents: typeof body.amountCents === 'number' ? body.amountCents : null,
  });
  // Always 200 on a verified call so the provider does not retry — an orphan is
  // recorded, not an error to the provider.
  return c.json({ ok: true, granted: result.granted }, 200);
}

/**
 * POST /v1/me/activation/confirm — a signed-in buyer confirms after checkout. Does NOT
 * trust the client: it re-checks the SERVER's activation_receipts for a paid receipt
 * matching this account's email and grants only then (the webhook usually already has).
 * Never a client claim — the receipt had to have been written by the verified webhook.
 */
export async function confirmActivation(c: Ctx): Promise<Response> {
  const userId = c.get('userId');
  const user = await c.env.DB.prepare('SELECT email, entitlement FROM users WHERE id = ?')
    .bind(userId)
    .first<{ email: string | null; entitlement: string }>();
  if (!user) return c.json({ error: 'not_found' }, 404);
  if (user.entitlement === 'activated') {
    return c.json({ ok: true, entitlement: 'activated' }, 200);
  }
  const email = user.email ? normalizeEmail(user.email) : null;
  if (!email) return c.json({ ok: false, entitlement: 'unactivated' }, 200);

  // A verified receipt for this email is server-written proof of payment. Attach the
  // account to any orphaned receipt for it, then grant.
  const receipt = await c.env.DB.prepare(
    'SELECT providerEventId FROM activation_receipts WHERE email = ? LIMIT 1',
  )
    .bind(email)
    .first<{ providerEventId: string }>();
  if (!receipt) {
    return c.json({ ok: false, entitlement: 'unactivated' }, 200);
  }
  await c.env.DB.prepare(
    "UPDATE activation_receipts SET accountUserId = ?, status = 'granted' WHERE email = ? AND accountUserId IS NULL",
  )
    .bind(userId, email)
    .run();
  await grantEntitlement(c.env, userId, 'purchase_web');
  return c.json({ ok: true, entitlement: 'activated' }, 200);
}
