#!/usr/bin/env node
/**
 * Brief 40 §B — APPLY THE TRACKED RETENTION RULE TO THE VAULT BUCKET.
 *
 * The rule lives in `infra/r2/blackbox-vault.lock.json` and is applied from there, so it is
 * reproducible from the repository rather than remembered by whoever typed it at a prompt once.
 * Finding 7 was precisely the absence of such an artifact: retention was asserted in a D1 column
 * and in customer-facing documents, and no file in this repo established that anything backed it.
 *
 * WHAT THIS WILL NOT DO. It refuses any bucket other than the one the config names, and it
 * refuses a rule whose prefix is empty or does not end in `/`. A bucket-wide rule on the vault
 * would be merely over-broad; the same mistake pointed at blackbox-media would mean a survivor
 * cannot delete her own recordings, which is a safety failure rather than a configuration one.
 * The guard is here because `lock set` OVERWRITES every rule on the bucket and takes whatever
 * bucket name it is handed.
 *
 * Usage:  node scripts/provision-vault-lock.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { LOCK_CONFIG_PATH, assertVaultLock, loadLockConfig, parseLockRules, readVaultLock } from './vault-lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = path.join(ROOT, 'workers/api');
const DRY = process.argv.includes('--dry-run');

const cfg = loadLockConfig();

// ---- refuse anything that could reach capture media ------------------------------------------
if (cfg.bucket !== 'blackbox-vault') {
  console.error(`✗ REFUSED: this script provisions 'blackbox-vault' only; config names '${cfg.bucket}'.`);
  process.exit(1);
}
if (/media/i.test(cfg.bucket)) {
  console.error('✗ REFUSED: a lock rule must never be applied to capture media.');
  process.exit(1);
}
if (!cfg.prefix || !cfg.prefix.endsWith('/')) {
  console.error(`✗ REFUSED: prefix '${cfg.prefix}' is not a directory prefix. A bucket-wide lock is not §B.`);
  process.exit(1);
}

console.log(`Applying ${cfg.rules.length} lock rule(s) from ${path.relative(ROOT, LOCK_CONFIG_PATH)}`);
console.log(`  bucket : ${cfg.bucket}`);
console.log(`  prefix : ${cfg.prefix}`);
console.log(`  term   : ${cfg.retentionDays} days (${cfg.retentionMonths} months)`);

if (DRY) {
  console.log('\n--dry-run: nothing applied.');
  process.exit(0);
}

execFileSync(
  'npx',
  ['wrangler', 'r2', 'bucket', 'lock', 'set', cfg.bucket, '--file', JSON.stringify(LOCK_CONFIG_PATH), '--force'],
  { cwd: API, stdio: 'inherit', shell: true },
);

// Read back immediately. Applying without verifying is the habit this brief exists to break.
const verdict = assertVaultLock(parseLockRules(readVaultLock(cfg.bucket, API)));
if (!verdict.ok) {
  console.error('\n✗ applied, but the readback does not match:');
  verdict.problems.forEach((p) => console.error(`    · ${p}`));
  process.exit(1);
}
console.log(`\n✓ live rule verified: '${verdict.rule.name}' over '${verdict.rule.prefix}' — ${verdict.rule.condition}`);
