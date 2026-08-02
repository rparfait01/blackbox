import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path, { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  LOCK_CONFIG_PATH,
  loadLockConfig,
  RETENTION_DAYS,
  RETENTION_MONTHS,
  VAULT_PREFIX,
  assertVaultLock,
  parseLockRules,
  provisionCommand,
} from '../../../scripts/vault-lock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/**
 * Brief 40 §C — the retention rule is verified by READING IT BACK, or it is not verified.
 *
 * Finding 7 was that no repository artifact established a lock existed on production; retention
 * was asserted in a D1 column and in customer-facing documents, and neither can prevent a
 * deletion. A lock provisioned once by hand and never checked again is the same finding wearing
 * a different costume — which is why §B and §C ship together and neither goes alone.
 *
 * These fixtures are wrangler's real output shape, taken from its own formatter
 * (`tableFromBucketLockRulesResponse` → `formatLabelledValues`), so the parser is proven against
 * what the CLI actually emits rather than against something convenient.
 */
const NO_RULES = `Listing lock rules for bucket 'blackbox-vault'...\nThere are no lock rules for bucket 'blackbox-vault'.`;

const CORRECT = `Listing lock rules for bucket 'blackbox-vault'...
name:      vault-36mo-retention
enabled:   Yes
prefix:    vault/
condition: after 1096 days`;

describe('§C the live rule is read back and checked', () => {
  it('parses wrangler’s real labelled output', () => {
    const rules = parseLockRules(CORRECT);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ name: 'vault-36mo-retention', enabled: true, prefix: 'vault/', retentionDays: 1096 });
  });

  it('an absent rule FAILS — this is finding 7 itself', () => {
    const r = assertVaultLock(parseLockRules(NO_RULES));
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/no lock rule covers prefix 'vault\/'/);
  });

  it('the correct rule PASSES', () => {
    expect(assertVaultLock(parseLockRules(CORRECT)).ok).toBe(true);
  });

  // ---- acceptance 15 — mis-scoped prefix must fail, and NAME the mismatch ------------------
  it('a mis-scoped prefix fails and names what was found instead', () => {
    const misScoped = CORRECT.replace('prefix:    vault/', 'prefix:    manifests/');
    const r = assertVaultLock(parseLockRules(misScoped));
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/prefix 'manifests\/'/);
  });

  it('a rule over ALL prefixes does not satisfy vault/ — it would cover the purge path', () => {
    // Breadth is not safety here. A bucket-wide rule would also lock anything else written to
    // this bucket later, and §B is explicit that scope is exactly the sealed-manifest prefix.
    const wide = CORRECT.replace('prefix:    vault/', 'prefix:    (all prefixes)');
    expect(assertVaultLock(parseLockRules(wide)).ok).toBe(false);
  });

  // ---- acceptance 16 — a shortened duration must fail ---------------------------------------
  it('a shortened duration fails and states both numbers', () => {
    const short = CORRECT.replace('after 1096 days', 'after 30 days');
    const r = assertVaultLock(parseLockRules(short));
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/30 days, SHORTER than the 1096 days \(36 months\)/);
  });

  it('a DISABLED rule is a failure, not a pass', () => {
    const off = CORRECT.replace('enabled:   Yes', 'enabled:   No');
    const r = assertVaultLock(parseLockRules(off));
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/DISABLED/);
  });

  it('INDEFINITE retention fails — §0 refused it deliberately', () => {
    // Longer than claimed, and still wrong: indefinite retention on survivor data is the
    // compliance-mode posture §0 rejected, because it would outlive the owner's ability to
    // have her own evidence destroyed.
    const forever = CORRECT.replace('condition: after 1096 days', 'condition: indefinitely');
    const r = assertVaultLock(parseLockRules(forever));
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/INDEFINITELY/);
  });

  it('every problem is reported, not just the first', () => {
    const both = CORRECT.replace('enabled:   Yes', 'enabled:   No').replace('after 1096 days', 'after 10 days');
    expect(assertVaultLock(parseLockRules(both)).problems.length).toBeGreaterThanOrEqual(2);
  });

  it('1096 days, not 1095 — three years contain a leap day', () => {
    // A 1095-day rule can fall one day short of the 36-month sentence it is supposed to back.
    expect(RETENTION_DAYS).toBe(1096);
    expect(RETENTION_MONTHS).toBe(36);
    expect(RETENTION_DAYS).toBeGreaterThan(RETENTION_MONTHS * 30.4);
  });

  it('failure hands back the provisioning command', () => {
    // It names the TRACKED path, not a hand-typed `lock add` — §B's point is reproducibility.
    expect(provisionCommand()).toBe('node scripts/provision-vault-lock.mjs');
  });
});

describe('§B the rule is tracked infrastructure, not a dashboard action', () => {
  it('the tracked config declares the rule, and §C reads its expectations from it', () => {
    // One source of truth. If the assertion carried its own copy of prefix and duration, the
    // file could say one thing and the gate check another, and a deploy would pass while the
    // live bucket matched neither.
    const cfg = loadLockConfig();
    expect(cfg.bucket).toBe('blackbox-vault');
    expect(cfg.prefix).toBe('vault/');
    expect(cfg.retentionDays).toBe(1096);
    expect(cfg.retentionMonths).toBe(36);
    expect(LOCK_CONFIG_PATH.split(path.sep).join('/')).toMatch(/infra\/r2\/blackbox-vault\.lock\.json$/);
  });

  it('the condition is Age-bounded — §0 refused indefinite retention', () => {
    const raw = JSON.parse(read('infra/r2/blackbox-vault.lock.json'));
    expect(raw.rules[0].condition.type).toBe('Age');
    expect(raw.rules[0].condition.maxAgeSeconds).toBe(1096 * 86400);
    expect(raw.rules[0].enabled).toBe(true);
  });

  it('the provisioner refuses any bucket but the vault, and any bucket-wide prefix', () => {
    // `lock set` overwrites every rule and takes whatever bucket name it is handed. The same
    // mistake pointed at blackbox-media would mean a survivor cannot delete her own recordings.
    const src = read('scripts/provision-vault-lock.mjs');
    expect(src).toMatch(/cfg\.bucket !== 'blackbox-vault'/);
    expect(src).toMatch(/\/media\/i\.test\(cfg\.bucket\)/);
    expect(src).toMatch(/!cfg\.prefix\.endsWith\('\/'\)/);
    expect(src).toMatch(/readVaultLock/); // applies, then reads back
  });
});

describe('§E the purge path and the lock cannot collide', () => {
  it('the purge header states the two-bucket rule in full', () => {
    // Collapse the comment's line breaks and leading asterisks first: these sentences wrap, and
    // a phrase that spans two lines is still the phrase.
    const src = read('workers/api/src/lib/media-purge.ts').replace(/\n\s*\*\s?/g, ' ');
    expect(src).toMatch(/TWO BUCKETS, DIFFERENT RULES/);
    expect(src).toMatch(/blackbox-media\s+capture chunks\.\s+NO lock rule\. DELETABLE/);
    expect(src).toMatch(/blackbox-vault\s+sealed manifests\.\s+LOCKED/);
    expect(src).toMatch(/A BUCKET CANNOT BE EMPTIED WHILE LOCK RULES ARE CONFIGURED/);
    expect(src).toMatch(/Never write a sweep that hits the lock/);
  });

  it('the purge routine still targets MEDIA only', () => {
    // If this ever grows a VAULT target, it becomes an operation that fails partway through,
    // having already deleted what was not protected.
    const src = read('workers/api/src/lib/media-purge.ts');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/env\.VAULT/);
  });
});

describe('§B/§D scope and honesty', () => {
  it('the lock is scoped to sealed manifests only, never to capture chunks', () => {
    // The whole §0 reconciliation rests on this: manifests are locked so the OPERATOR cannot
    // destroy the record; chunks are not, so the OWNER can still purge her own recordings.
    expect(VAULT_PREFIX).toBe('vault/');
    const src = read('scripts/vault-lock.mjs');
    expect(src).toMatch(/blackbox-media\s+capture CHUNKS — never locked/);
  });

  it('the sealer writes under exactly the prefix the lock covers', () => {
    // If these ever drift, the lock silently covers nothing — retention would read as
    // provisioned while protecting no object at all.
    expect(read('workers/api/src/lib/custody.ts')).toMatch(/vaultKey = `vault\/\$\{eventId\}\/\$\{packageHash\}\.json`/);
  });

  it('§D limits are written in the code, not only in a document', () => {
    const src = read('scripts/vault-lock.mjs');
    for (const limit of [/IT DOES NOT PREVENT/, /lock remove/, /BILLING LAPSE/, /deletion of the BUCKET|Deletion of the BUCKET/i]) {
      expect(src).toMatch(limit);
    }
  });

  it('the phrase "write-once" is not used as a live claim', () => {
    // Brief 34 §5 forbids it until this brief's acceptance is green, and the correction says
    // metadata asserting retention is not retention.
    expect(read('scripts/vault-lock.mjs')).toMatch(/is not\s+\*?\s*"write-once"/i);
    // and the vault's own code no longer asserts it either
    for (const f of ['workers/api/src/lib/custody.ts', 'workers/api/src/types.ts']) {
      expect(read(f), `${f} must not claim write-once`).not.toMatch(/write-once vault|write-once 36-month|vault is write-once/);
    }
  });
});
