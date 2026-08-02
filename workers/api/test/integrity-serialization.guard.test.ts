import { readFileSync } from 'node:fs';

import { stripComments } from '../../../test-utils/guard-source.mjs';
import { describe, expect, it } from 'vitest';

// Comment-stripped - behaviour, not prose (test-utils/guard-source.mjs).
const read = (f: string): string => stripComments(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'));

/**
 * Brief 37 — the chain's structural invariants, pinned as source facts.
 *
 * THE DEFECT. Each append read the head, computed seq+1, then issued a D1 batch. The batch
 * was transactional; the READ was outside it. Two overlapping requests both read seq=5: A
 * inserted record 6A and set the head to 6A, B's `INSERT OR IGNORE` was silently dropped, and
 * B still set the head to 6B. The signed head then named a record that did not exist — no
 * attacker needed, just two chunk uploads overlapping, which is the normal case.
 *
 * THE FIRST FIX WAS NOT ENOUGH, and the run that proved it is worth recording. Serializing
 * the calls inside a per-event Durable Object did not help, because each call still re-read
 * the head from D1 — and D1 serves reads from replicas. Under 20 concurrent uploads the
 * result was record seq 0 with chainHash 0e16310a and record seq 1 with prevHash a484174a: a
 * head value no stored record ever produced. Ordering the callers cannot fix an
 * eventually-consistent read.
 *
 * So the head moved INTO the Durable Object's own storage, which is strongly consistent and
 * single-threaded per instance, and D1 became the durable record rather than the source of
 * the next sequence. Re-run: 20/20 records, contiguous, head matching, VERIFIED.
 */
describe('§A serialization is structural, and the head is not re-read', () => {
  const do_ = read('integrity-do.ts');
  const integrity = read('lib/integrity.ts');

  it('the DO owns the head in its OWN storage — never re-read from D1 per append', () => {
    expect(do_).toMatch(/state\.storage\.put\('head'/);
    expect(do_).toMatch(/private head: \{ seq: number; chainHead: string \} \| null/);
    // The sequence is handed to the writer, never derived inside it — that derivation was
    // the D1 read that made ordering pointless.
    expect(integrity).toMatch(/export async function appendAtSequence/);
    expect(integrity).not.toMatch(/export async function appendRecordSerialized/);
  });

  it('the head advances ONLY after a durable write, and never on a replay', () => {
    // A replay appends nothing, so moving the head would burn a sequence no record fills.
    expect(do_).toMatch(/if \(result\.ok && !result\.replayed && result\.chainHash\)/);
  });

  it('appends are queued, so a read and its write are never interleaved', () => {
    expect(do_).toMatch(/private tail: Promise<unknown>/);
    expect(do_).toMatch(/this\.tail = run\.then\(/);
  });
});

describe('§0 the integrity DO cannot contend with the cascade alarm', () => {
  const do_ = read('integrity-do.ts');
  const cascade = read('cascade-do.ts');

  it('the integrity DO sets NO alarm at all', () => {
    // Brief 36 §11 moved the cascade tail onto CascadeScheduler's alarm. A DO has ONE alarm,
    // so a second consumer would silently displace the first — the exact truncation §11 just
    // fixed. Separate namespaces already keep them apart; setting no alarm here makes the
    // contention impossible rather than merely unlikely.
    //
    // Comments are stripped first: this file EXPLAINS the rule at length, and matching its
    // own prose would make the guard pass or fail on how it is documented rather than on
    // what it does.
    const code = do_.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/setAlarm/);
    expect(code).not.toMatch(/async alarm\(/);
    // …while the cascade DO still owns its own, unchanged.
    expect(cascade).toMatch(/setAlarm/);
  });

  it('they are separate namespaces, bound separately in both environments', () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    expect((toml.match(/name = "INTEGRITY_DO"/g) ?? []).length).toBe(2); // prod + staging
    expect(toml).toMatch(/class_name = "IntegrityChain"/);
    expect(toml).toMatch(/new_sqlite_classes = \["IntegrityChain"\]/);
  });
});

describe('§B a collision fails loud and never costs the capture', () => {
  const integrity = read('lib/integrity.ts');

  it('INSERT OR IGNORE is gone from the integrity path', () => {
    // The silent drop was the whole defect: the losing insert vanished while its head upsert
    // still landed.
    const code = integrity.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/INSERT OR IGNORE INTO integrity_records/);
  });

  it('a collision is distinguishable, audited, and declared as a gap', () => {
    expect(integrity).toMatch(/integrity_sequence_collision/);
    expect(integrity).toMatch(/export async function recordChainGap/);
    expect(integrity).toMatch(/integrity\.chain_gap/);
  });

  it('a failed append still returns null rather than throwing into the capture path', () => {
    // Losing evidence to protect a hash chain inverts the priority. The chunk uploads; the
    // chain records that it is short.
    expect(integrity).toMatch(/export async function appendToChain/);
    expect(integrity).toMatch(/return null;/);
  });
});

describe('§E the four outcomes stay four', () => {
  const verdict = readFileSync(new URL('../src/lib/chain-verdict.ts', import.meta.url), 'utf8');

  it('all four are represented and distinct', () => {
    for (const o of ['VERIFIED', 'INCOMPLETE', 'PURGED_BY_CONSENT', 'BROKEN']) {
      expect(verdict).toContain(`'${o}'`);
    }
  });

  it('PURGED_BY_CONSENT is verified against the consent audit row, not inferred from absence', () => {
    // Production holds chain records attesting to objects purged on recorded consent. Without
    // this outcome the first export off production reads as tampered — and a verifier that
    // cries tamper over a consented purge is one nobody believes when it matters.
    expect(verdict).toMatch(/chunks\.purged_owner_consent/);
    expect(verdict).toMatch(/restorePoint/);
  });

  it('BROKEN is decided BEFORE a purge or a gap can excuse it', () => {
    const brokenAt = verdict.indexOf('head (seq ${head.seq}) does not correspond');
    const gapAt = verdict.indexOf("outcome: 'INCOMPLETE'");
    const purgeAt = verdict.indexOf("outcome: 'PURGED_BY_CONSENT'");
    expect(brokenAt).toBeGreaterThan(-1);
    expect(brokenAt).toBeLessThan(gapAt);
    expect(gapAt).toBeLessThan(purgeAt);
  });
});
