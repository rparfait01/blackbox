/**
 * Brief 40 §B/§C/§D — THE VAULT RETENTION RULE, AND WHAT IT ACTUALLY PREVENTS.
 *
 * ══ §D — STATE THE LIMITS HONESTLY. Read this before quoting a retention claim anywhere. ══
 *
 * An R2 bucket lock rule prevents DELETION AND OVERWRITE of objects under a prefix for a stated
 * duration. That is a real storage-layer control and it is what Brief 2 §C3 always meant to
 * claim. It is NOT S3 Object Lock in compliance mode, and the difference is the whole of §0:
 *
 *   IT DOES PREVENT   an object under `vault/` being deleted or overwritten before its term —
 *                     by the application, by a Worker binding, by the R2 API, by the dashboard,
 *                     by a mistaken script, or by an operator who wants it gone.
 *
 *   IT DOES NOT PREVENT
 *     · An account holder REMOVING THE RULE. `wrangler r2 bucket lock remove` exists and needs
 *       no ceremony. The rule binds ordinary operation; it does not bind a determined owner of
 *       the account, and no R2 mode does.
 *     · Deletion of the BUCKET, or of the account.
 *     · Loss through BILLING LAPSE. An unpaid account's data does not survive because a lock
 *       rule asked it to.
 *     · Anything at all outside the `vault/` prefix — working chunks in blackbox-media are
 *       deliberately NOT covered, which is what keeps the owner-consented purge lawful.
 *
 * So the honest sentence, and the only one any document may use: sealed evidence is retained
 * for 36 months under a storage-layer retention rule that binds the OPERATOR. It is not
 * "write-once", it is not immutable against the account holder, and it does not survive the
 * account itself. An institutional buyer's counsel needs exactly this distinction; a survivor
 * needs the other half of it, which is that her own recordings never became undeletable.
 *
 * ══ §0 — WHY OPERATOR-BINDING RATHER THAN COMPLIANCE MODE ══
 *
 * R2 offers three lock conditions: Age (`--retention-days`), Date (`--retention-date`), and
 * Indefinite. NONE of them is principal-scoped — no R2 mode can permit an owner-directed delete
 * while refusing an operator one, because R2 sees one account and cannot tell the two apart.
 *
 * The distinction is therefore expressed in the ARCHITECTURE rather than asked of the storage
 * layer, and it works because the two things live in different buckets:
 *
 *   blackbox-vault  `vault/`   sealed MANIFESTS — locked. The operator cannot quietly destroy
 *                              the record that an incident existed and what it contained.
 *   blackbox-media             capture CHUNKS — never locked. An owner-consented purge destroys
 *                              them, as it did for 62 objects at 13c539f.
 *
 * After a consented purge the manifest survives and its export reads `PURGED_BY_CONSENT`
 * (Brief 37 §E), which is the already-built and correct outcome: the record of the incident is
 * preserved, the content the survivor asked to be destroyed is gone. The operator is bound; the
 * owner is not. Had the lock been placed over blackbox-media instead, a survivor would have
 * discovered she could not delete her own recordings — which inverts the principle the product
 * exists to serve, and is a live safety problem rather than a compliance nicety.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * §B — ONE SOURCE OF TRUTH. The expected rule is READ from the tracked infra file rather than
 * restated here. If the assertion carried its own copy of the prefix and duration, §B and §C
 * could disagree silently: the file would say one thing, the gate would check another, and the
 * deploy would pass while the live bucket matched neither. Config and assertion read the same
 * bytes or the verification means nothing.
 */
export const LOCK_CONFIG_PATH = path.join(ROOT, 'infra/r2/blackbox-vault.lock.json');

export function loadLockConfig(file = LOCK_CONFIG_PATH) {
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const rule = (cfg.rules ?? [])[0];
  if (!rule) throw new Error(`${file} declares no lock rules`);
  if (rule.condition?.type !== 'Age' || typeof rule.condition.maxAgeSeconds !== 'number') {
    throw new Error(`${file} rule '${rule.id}' must use an Age condition — §0 chose a bounded term`);
  }
  return {
    bucket: cfg.bucket,
    name: rule.id,
    prefix: rule.prefix,
    retentionDays: rule.condition.maxAgeSeconds / 86400,
    retentionMonths: cfg.retentionMonths,
    rules: cfg.rules,
  };
}

const CONFIG = loadLockConfig();

/** 36 months, as declared in tracked config. */
export const RETENTION_MONTHS = CONFIG.retentionMonths;

/**
 * 1096, not 1095. Three calendar years contain at least one leap day, so 1095 days can fall one
 * day SHORT of a 36-month claim. The rule must never be briefer than the sentence it backs.
 */
export const RETENTION_DAYS = CONFIG.retentionDays;

/** Only the sealed-manifest prefix. Working chunks and the purge path must stay reachable. */
export const VAULT_PREFIX = CONFIG.prefix;

export const VAULT_LOCK_NAME = CONFIG.name;
export const VAULT_BUCKET = CONFIG.bucket;

/**
 * Parse `wrangler r2 bucket lock list`. Wrangler emits labelled `key: value` blocks, one per
 * rule, separated by blank lines — there is no JSON mode, so this reads the same text a human
 * would. Kept pure so §C's assertions are provable against fixtures without provisioning a lock.
 */
export function parseLockRules(text) {
  if (/There are no lock rules for bucket/.test(text)) return [];
  const rules = [];
  for (const block of text.split(/\n\s*\n/)) {
    const field = (k) => {
      const m = block.match(new RegExp(`^\\s*${k}:\\s*(.+?)\\s*$`, 'mi'));
      return m ? m[1].trim() : null;
    };
    const name = field('name');
    const condition = field('condition');
    if (!name || !condition) continue;
    const days = condition.match(/^after\s+([\d.]+)\s+days?$/i);
    rules.push({
      name,
      enabled: /^yes$/i.test(field('enabled') ?? ''),
      prefix: field('prefix') === '(all prefixes)' ? '' : (field('prefix') ?? ''),
      condition,
      retentionDays: days ? Number(days[1]) : null,
      indefinite: /indefinitely/i.test(condition),
    });
  }
  return rules;
}

/**
 * §C — assert the LIVE rule matches what is claimed. Returns every problem rather than the first,
 * because an operator fixing a mis-scoped prefix should not then discover the duration is also
 * wrong. Absent, mis-scoped, disabled, or shortened are each a deploy failure.
 */
export function assertVaultLock(rules, expected = {}) {
  const prefix = expected.prefix ?? VAULT_PREFIX;
  const minDays = expected.retentionDays ?? RETENTION_DAYS;
  const problems = [];

  const covering = rules.filter((r) => r.prefix === prefix);
  if (covering.length === 0) {
    const seen = rules.length ? rules.map((r) => `'${r.name}' (prefix '${r.prefix}')`).join(', ') : 'none';
    problems.push(`no lock rule covers prefix '${prefix}'. Rules present: ${seen}.`);
    return { ok: false, problems, rule: null };
  }

  // Prefer an enabled rule; a disabled one is reported rather than silently accepted.
  const rule = covering.find((r) => r.enabled) ?? covering[0];
  if (!rule.enabled) problems.push(`lock rule '${rule.name}' covers '${prefix}' but is DISABLED.`);

  if (rule.indefinite) {
    // Longer than claimed is not a failure of the claim, but it IS a §0 problem: indefinite
    // retention on survivor data is the compliance-mode posture §0 deliberately refused.
    problems.push(
      `lock rule '${rule.name}' retains INDEFINITELY. §0 chose a bounded ${RETENTION_MONTHS}-month term; ` +
        'indefinite retention on survivor data was refused deliberately.',
    );
  } else if (rule.retentionDays == null) {
    problems.push(`lock rule '${rule.name}' has an unrecognised condition: '${rule.condition}'.`);
  } else if (rule.retentionDays < minDays) {
    problems.push(
      `lock rule '${rule.name}' retains for ${rule.retentionDays} days, SHORTER than the ` +
        `${minDays} days (${RETENTION_MONTHS} months) the product claims.`,
    );
  }

  return { ok: problems.length === 0, problems, rule };
}

/** Read the live rules. Control-plane call — it does not spend the Workers request budget. */
export function readVaultLock(bucket, cwd) {
  return execFileSync('npx', ['wrangler', 'r2', 'bucket', 'lock', 'list', bucket], {
    cwd,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

/** The provisioning command, printed on failure so recovery is resumption rather than guesswork. */
export function provisionCommand() {
  // Names the tracked-config path, not a hand-typed `lock add` — §B's whole point is that the
  // rule is reproducible from the repository rather than retyped from memory at a prompt.
  return 'node scripts/provision-vault-lock.mjs';
}
