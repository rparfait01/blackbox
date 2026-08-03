import { describe, expect, it, beforeEach } from 'vitest';

import {
  clearEnvironmentCache,
  dispatchPosture,
  mayDispatchExternally,
  resolveEnvironment,
} from '../src/lib/environment';

/**
 * Brief 35 Fix B §A/§B.
 *
 * THE ASYMMETRY UNDER TEST: a leaked staging email is embarrassing; production deciding it is not
 * production and swallowing a real cascade is a survivor who called for help and was not heard.
 * So the interesting assertions here are the ones about what still DISPATCHES.
 *
 * Per the standing rule, this comparison sits on the alert path and is therefore proven both
 * ways — a case that dispatches and a case that suppresses.
 */
const envWith = (row: { name: string } | null, opts: { throws?: boolean; secrets?: Record<string, string> } = {}) =>
  ({
    ...opts.secrets,
    DB: {
      prepare() {
        if (opts.throws) throw new Error('D1 unavailable');
        return {
          bind() {
            return this;
          },
          async first() {
            return row;
          },
        };
      },
    },
  }) as never;

beforeEach(() => clearEnvironmentCache());

describe('§A production is the only environment permitted to dispatch', () => {
  it('SUPPRESSES: a database stamped staging', async () => {
    const g = await mayDispatchExternally(envWith({ name: 'staging' }));
    expect(g.allowed).toBe(false);
    expect(g.identity.verdict).toBe('NON_PRODUCTION');
  });

  it('DISPATCHES: a database stamped production', async () => {
    const g = await mayDispatchExternally(envWith({ name: 'production' }));
    expect(g.allowed).toBe(true);
    expect(g.identity.verdict).toBe('PRODUCTION');
  });

  it('an environment invented later is suppressed because it was never added', async () => {
    // The ratified allow-list rule. A deny-list would silently permit every environment created
    // after it was written.
    for (const name of ['qa', 'preview', 'demo', 'dev', 'sandbox']) {
      const g = await mayDispatchExternally(envWith({ name }));
      expect(g.allowed, `${name} must not dispatch`).toBe(false);
      clearEnvironmentCache();
    }
  });

  it('the stamp is read case- and whitespace-insensitively', async () => {
    expect((await mayDispatchExternally(envWith({ name: '  PRODUCTION ' }))).allowed).toBe(true);
  });
});

describe('§B an uncertain environment DISPATCHES — this is the half that matters', () => {
  it('DISPATCHES: an unstamped database', async () => {
    // A fresh database, a forgotten stamp, a restored backup. None of these are evidence that
    // this is staging, and suppressing on them would silence a real cascade.
    const g = await mayDispatchExternally(envWith(null));
    expect(g.allowed).toBe(true);
    expect(g.identity.verdict).toBe('INDETERMINATE');
  });

  it('DISPATCHES: an unreadable database', async () => {
    const g = await mayDispatchExternally(envWith(null, { throws: true }));
    expect(g.allowed).toBe(true);
    expect(g.identity.verdict).toBe('INDETERMINATE');
  });

  it('DISPATCHES: an empty stamp', async () => {
    expect((await mayDispatchExternally(envWith({ name: '   ' }))).allowed).toBe(true);
  });

  it('an indeterminate verdict is never cached — a stamp must take effect at once', async () => {
    // Caching it would mean a warm isolate keeps alerting after the fault is fixed, and worse,
    // that the operator cannot tell whether their correction landed.
    const bad = envWith(null);
    await resolveEnvironment(bad);
    const good = await resolveEnvironment(envWith({ name: 'production' }));
    expect(good.verdict).toBe('PRODUCTION');
  });

  it('every verdict carries a detail an operator can act on', async () => {
    for (const row of [null, { name: 'staging' }, { name: 'production' }]) {
      const i = await resolveEnvironment(envWith(row));
      expect(i.detail.length, JSON.stringify(row)).toBeGreaterThan(20);
      clearEnvironmentCache();
    }
  });
});

describe('§C the readiness panel reports posture, and flags the dangerous combination', () => {
  it('a non-production environment holding provider credentials is ALERTING', async () => {
    const p = await dispatchPosture(envWith({ name: 'staging' }, { secrets: { SENDGRID_API_KEY: 'sg-x' } }));
    expect(p.alerting).toBe(true);
    expect(p.externalDispatch).toBe(false);
    expect(p.summary).toMatch(/ALERT/);
  });

  it('a non-production environment with no credentials is not alerting', async () => {
    const p = await dispatchPosture(envWith({ name: 'staging' }));
    expect(p.alerting).toBe(false);
    expect(p.providerCredentials).toEqual([]);
  });

  it('production with credentials is the expected state, not an alert', async () => {
    const p = await dispatchPosture(envWith({ name: 'production' }, { secrets: { SENDGRID_API_KEY: 'sg-x' } }));
    expect(p.alerting).toBe(false);
    expect(p.externalDispatch).toBe(true);
  });

  it('an indeterminate environment still reports external dispatch as ENABLED', async () => {
    // It is enabled — that is the §B behaviour — and the panel must not imply otherwise.
    const p = await dispatchPosture(envWith(null));
    expect(p.externalDispatch).toBe(true);
    expect(p.environment).toBe('INDETERMINATE');
  });
});
