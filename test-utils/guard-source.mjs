/**
 * GUARD SOURCE ACCESS — parsed structure, never prose.
 *
 * "A guard asserts against parsed structure — AST, exported symbols, config values. Never source
 * text, never comments. A comment is not an interface."
 *
 * WHY THIS IS TOOLING AND NOT ADVICE. Six times a guard has matched against a comment: four times
 * a negative assertion failed because the comment EXPLAINING the defect necessarily contains the
 * defect's text, and twice an ordering assertion compared a sentence in a file header to a call
 * 7,600 characters later. Every one of those was written by someone who knew the rule. The rule
 * does not work as a rule; it works as a function you have to call.
 *
 * THE DANGEROUS DIRECTION is not the noisy one. A negative assertion that fails on a comment is
 * annoying and self-announcing. A POSITIVE assertion satisfied by a comment is a guard that
 * reports green while guarding nothing — the same shape as a cost line that always reads zero.
 *
 *   code(path)   source with comments removed. Use for every assertion about BEHAVIOUR.
 *   prose(path)  raw source including comments. Use ONLY when the documentation itself is the
 *                requirement — "§D limits are written down" is a real and checkable property —
 *                and name it in the assertion so a reader knows which one was meant.
 *   json(path)   parsed config. Use for manifests, package.json, tracked infra files.
 *   exportsOf(path) the exported symbol names, for asserting an interface rather than a spelling.
 */
import { readFileSync } from 'node:fs';

const cache = new Map();

function raw(absPath) {
  let v = cache.get(absPath);
  if (v === undefined) {
    v = readFileSync(absPath, 'utf8');
    cache.set(absPath, v);
  }
  return v;
}

/**
 * Strip block and line comments. String literals are preserved: a guard asserting that a route
 * path or an error code appears in the code is asserting about behaviour, and those live in
 * strings.
 */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Behaviour. The default, and what almost every guard means. */
export function code(absPath) {
  return stripComments(raw(absPath));
}

/** Documentation-as-requirement. Rare and deliberate — say so at the call site. */
export function prose(absPath) {
  return raw(absPath);
}

/** Config values, parsed. Never regex a JSON file. */
export function json(absPath) {
  return JSON.parse(raw(absPath));
}

/**
 * Exported symbol names. Asserting `exportsOf(m).includes('verifyDeviceProof')` survives
 * reformatting, renamed locals and moved lines in a way that matching `export function
 * verifyDeviceProof` does not.
 */
export function exportsOf(absPath) {
  const src = code(absPath);
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return [...names];
}

/** Ordering by CALL SITE, not by first mention anywhere in the file. */
export function callOrder(absPath, needles) {
  const src = code(absPath);
  return needles.map((n) => ({ needle: n, index: src.indexOf(n) }));
}
