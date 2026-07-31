/**
 * Org admin registration endpoints (Brief 24 §3) — the passive-GET-safe surface.
 *
 * THE HAZARD: automated email-link scanners hit the approval link before any human
 * does. A coordinator role was once claimed on such a passive GET in this codebase.
 * So here the GET is strictly READ-ONLY (renders org details for the page, consumes
 * nothing, mutates nothing), and the code is consumed ONLY on the explicit completion
 * POST — a deliberate action after the human has entered the code and enrolled a
 * passkey. A scanner hitting the GET changes no state.
 */
import { Hono } from 'hono';

import { requireSession } from '../auth';
import { completeAdminRegistration, getRegistrationOrgView } from '../lib/org-registration';
import type { Env, Vars } from '../types';

// Mounted at /v1/org-register — a DISTINCT base path from the session-gated /v1/org
// portal group, so the portal's `use('*', requireSession)` never touches this public
// registration surface.
export const orgRegisterRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// READ-ONLY org view for the registration page. PUBLIC (the page is reached before any
// account exists) and SIDE-EFFECT-FREE: it never consumes the code, never counts an
// attempt, never writes. Returns { valid:false } for an unusable code so the page shows
// an honest "invalid or expired" without a state change and without revealing which.
orgRegisterRoutes.get('/:code', async (c) => {
  const view = await getRegistrationOrgView(c.env, c.req.param('code'));
  if (!view) {
    // A consumed/revoked/expired/locked code reads as a dead route — no state changes.
    return c.json({ valid: false }, 200);
  }
  return c.json({
    valid: true,
    licenseAlreadyAccepted: view.licenseAlreadyAccepted,
    org: { orgId: view.orgId, name: view.name, lane: view.lane, seatsTotal: view.seatsTotal, termStart: view.termStart, termEnd: view.termEnd },
  }, 200);
});

// COMPLETE registration — the ONLY place a code is consumed, and only on this explicit
// POST. Session-authed: the registrant has just created + finalized their account (and,
// in the UI, enrolled a passkey) via the standard passwordless ceremony; this final
// action claims admin #1 on the pre-created org, records the license acceptance, and
// permanently burns the code. Org name/lane/seats/term are fixed on the server record —
// nothing here lets the registrant edit them.
orgRegisterRoutes.post('/complete', requireSession, async (c) => {
  const body = await c.req
    .json<{ code?: string; licenseVersion?: string; acceptancePath?: string }>()
    .catch(() => ({}) as { code?: string; licenseVersion?: string; acceptancePath?: string });
  const code = (body.code ?? '').trim();
  if (!code) {
    return c.json({ error: 'code_required' }, 400);
  }
  const acceptancePath = body.acceptancePath === 'out_of_band' ? 'out_of_band' : 'click_through';
  const licenseVersion = (body.licenseVersion ?? 'v1').trim() || 'v1';
  const res = await completeAdminRegistration(c.env, {
    userId: c.get('userId'),
    code,
    licenseVersion,
    acceptancePath,
  });
  if (!res.ok) {
    // Honest, specific refusal — a dead/consumed/expired code says so plainly.
    return c.json({ error: res.reason }, res.reason === 'bind_failed' ? 409 : 400);
  }
  return c.json({ ok: true, orgId: res.orgId }, 201);
});
