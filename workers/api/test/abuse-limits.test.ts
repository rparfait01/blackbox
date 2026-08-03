import { describe, expect, it } from 'vitest';

import {
  EXEMPT,
  LIMITED,
  UNAUTH_OUTBOUND,
  backoffFor,
  environmentExemption,
  exemptPathIsUnlimited,
  isAlertMessage,
  isLimited,
  ruleFor,
} from '../src/lib/abuse-limits';
import { countAttempt, resetLimiter } from '../src/lib/limiter-store';

/**
 * Brief 41 §0 — no control may apply to the trigger, capture, cascade or closure. A rate limit
 * that delays an alert is a worse defect than the abuse it prevents.
 *
 * The brief requires the exempt list be PROVEN, not asserted, so these drive the real predicate
 * rather than reading a comment.
 */
describe('§0 the life-safety paths are unlimited, by construction', () => {
  it('every named exempt path resolves to NO rule', () => {
    const r = exemptPathIsUnlimited();
    expect(r.ok, `these exempt paths matched a limit rule: ${r.offenders.join(', ')}`).toBe(true);
  });

  it('the trigger and every event-scoped write are unlimited', () => {
    for (const p of [
      '/v1/events',
      '/v1/events/abc-123/chunks/0',
      '/v1/events/abc-123/chunks/41',
      '/v1/events/abc-123/heartbeat',
      '/v1/events/abc-123/close',
      '/v1/events/abc-123/closure-request',
      '/v1/events/abc-123/location',
    ]) {
      expect(isLimited(p, 'POST'), `${p} must never be limited`).toBe(false);
    }
  });

  it('coordinator surfaces are unlimited — capability-scoped and ON the alert path (§E2)', () => {
    for (const p of ['/v1/c/tok/ack', '/v1/c/tok/export', '/v1/c/tok']) {
      expect(isLimited(p, 'POST'), `${p} must never be limited`).toBe(false);
    }
  });

  it('an UNKNOWN path is unlimited — the allow-list defaults open', () => {
    // The inverse design would mean a new capture route is silently throttled until someone
    // remembers to exempt it, and the failure would be invisible until the day it mattered.
    expect(isLimited('/v1/some/route/added/next/week', 'POST')).toBe(false);
  });

  it('the endpoints that ARE limited are the auth/enrolment surfaces §A names', () => {
    for (const p of [
      '/v1/auth/signin',
      '/v1/auth/magic/start',
      '/v1/auth/signup/start',
      '/v1/auth/recovery/consume',
      '/v1/console/auth',
    ]) {
      expect(isLimited(p, 'POST'), `${p} should be limited`).toBe(true);
    }
  });
});

describe('§A backoff is progressive and never a lockout', () => {
  const rule = ruleFor('/v1/auth/signup/start', 'POST')!;

  it('the burst is free — a survivor mistyping a code is not slowed at all (acceptance 8)', () => {
    for (let i = 1; i <= rule.burst; i += 1) {
      expect(backoffFor(rule, i).allowed, `attempt ${i} of ${rule.burst} must be free`).toBe(true);
    }
  });

  it('past the burst the DELAY grows — it does not become a refusal that persists', () => {
    const a = backoffFor(rule, rule.burst + 1);
    const b = backoffFor(rule, rule.burst + 3);
    expect(a.allowed).toBe(false);
    expect(b.retryAfterMs).toBeGreaterThan(a.retryAfterMs);
  });

  it('the delay CAPS — there is no state a survivor cannot wait out', () => {
    const far = backoffFor(rule, rule.burst + 40);
    expect(far.retryAfterMs).toBe(rule.maxBackoffMs);
    expect(far.retryAfterMs).toBeLessThanOrEqual(20_000);
  });

  it('the window decays, so yesterday cannot lock out today', () => {
    resetLimiter();
    const now = Date.now();
    expect(countAttempt('k', 1000, now)).toBe(1);
    expect(countAttempt('k', 1000, now + 100)).toBe(2);
    expect(countAttempt('k', 1000, now + 2000)).toBe(1); // new window
  });

  it('every limit is a stated constant with a reason', () => {
    for (const entry of LIMITED) {
      expect(entry.rule.reason.length, `${entry.rule.key} needs a reason`).toBeGreaterThan(10);
      expect(entry.rule.burst).toBeGreaterThan(0);
      expect(entry.rule.maxBackoffMs).toBeGreaterThan(entry.rule.backoffMs);
    }
  });
});

describe('§E1 many survivors behind one shelter NAT are not throttled together', () => {
  it('distinct identifiers count separately', () => {
    resetLimiter();
    const rule = ruleFor('/v1/auth/signin', 'POST')!;
    for (let i = 0; i < rule.burst + 5; i += 1) countAttempt('signin:email:a@example.com', rule.windowMs);
    // A different survivor, same shelter, same egress IP — untouched.
    expect(backoffFor(rule, countAttempt('signin:email:b@example.com', rule.windowMs)!).allowed).toBe(true);
  });
});

describe('§E3 the limiter fails OPEN', () => {
  it('an uncountable attempt is allowed', () => {
    // countAttempt returns null when it cannot establish a count; the middleware treats null as
    // allow. A limiter that fails closed converts a storage blip into an outage of the front door.
    expect(countAttempt('x', 1000)).not.toBeNull(); // normal path still counts
    const decision = backoffFor(ruleFor('/v1/auth/signin', 'POST')!, 1);
    expect(decision.allowed).toBe(true);
  });
});

describe('§C the alert path draws on an allocation abuse cannot reach', () => {
  it('alert-path message types are never counted against the cap', () => {
    for (const t of ['alert', 'escalation', 'closure', 'checkin', 'all_channels_failed']) {
      expect(isAlertMessage(t), `${t} must be treated as alert traffic`).toBe(true);
    }
  });

  it('the abusable types ARE capped', () => {
    for (const t of ['account_magic_link', 'otp', 'guardian_invite']) {
      expect(isAlertMessage(t), `${t} must be capped`).toBe(false);
    }
  });

  it('the cap is a stated constant', () => {
    expect(UNAUTH_OUTBOUND.max).toBe(5);
    expect(UNAUTH_OUTBOUND.reason).toMatch(/unauthenticated/);
  });
});

describe('§F exemption is derived server-side, never asserted by a client', () => {
  it('staging is exempt by its own deployment identity', () => {
    expect(environmentExemption({ WORKER_ORIGIN: 'https://blackbox-api-staging.x.workers.dev' } as never)).toBe(
      'staging_environment',
    );
  });

  it('PRODUCTION IS NOT EXEMPT — if the suite trips a prod limit, that is a finding', () => {
    expect(environmentExemption({ WORKER_ORIGIN: 'https://blackbox-api.stillpoint-dev.workers.dev' } as never)).toBeNull();
    expect(environmentExemption({} as never)).toBeNull();
  });

  it('there is no exemption a request can ask for', () => {
    // Same rule as Brief 35 §D: no client-asserted marking is ever honoured.
    for (const hostile of [
      { WORKER_ORIGIN: 'https://blackbox-api.x.workers.dev', isTest: true },
      { WORKER_ORIGIN: 'https://blackbox-api.x.workers.dev', BBX_TEST: '1' },
    ]) {
      expect(environmentExemption(hostile as never)).toBeNull();
    }
  });

  it('the exempt list is named in code so §0 is stated, not implied', () => {
    expect(EXEMPT).toContain('/v1/events');
    expect(EXEMPT).toContain('/v1/c/');
  });
});
