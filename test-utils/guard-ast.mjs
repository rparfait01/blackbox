/**
 * Brief 54 §A — STRUCTURE, PARSED. The replacement for reading source as text.
 *
 * ═══ WHY TEXT HAD TO GO ══════════════════════════════════════════════════════════════════════
 *
 * `guard-source.mjs` offered four helpers and only `exportsOf()` parsed anything. A guard doing
 * `expect(src).toContain("setCookie(c, 'bbcoord'")` passes when the call is there — and passes,
 * silently green, when the function was renamed, the block moved, or a comment accidentally
 * opened a block comment and deleted 10KB from the stripped view. **"I found no violations" and
 * "I found nothing at all" are the same result in a text search.**
 *
 * Everything here resolves a SUBJECT first and reports its absence as a distinct, named failure.
 * That is the honesty property (§B): a reader must be able to tell a moved function from a
 * broken invariant.
 *
 * ═══ THIS FILE IS ITSELF A GUARD DEPENDENCY (§E1) ════════════════════════════════════════════
 *
 * The meta-guard that forbids text-reading is a guard, and it must not break its own rule. It
 * asserts over guard files using `callsTo()` and `importsOf()` below — parsed, not grepped.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const ts = createRequire(import.meta.url)('typescript');

const cache = new Map();

/** Parse once per path. Throws with the path named — a missing file is never a silent empty AST. */
export function parse(absPath) {
  if (cache.has(absPath)) return cache.get(absPath);
  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch (error) {
    throw new Error(`guard-ast: cannot read ${absPath} — ${String(error)}`);
  }
  if (text.trim().length === 0) {
    throw new Error(`guard-ast: ${absPath} is empty — a guard asserting over it would assert over nothing`);
  }
  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  cache.set(absPath, sf);
  return sf;
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/**
 * SUBJECT RESOLUTION (§B). Every helper below goes through this, so "not found" is always a
 * named failure rather than an empty result that reads as compliance.
 */
export function requireSubject(value, description) {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
    throw new Error(
      `guard-ast: SUBJECT NOT FOUND — ${description}. This is not a passing assertion: the thing ` +
        'this guard watches has moved or been renamed. Fix the guard or restore the subject.',
    );
  }
  return value;
}

/** Every function/method declaration by name, with its node. */
export function functionsIn(absPath) {
  const out = new Map();
  walk(parse(absPath), (n) => {
    if (ts.isFunctionDeclaration(n) && n.name) out.set(n.name.text, n);
    else if (ts.isMethodDeclaration(n) && n.name && ts.isIdentifier(n.name)) out.set(n.name.text, n);
    else if (
      (ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n)) &&
      n.name &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      out.set(n.name.text, n.initializer);
    }
  });
  return out;
}

/** The named function's node. Fails distinctly when it does not exist. */
export function functionNamed(absPath, name) {
  return requireSubject(functionsIn(absPath).get(name), `function '${name}' in ${absPath}`);
}

/**
 * Names of everything CALLED within `scope` (a node, or the whole file).
 *
 * Resolved from the call expression, not matched as text — so `notify(` inside a string or a
 * comment is not a call, and a renamed callee is a changed result rather than a silent miss.
 */
export function callsTo(absPath, scope) {
  const root = scope ?? parse(absPath);
  const names = new Set();
  walk(root, (n) => {
    if (!ts.isCallExpression(n)) return;
    const e = n.expression;
    if (ts.isIdentifier(e)) names.add(e.text);
    else if (ts.isPropertyAccessExpression(e)) {
      names.add(e.name.text);
      names.add(`${e.expression.getText()}.${e.name.text}`);
    }
  });
  return names;
}

/** Module specifiers imported by a file. */
export function importsOf(absPath) {
  const out = new Set();
  walk(parse(absPath), (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.add(n.moduleSpecifier.text);
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(n.arguments[0])) {
      out.add(n.arguments[0].text);
    }
  });
  return out;
}

/** String-literal arguments passed to a named call — how a route path or a cookie name is asserted. */
export function stringArgsOf(absPath, calleeName, scope) {
  const root = scope ?? parse(absPath);
  const args = [];
  walk(root, (n) => {
    if (!ts.isCallExpression(n)) return;
    const e = n.expression;
    const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
    if (name !== calleeName) return;
    for (const a of n.arguments) {
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) args.push(a.text);
    }
  });
  return args;
}

/** Object-literal properties passed to a named call, as {key: text}. For cookie options etc. */
export function objectArgOf(absPath, calleeName, scope) {
  const root = scope ?? parse(absPath);
  let found = null;
  walk(root, (n) => {
    if (found || !ts.isCallExpression(n)) return;
    const e = n.expression;
    const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
    if (name !== calleeName) return;
    for (const a of n.arguments) {
      if (!ts.isObjectLiteralExpression(a)) continue;
      const obj = {};
      for (const p of a.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
          obj[p.name.text] = p.initializer.getText();
        }
      }
      found = obj;
      return;
    }
  });
  return found;
}

/** Does `scope` contain a call to `calleeName`? The common structural assertion. */
export function callsInclude(absPath, calleeName, scope) {
  return callsTo(absPath, scope).has(calleeName);
}
