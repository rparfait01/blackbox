import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { SEAL_BATCH, UNSEALED_ALERT_MS } from '../src/lib/seal';

const read = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

/**
 * Brief 40 §F — sealing is automatic, and closure never waits on it.
 *
 * WHAT THE QUERY FOUND. `exportPackage` was the only writer of the vault and its only caller
 * was GET /v1/c/:id/export, gated on a verified recipient. Production held 0 recipients,
 * 0 bindings, 0 custody_transfers and 0 vault_objects against 5 closed events — while
 * coordinators had claimed all 5 and viewed 6 times. The gate was never broken; it was simply
 * never opened, so nothing was ever sealed and every retention claim was vacuous.
 *
 * The case that matters most is the one with nobody left to act: a seized or destroyed phone.
 */
describe('§F1 every terminal state seals', () => {
  it('all six close paths enqueue', () => {
    const timeout = read('lib/closure-timeout.ts');
    const consent = read('lib/closure-consent.ts');
    const index = read('index.ts');
    expect(timeout).toMatch(/enqueueSeal\(env, row\.id, 'feed_lost'\)/);
    expect(timeout).toMatch(/enqueueSeal\(env, row\.id, 'orphan'\)/);
    expect(consent).toMatch(/enqueueSeal\(env, eventId, closedBy === 'survivor_solo' \? 'user_close' : 'dual_consent'\)/);
    expect(index).toMatch(/enqueueSeal\(c\.env, eventId, 'force_close'\)/);
  });

  it('DISCOVERY is the guarantee, not the enqueue calls', () => {
    // Instrumenting N call sites is a promise; asking the database which closed events have
    // no vault object is a fact. A future close path that forgets to enqueue is still covered.
    const seal = read('lib/seal.ts');
    expect(seal).toMatch(/NOT EXISTS \(SELECT 1 FROM vault_objects v WHERE v\.eventId = e\.id\)/);
    expect(seal).toMatch(/e\.status = 'closed'/);
    // Canary fixtures never enter the vault (Brief 35 §C).
    expect(seal).toMatch(/e\.isTest = 0/);
  });
});

describe('§F2 closure NEVER waits on sealing', () => {
  const seal = read('lib/seal.ts');

  it('enqueue is one insert and swallows its own errors', () => {
    // Closure is the survivor's exit from a live alert. No archival step may stand between
    // her and it, delay it, or fail it — so a failed enqueue cannot propagate.
    const fn = seal.slice(seal.indexOf('export async function enqueueSeal'), seal.indexOf('async function discoverUnsealed'));
    expect(fn).toMatch(/INSERT OR IGNORE INTO seal_pending/);
    expect(fn).toMatch(/catch \(error\)/);
    expect(fn).not.toMatch(/throw/);
  });

  it('no close path awaits the actual seal', () => {
    // sealEvent must not be called from any close path — only from the cron drain.
    for (const f of ['lib/closure-timeout.ts', 'lib/closure-consent.ts']) {
      expect(read(f), `${f} must not seal inline`).not.toMatch(/sealEvent\(/);
    }
  });
});

describe('§F3 the drain is a bounded cron job, not the integrity DO', () => {
  it('runs on the cron, under the 20s bound like every other job', () => {
    const cron = read('scheduled.ts');
    expect(cron).toMatch(/await boundedJob\('seal',/);
    expect(cron).toMatch(/await boundedJob\('seal_alert',/);
  });

  it('is NOT on the integrity Durable Object — Brief 37 §D boundary holds', () => {
    // That object owns integrity appends and event-scoped ordering. One DO must not become
    // the place everything ends up, which is the boundary its own header states.
    const integrityDo = read('integrity-do.ts');
    expect(integrityDo).not.toMatch(/sealEvent|drainSealQueue|seal_pending/);
  });

  it('walks the primary key and advances past failures', () => {
    const seal = read('lib/seal.ts');
    expect(seal).toMatch(/ORDER BY eventId ASC LIMIT \?/);
    // A failing event books backoff rather than blocking the ones behind it.
    expect(seal).toMatch(/nextAttemptAt = \?/);
    expect(SEAL_BATCH).toBeLessThanOrEqual(25);
  });
});

describe('§F4/§F5 idempotent, and access is not existence', () => {
  const custody = read('lib/custody.ts');

  it('sealing takes no recipient', () => {
    // Recipient verification gates ACCESS to the artifact; it must not decide whether the
    // artifact EXISTS. Conflating them is why the vault stayed empty.
    const fn = custody.slice(custody.indexOf('export async function sealEvent'), custody.indexOf('export async function exportPackage'));
    expect(fn).not.toMatch(/recipientId/);
    expect(fn).toMatch(/INSERT OR IGNORE INTO vault_objects/);
  });

  it('export retrieves the seal rather than creating a second one', () => {
    const fn = custody.slice(custody.indexOf('export async function exportPackage'));
    expect(fn).toMatch(/const sealed = await sealEvent\(env, eventId, workerOrigin\)/);
    // The custody transfer is the export's own record; sealing writes none.
    expect(fn).toMatch(/INSERT INTO custody_transfers/);
  });

  it('the vault key is content-addressed, so a re-seal writes nothing new', () => {
    expect(custody).toMatch(/vault\/\$\{eventId\}\/\$\{packageHash\}\.json/);
    expect(custody).toMatch(/const existing = await env\.VAULT\.head\(vaultKey\)/);
  });

  it('the route still gates access on a verified recipient', () => {
    const index = read('index.ts');
    const route = index.slice(index.indexOf("app.get('/v1/c/:id/export'"), index.indexOf("app.get('/v1/c/:id/export'") + 900);
    expect(route).toMatch(/getVerifiedRecipient/);
    expect(route).toMatch(/identity not verified/);
  });
});

describe('§F7 unsealed closed events are alertable and reported', () => {
  const seal = read('lib/seal.ts');

  it('an alert fires past the threshold', () => {
    expect(UNSEALED_ALERT_MS).toBeGreaterThan(0);
    expect(seal).toMatch(/alert: 'closed_event_unsealed'/);
    expect(seal).toMatch(/level: 'error'/);
  });

  it('the readiness panel reports sealing beside encryption and vault coverage', () => {
    const index = read('index.ts');
    expect(index).toMatch(/const seal = await sealCoverage\(c\.env\)/);
    expect(index).toMatch(/SEALING: /);
  });
});
