#!/usr/bin/env node
/**
 * The SHA-256 of the built Worker bundle — the thing the acceptance suite actually exercises.
 *
 * ═══ WHY NOT THE COMMIT SHA ══════════════════════════════════════════════════════════════════
 *
 * The acceptance receipt used to name a commit. That is the wrong identity for the question the
 * push gate asks, which is not "have I seen this commit?" but "has the code under test changed
 * since I last spent 1,481 metered requests proving it green?"
 *
 * A docs-only commit changes the SHA and changes nothing the suite can observe. Under the old
 * receipt it cost a full suite run — 1,481 requests against the same plan limit whose exhaustion
 * takes the alert path down — to re-confirm a byte-identical Worker. That happened, and it is
 * why this exists.
 *
 * The bundle hash is the honest identity: change a route, a guard, a message body, and it moves.
 * Change a brief document or this comment, and it does not.
 *
 * ═══ WHAT IS HASHED ══════════════════════════════════════════════════════════════════════════
 *
 * The esbuild output `wrangler deploy --dry-run` produces — the exact artifact that would be
 * uploaded. Not the source tree: source that compiles to identical output IS identical as far as
 * every acceptance check can tell, and a hash over source would reintroduce the false negatives
 * this replaces.
 *
 * Usage:  node scripts/worker-bundle-hash.mjs          (fails if no build exists)
 *         node scripts/worker-bundle-hash.mjs --build  (builds first)
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'workers', 'api', 'dist');

if (process.argv.includes('--build')) {
  execFileSync('pnpm', ['-F', '@blackbox/api', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true });
}

if (!existsSync(DIST)) {
  console.error(`no Worker build at ${path.relative(ROOT, DIST)} — run with --build, or run pnpm build:all first`);
  process.exit(1);
}

/**
 * Hash every emitted CODE file, sorted, with names included — and exclude wrangler's generated
 * README, which carries a BUILD TIMESTAMP.
 *
 * The first version hashed literally every file, reasoning that a change landing in a sourcemap
 * or an extra module must not be missed. That reasoning is right and is kept. What it missed is
 * that `dist/README.md` opens with "generated at 2026-08-04T01:00:36.833Z" — so two builds of
 * byte-identical source produced different hashes, and a receipt could never match anything.
 * Pulling a clock into an identity makes the identity useless.
 *
 * Verified: `index.js` and `index.js.map` are byte-identical across consecutive builds; the
 * README was the only variance.
 */
const IGNORED = new Set(['README.md']);
const files = readdirSync(DIST)
  .filter((f) => statSync(path.join(DIST, f)).isFile() && !IGNORED.has(f))
  .sort();

if (files.length === 0) {
  console.error('the Worker build directory is empty — refusing to emit a hash over nothing');
  process.exit(1);
}

const hash = createHash('sha256');
for (const file of files) {
  hash.update(file);
  hash.update(readFileSync(path.join(DIST, file)));
}
console.log(hash.digest('hex'));
