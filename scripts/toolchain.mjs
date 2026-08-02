/**
 * RATIFIED FROM BRIEF 35 FIX A §A — A DECLARED VERSION IS NOT AN INSTALLED VERSION.
 *
 * Two rules, both learned the same way:
 *
 *   1. No build or deploy step invokes a tool from the network. Every tool is a pinned
 *      dependency, invoked from the directory where it is declared. If `npx` resolves it from
 *      the registry, the pipeline is wrong.
 *   2. The pipeline REPORTS the version it actually ran, and a mismatch with the manifest fails
 *      the deploy.
 *
 * WHY. `deploy-pages.mjs` ran `npx wrangler` from the repository root, which has no wrangler in
 * its node_modules — so npx quietly fetched one from the registry. The client half of every
 * deploy was published by 4.99.0 off the network while package.json declared 4.118.0. Nothing
 * failed, nothing warned, and the two numbers were never printed next to each other, so for
 * months the answer to "which wrangler published production?" was "whatever the registry served
 * that morning".
 *
 * This is the same class as the phantom `0 request(s)` cost line: a value that reads as
 * authoritative while being structurally unable to reflect reality. The cure is the same too —
 * measure the real thing at the point of use, and print it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Minimal semver-range satisfaction for the forms this repo actually pins.
 *
 * It handles `^`, `~`, and exact. It deliberately THROWS on anything else rather than returning
 * true: a range form this cannot reason about must not be waved through, because "I did not
 * understand the constraint" and "the constraint is met" are different answers and only one of
 * them is safe to act on.
 */
export function satisfies(version, range) {
  const parse = (v) => v.trim().replace(/^[\^~=v]/, '').split('.').map(Number);
  const [vMaj, vMin, vPat] = parse(version);
  const [rMaj, rMin, rPat] = parse(range);
  if ([vMaj, vMin, vPat, rMaj, rMin, rPat].some((n) => !Number.isFinite(n))) {
    throw new Error(`unparseable version/range: '${version}' vs '${range}'`);
  }
  const atLeast = vMaj > rMaj || (vMaj === rMaj && (vMin > rMin || (vMin === rMin && vPat >= rPat)));
  if (range.startsWith('^')) return vMaj === rMaj && atLeast;
  if (range.startsWith('~')) return vMaj === rMaj && vMin === rMin && vPat >= rPat;
  if (/^[\d]/.test(range.trim())) return vMaj === rMaj && vMin === rMin && vPat === rPat;
  throw new Error(`unsupported range form '${range}' — refusing to assume it is satisfied`);
}

/**
 * Check one (directory, tool) pair: the tool must be INSTALLED in that directory's own
 * node_modules (so `npx` there cannot reach the network), and the installed version must satisfy
 * what that directory's package.json declares.
 */
export function checkTool(root, dir, tool) {
  const where = path.join(root, dir);
  const manifestPath = path.join(where, 'package.json');
  let declared;
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    declared = m.devDependencies?.[tool] ?? m.dependencies?.[tool];
  } catch {
    return { dir, tool, ok: false, problem: `no package.json at ${dir}` };
  }
  if (!declared) {
    return {
      dir,
      tool,
      ok: false,
      problem: `${dir}/package.json does not declare '${tool}', so \`npx ${tool}\` there resolves from the REGISTRY`,
    };
  }
  let installed;
  try {
    installed = JSON.parse(readFileSync(path.join(where, 'node_modules', tool, 'package.json'), 'utf8')).version;
  } catch {
    return { dir, tool, declared, ok: false, problem: `'${tool}' is declared in ${dir} but NOT INSTALLED — run pnpm install` };
  }
  let ok;
  try {
    ok = satisfies(installed, declared);
  } catch (e) {
    return { dir, tool, declared, installed, ok: false, problem: e.message };
  }
  return {
    dir,
    tool,
    declared,
    installed,
    ok,
    problem: ok ? null : `${dir}: installed ${tool}@${installed} does not satisfy declared '${declared}'`,
  };
}

/** Every (directory, tool) pair the deploy pipeline actually invokes. */
export const DEPLOY_TOOLCHAIN = [
  { dir: 'workers/api', tool: 'wrangler' },
  { dir: 'apps/pwa', tool: 'wrangler' },
];

export function checkDeployToolchain(root, pairs = DEPLOY_TOOLCHAIN) {
  return pairs.map((p) => checkTool(root, p.dir, p.tool));
}
