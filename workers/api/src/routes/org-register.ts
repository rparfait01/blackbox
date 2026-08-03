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
import { boundedJson, check, LIMITS, validate } from '../lib/request-bounds';
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
  // ═══ Brief 43 §A/§B, applied late — this route was MISSED by that brief's sweep ═════════════
  //
  // Brief 43 converted every Hono body read to the bounded reader and this one was left on the
  // raw `c.req.json().catch()`. The miss matters more here than on most routes: this surface is
  // PUBLIC up to the session check and it is the front door an organization walks through, so an
  // unbounded body on it is reachable by anyone holding a registration link.
  //
  // Bounds are only half of it. The old code took `licenseVersion` and `acceptancePath` as
  // whatever arrived and coerced them — `(body.licenseVersion ?? 'v1').trim()` throws on a number
  // and silently accepts a 4 KB string as a licence version, which is then RECORDED AS THE
  // LICENCE THE ORG ACCEPTED. That record is the artifact a contract dispute turns on, so it gets
  // a closed vocabulary and a length, not a coercion.
  const read = await boundedJson<Record<string, unknown>>(c.req, LIMITS.jsonBodyBytes);
  if (read.value === null) {
    return c.json({ error: read.refusal ?? 'invalid_json' }, read.refusal === 'too_large' ? 413 : 400);
  }
  const fields = validate<{ code: string; licenseVersion?: string; acceptancePath?: 'out_of_band' | 'click_through' }>(
    read.value,
    {
      code: { check: check.requiredString(200), required: true },
      licenseVersion: { check: check.string(40) },
      // An allow-list, never a deny-list: an unrecognised acceptance path is refused rather than
      // quietly folded into 'click_through', because those two are a signed contract and a
      // checkbox and the record must not blur them.
      acceptancePath: { check: check.oneOf(['out_of_band', 'click_through'] as const) },
    },
  );
  if (fields.value === null) {
    return c.json({ error: 'invalid_request', issues: fields.issues }, 400);
  }
  const code = fields.value.code.trim();
  if (!code) {
    return c.json({ error: 'code_required' }, 400);
  }
  const acceptancePath = fields.value.acceptancePath ?? 'click_through';
  const licenseVersion = (fields.value.licenseVersion ?? 'v1').trim() || 'v1';
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
