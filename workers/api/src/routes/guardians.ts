/**
 * Guardian invite + accept (W8A). The user invites one support contact by email;
 * the guardian opens a 7-day magic link, consents, verifies a reach channel by
 * OTP, and that channel becomes a priority-1 endpoint. The user can use the app
 * before the guardian accepts (activation works; alerts just won't deliver yet).
 */

import { Hono } from 'hono';
import { requireSession, sessionSecret } from '../auth';
import { sendEmail } from '../channels/sendgrid-email';
import {
  acceptInvite,
  createInvite,
  getInvite,
  getInviteForUser,
  removeInvite,
  saveContact,
  type PreferredChannel,
} from '../lib/guardians';
import { mintMagicToken, verifyMagicTokenDetailed } from '../lib/magic-link';
import { generateOtp, sendOtpViaEmail, sendOtpViaSms, storeOtp, verifyOtp } from '../lib/otp';
import { getUserById, normalizeEmail } from '../lib/users';
import type { Env, Vars } from '../types';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const guardianRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

function inviteUrl(env: Env, workerOrigin: string, inviteId: string, token: string): string {
  const origin = env.PWA_ORIGIN || workerOrigin;
  return `${origin}/guardian-accept/${inviteId}?t=${token}`;
}

async function sendInviteEmail(
  env: Env,
  workerOrigin: string,
  invite: { id: string; guardianEmail: string | null; guardianName: string | null },
  userName: string,
): Promise<void> {
  const secret = sessionSecret(env);
  if (!secret || !invite.guardianEmail) {
    return;
  }
  const token = await mintMagicToken(secret, invite.id, Date.now(), INVITE_TTL_MS);
  const url = inviteUrl(env, workerOrigin, invite.id, token);
  const subject = `${userName} added you as their BLACK BOX support contact`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:24px">
<table role="presentation" align="center" style="max-width:460px;background:#fff;border-radius:12px;padding:24px">
<tr><td style="font-size:11px;color:#888;letter-spacing:.1em;text-transform:uppercase;font-family:monospace">BLACK BOX</td></tr>
<tr><td style="padding-top:12px;font-size:15px;color:#111;line-height:1.5">${userName} added you as their support contact. If something happens, you'll be the one we reach.</td></tr>
<tr><td style="padding-top:18px"><a href="${url}" style="display:block;background:#111;color:#fff;text-align:center;padding:16px;border-radius:8px;font-weight:700;text-decoration:none">Confirm you're their contact</a></td></tr>
<tr><td style="padding-top:14px;font-size:12px;color:#888">This link expires in 7 days.</td></tr>
</table></body></html>`;
  const text = `${userName} added you as their BLACK BOX support contact. Confirm: ${url} (link expires in 7 days)`;
  await sendEmail(env, { to: invite.guardianEmail, subject, html, text }, 'guardian_invite');
}

// --- User side (session-protected) ---

guardianRoutes.post('/invite', requireSession, async (c) => {
  const userId = c.get('userId');
  const body = await c.req
    .json<{ name?: string; phone?: string; email?: string; relationship?: string }>()
    .catch(() => ({}) as Record<string, string>);
  if (!body.name || !body.email) {
    return c.json({ error: 'guardian name and email are required' }, 400);
  }
  const user = await getUserById(c.env, userId);
  const inviteId = await createInvite(c.env, userId, {
    name: body.name,
    phone: body.phone,
    email: body.email,
    relationship: body.relationship,
  });
  const invite = await getInvite(c.env, inviteId);
  if (invite) {
    const workerOrigin = new URL(c.req.url).origin;
    c.executionCtx.waitUntil(
      sendInviteEmail(c.env, workerOrigin, invite, user?.name ?? 'A BLACK BOX user'),
    );
  }
  return c.json({ inviteId, status: 'pending' }, 201);
});

guardianRoutes.get('/', requireSession, async (c) => {
  const invite = await getInviteForUser(c.env, c.get('userId'));
  if (!invite) {
    return c.json({ guardian: null }, 200);
  }
  return c.json(
    {
      guardian: {
        name: invite.guardianName,
        relationship: invite.relationship,
        status: invite.status,
        channel: invite.preferredChannel,
        destination: invite.channelDestination,
      },
    },
    200,
  );
});

// Contact setup (Fix Brief 3): the user picks a preferred channel (sms/line/
// email) + destination; we store it as the priority-1 endpoint immediately.
guardianRoutes.post('/contact', requireSession, async (c) => {
  const body = await c.req
    .json<{ name?: string; relationship?: string; channel?: string; destination?: string }>()
    .catch(() => ({}) as Record<string, string>);
  const channel = body.channel as PreferredChannel | undefined;
  if (!body.name?.trim() || !body.destination?.trim()) {
    return c.json({ error: 'name and destination are required' }, 400);
  }
  if (channel !== 'sms' && channel !== 'line' && channel !== 'email') {
    return c.json({ error: 'channel must be sms, line or email' }, 400);
  }
  await saveContact(c.env, c.get('userId'), {
    name: body.name.trim(),
    relationship: body.relationship?.trim(),
    channel,
    destination: body.destination.trim(),
  });
  return c.json({ ok: true }, 200);
});

guardianRoutes.post('/resend', requireSession, async (c) => {
  const userId = c.get('userId');
  const invite = await getInviteForUser(c.env, userId);
  if (!invite || invite.status !== 'pending') {
    return c.json({ error: 'no pending invite' }, 404);
  }
  const user = await getUserById(c.env, userId);
  const workerOrigin = new URL(c.req.url).origin;
  c.executionCtx.waitUntil(
    sendInviteEmail(c.env, workerOrigin, invite, user?.name ?? 'A BLACK BOX user'),
  );
  return c.json({ ok: true }, 200);
});

guardianRoutes.delete('/', requireSession, async (c) => {
  await removeInvite(c.env, c.get('userId'));
  return c.json({ ok: true }, 200);
});

// --- Guardian side (public; the invite token is the auth) ---

async function loadInviteByToken(c: {
  env: Env;
  req: { param: (k: string) => string; query: (k: string) => string | undefined };
}) {
  const secret = sessionSecret(c.env);
  const inviteId = c.req.param('id');
  const token = c.req.query('t') ?? '';
  if (!secret) {
    return { verdict: 'invalid' as const, invite: null };
  }
  const verdict = await verifyMagicTokenDetailed(secret, inviteId, token);
  if (verdict !== 'ok') {
    return { verdict, invite: null };
  }
  return { verdict, invite: await getInvite(c.env, inviteId) };
}

guardianRoutes.get('/accept/:id', async (c) => {
  const { verdict, invite } = await loadInviteByToken(c);
  if (verdict !== 'ok' || !invite) {
    return c.json({ error: verdict === 'expired' ? 'expired' : 'invalid' }, 401);
  }
  const user = await getUserById(c.env, invite.userId);
  return c.json(
    {
      userName: user?.name ?? 'A BLACK BOX user',
      relationship: invite.relationship,
      status: invite.status,
    },
    200,
  );
});

guardianRoutes.post('/accept/:id/otp', async (c) => {
  const { verdict, invite } = await loadInviteByToken(c);
  if (verdict !== 'ok' || !invite) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const body = await c.req
    .json<{ channel?: string; identifier?: string }>()
    .catch(() => ({}) as Record<string, string>);
  if (body.channel === 'sms') {
    return c.json(sendOtpViaSms(), 400);
  }
  if (body.channel !== 'email' || !body.identifier) {
    return c.json({ error: 'email identifier required in v0' }, 400);
  }
  const email = normalizeEmail(body.identifier);
  const code = generateOtp();
  const stored = await storeOtp(c.env, `guardian:${invite.id}:${email}`, code, 'email');
  if (!stored.ok) {
    return c.json({ error: stored.reason ?? 'otp_failed' }, 429);
  }
  const sent = await sendOtpViaEmail(c.env, email, code);
  if (!sent.ok) {
    return c.json(
      { error: 'email_send_failed', sendgridStatus: sent.status, sendgridBody: sent.body },
      502,
    );
  }
  return c.json({ ok: true, expiresAt: stored.expiresAt }, 200);
});

guardianRoutes.post('/accept/:id/verify', async (c) => {
  const { verdict, invite } = await loadInviteByToken(c);
  if (verdict !== 'ok' || !invite) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const body = await c.req
    .json<{ channel?: string; identifier?: string; code?: string }>()
    .catch(() => ({}) as Record<string, string>);
  if (body.channel !== 'email' || !body.identifier || !body.code) {
    return c.json({ error: 'email identifier and code required' }, 400);
  }
  const email = normalizeEmail(body.identifier);
  const result = await verifyOtp(c.env, `guardian:${invite.id}:${email}`, body.code);
  if (!result.ok) {
    return c.json({ error: result.reason ?? 'invalid' }, 400);
  }
  // acceptInvite registers the verified email endpoint AND (if present) the
  // guardian's phone as an SMS endpoint — SMS is the default primary channel.
  const ok = await acceptInvite(c.env, invite, 'email', email);
  return c.json({ ok }, ok ? 200 : 404);
});
