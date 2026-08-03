#!/usr/bin/env node
/**
 * Brief 42 §E4 — THE FACADE HARNESS. Built before any CSP work, because §5 is right: enforcing a
 * policy without a way to prove the facade still renders is enforcing blind, and the person who
 * discovers a broken Hidden facade is a survivor in the middle of needing it.
 *
 * It does two separate jobs, and keeping them separate is the point — conflating them would let
 * one pretend to cover the other.
 *
 *   AUDIT     Enumerate what the BUILT bundle actually requires — every script, stylesheet,
 *             inline block, blob/data usage, worker registration and network destination — and
 *             check the proposed policy admits every one. This is the check that answers "will
 *             this CSP break the facade?" mechanically, before it is ever served.
 *
 *   SNAPSHOT  Produce a deterministic fingerprint of the facade shell so a before/after diff is a
 *             diff and not an impression. §E4 says diff it, do not eyeball it.
 *
 * WHAT THIS HONESTLY DOES NOT DO, said plainly because a harness that overstates itself is worse
 * than none. It does not execute the app. A browser enforces CSP at runtime against requests the
 * code actually makes, and a destination assembled at runtime from parts — a template literal, a
 * config value — is invisible to static analysis. So this is necessary and not sufficient: it
 * catches the whole class of "the policy forbids something the bundle plainly needs" before
 * anything is served, and the report-only pass in a real browser (§A) catches the rest. Neither
 * replaces the other, and the CSP is not enforced until both are clean.
 *
 * Usage:
 *   node scripts/facade-audit.mjs --audit                     check the policy against the bundle
 *   node scripts/facade-audit.mjs --snapshot --label=before   write .facade/before.json
 *   node scripts/facade-audit.mjs --diff=before,after         byte-diff two snapshots
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'apps/pwa/dist');
const OUT = path.join(ROOT, '.facade');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.join('=') || 'true'];
  }),
);

const config = JSON.parse(readFileSync(path.join(ROOT, 'config/security-headers.json'), 'utf8'));

/** Every file in dist, sorted, so a listing is deterministic across machines. */
function walk(dir, base = dir) {
  return readdirSync(dir)
    .flatMap((e) => {
      const full = path.join(dir, e);
      return statSync(full).isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
    })
    .sort();
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

// ---- what the built bundle requires -----------------------------------------------------------

function requirements() {
  if (!existsSync(DIST)) {
    console.error(`no build at ${path.relative(ROOT, DIST)} — run \`pnpm -F pwa build\` first`);
    process.exit(1);
  }
  const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const files = walk(DIST);
  const js = files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(path.join(DIST, f), 'utf8'));
  const bundle = js.join('\n');

  const attr = (re) => [...html.matchAll(re)].map((m) => m[1]);
  const externalScripts = attr(/<script[^>]+src="([^"]+)"/g);
  const stylesheets = attr(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g);

  return {
    // §A — inline is the thing that forces 'unsafe-inline' or a nonce. Counted, not assumed.
    inlineScripts: (html.match(/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/g) ?? []).length,
    inlineStyles: (html.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? []).length,
    externalScripts,
    stylesheets,
    manifest: attr(/<link[^>]+rel="manifest"[^>]+href="([^"]+)"/g),
    icons: attr(/<link[^>]+rel="[^"]*icon[^"]*"[^>]+href="([^"]+)"/g),
    usesBlob: /blob:|createObjectURL/.test(bundle),
    usesDataUri: /data:image|data:application/.test(bundle) || /data:image/.test(html),
    registersServiceWorker: /serviceWorker/.test(bundle),
    usesDedicatedWorker: /new\s+Worker\s*\(/.test(bundle),
    usesWasm: /WebAssembly|\.wasm/.test(bundle),
    // connect-src treats wss: as a SEPARATE scheme from https:. A WebSocket added later would be
    // blocked by a policy that looks complete, and the symptom would be a dashboard that silently
    // stops updating rather than an error anyone notices.
    usesWebSocket: /new\s+WebSocket\s*\(|wss:\/\//.test(bundle),
    usesEventSource: /new\s+EventSource\s*\(/.test(bundle),
    usesEval: /\beval\s*\(|new\s+Function\s*\(/.test(bundle),
    // Absolute origins the bundle mentions. Mentioning is not fetching, so these are REPORTED for
    // a human to classify rather than silently treated as connect-src requirements.
    absoluteOrigins: [...new Set([...bundle.matchAll(/https:\/\/([a-zA-Z0-9.-]+)/g)].map((m) => `https://${m[1]}`))].sort(),
    files,
  };
}

// ---- does the policy admit them? --------------------------------------------------------------

const permits = (directive, value) => {
  const list = config.csp[directive] ?? config.csp['default-src'] ?? [];
  return list.includes(value);
};

function audit() {
  const req = requirements();
  const problems = [];
  const notes = [];

  if (req.inlineScripts > 0 && !permits('script-src', "'unsafe-inline'")) {
    problems.push(
      `${req.inlineScripts} inline <script> block(s) in index.html, but script-src has no 'unsafe-inline', nonce or hash. The app would not boot.`,
    );
  }
  if (req.inlineStyles > 0 && !permits('style-src', "'unsafe-inline'")) {
    problems.push(`${req.inlineStyles} inline <style> block(s), but style-src has no 'unsafe-inline'. The facade would render unstyled.`);
  }
  for (const src of req.externalScripts) {
    if (src.startsWith('/') || src.startsWith('./')) {
      if (!permits('script-src', "'self'")) problems.push(`same-origin script ${src} but script-src lacks 'self'`);
    } else {
      problems.push(`script from ${src} is not same-origin and is not permitted — third-party script in the facade`);
    }
  }
  for (const href of req.stylesheets) {
    if (href.startsWith('/') && !permits('style-src', "'self'")) problems.push(`stylesheet ${href} but style-src lacks 'self'`);
  }
  if (req.usesBlob && !(permits('media-src', 'blob:') || permits('default-src', 'blob:'))) {
    problems.push("capture uses blob: URLs (MediaRecorder/createObjectURL) but media-src does not permit blob: — recordings would not play back");
  }
  if (req.usesBlob && !permits('img-src', 'blob:')) {
    notes.push('bundle uses blob: and img-src permits it — needed if a captured frame is ever shown as an image');
  }
  if (req.registersServiceWorker && !permits('worker-src', "'self'")) {
    problems.push("a service worker is registered but worker-src does not permit 'self' — registration fails and OFFLINE CAPTURE BREAKS (§E1)");
  }
  if (req.usesDedicatedWorker && !permits('worker-src', "'self'")) {
    problems.push("bundle constructs a Worker but worker-src does not permit 'self'");
  }
  if (req.usesWebSocket && !(config.csp['connect-src'] ?? []).some((v) => v.startsWith('wss://') || v === "'self'")) {
    problems.push(
      'the bundle opens a WebSocket but connect-src lists no wss: origin — connect-src treats wss: as a separate scheme, and the symptom would be a stream that silently stops rather than an error',
    );
  }
  if (req.usesEventSource && !(config.csp['connect-src'] ?? []).length) {
    problems.push('the bundle opens an EventSource but connect-src is empty');
  }
  if (req.usesWasm && !permits('script-src', "'wasm-unsafe-eval'")) {
    problems.push("bundle references WebAssembly but script-src lacks 'wasm-unsafe-eval'");
  }
  if (req.usesEval && !permits('script-src', "'unsafe-eval'")) {
    notes.push("bundle contains eval/new Function — usually a library's dead branch. Verify in the report-only pass; the policy deliberately does NOT grant 'unsafe-eval'.");
  }
  if (req.manifest.length && !permits('manifest-src', "'self'")) {
    problems.push('a web manifest is linked but manifest-src does not permit self — install prompt breaks');
  }
  if (!permits('frame-ancestors', "'none'")) {
    problems.push("frame-ancestors must deny embedding (§A)");
  }

  // connect-src: report every absolute origin so a human classifies it. A mention is not a fetch.
  const apiOrigins = (config.csp['connect-src'] ?? []).filter((v) => v.startsWith('https://'));
  const classified = config._originsMentionedButNeverFetched ?? {};
  // UNCLASSIFIED is the signal. A mention that is neither a connect-src destination nor a
  // recorded string is either a new dependency talking to something or a fetch someone added,
  // and both deserve a look before a policy is enforced against them.
  const unclassified = req.absoluteOrigins.filter((o) => !apiOrigins.includes(o) && !(o in classified));

  console.log('\n=== facade audit — what the BUILT bundle requires ===\n');
  console.log(`  inline scripts   : ${req.inlineScripts}${req.inlineScripts === 0 ? '  (no nonce or hash needed)' : ''}`);
  console.log(`  inline styles    : ${req.inlineStyles}`);
  console.log(`  external scripts : ${req.externalScripts.join(', ') || 'none'}`);
  console.log(`  stylesheets      : ${req.stylesheets.join(', ') || 'none'}`);
  console.log(`  blob: URLs       : ${req.usesBlob ? 'yes (capture)' : 'no'}`);
  console.log(`  service worker   : ${req.registersServiceWorker ? 'yes' : 'no'}`);
  console.log(`  dedicated Worker : ${req.usesDedicatedWorker ? 'yes' : 'no'}`);
  console.log(`  wasm             : ${req.usesWasm ? 'yes' : 'no'}`);
  console.log(`  WebSocket        : ${req.usesWebSocket ? 'yes' : 'no'}`);
  console.log(`  EventSource      : ${req.usesEventSource ? 'yes' : 'no'}`);
  console.log(`  eval/Function    : ${req.usesEval ? 'present in bundle text' : 'no'}`);
  console.log(`\n  absolute origins mentioned in the bundle:`);
  for (const o of req.absoluteOrigins) {
    const label = apiOrigins.includes(o) ? 'connect-src ' : o in classified ? 'string only ' : 'UNCLASSIFIED';
    console.log(`    ${label}  ${o}${classified[o] ? `  — ${classified[o]}` : ''}`);
  }
  if (unclassified.length) {
    problems.push(
      `unclassified origin(s) in the bundle: ${unclassified.join(', ')}. Either the app now fetches them ` +
        '(add to connect-src) or they are strings (record them in _originsMentionedButNeverFetched). ' +
        'Enforcing a policy against an origin nobody has looked at is enforcing blind.',
    );
  }
  for (const n of notes) console.log(`\n  note: ${n}`);

  if (problems.length) {
    console.error('\n✗ THE POLICY WOULD BREAK THE FACADE:\n' + problems.map((p) => `    · ${p}`).join('\n') + '\n');
    process.exit(1);
  }
  console.log('\n✓ every resource the built facade requires is admitted by the policy in config/security-headers.json\n');
}

// ---- deterministic snapshot for a real diff ---------------------------------------------------

function snapshot(label) {
  const req = requirements();
  const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const snap = {
    label,
    // The shell verbatim: the facade's title, meta, and mount point are what a survivor sees
    // before any script runs, and they must not change.
    indexHtml: html,
    // Content hashes rather than bytes: the asset names already carry a content hash, so this
    // catches a changed asset without storing megabytes.
    assets: Object.fromEntries(
      req.files.filter((f) => f !== 'version.json').map((f) => [f, sha(readFileSync(path.join(DIST, f)))]),
    ),
    requires: {
      inlineScripts: req.inlineScripts,
      inlineStyles: req.inlineStyles,
      externalScripts: req.externalScripts,
      stylesheets: req.stylesheets,
      usesBlob: req.usesBlob,
      registersServiceWorker: req.registersServiceWorker,
    },
  };
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify(snap, null, 2));
  console.log(`facade snapshot written to .facade/${label}.json  (${Object.keys(snap.assets).length} assets)`);
}

function diff(a, b) {
  const read = (l) => JSON.parse(readFileSync(path.join(OUT, `${l}.json`), 'utf8'));
  const x = read(a);
  const y = read(b);
  const problems = [];

  if (x.indexHtml !== y.indexHtml) {
    problems.push('index.html differs — the facade shell is not byte-identical');
  }
  const keys = [...new Set([...Object.keys(x.assets), ...Object.keys(y.assets)])].sort();
  for (const k of keys) {
    if (x.assets[k] !== y.assets[k]) {
      problems.push(`asset ${k}: ${x.assets[k] ?? '(absent)'} -> ${y.assets[k] ?? '(absent)'}`);
    }
  }
  if (JSON.stringify(x.requires) !== JSON.stringify(y.requires)) {
    problems.push('the facade\'s resource requirements changed');
  }

  console.log(`\n=== facade diff: ${a} -> ${b} ===\n`);
  if (problems.length === 0) {
    console.log('  ✓ BYTE-IDENTICAL — shell, every asset, and the resource requirements are unchanged\n');
    process.exit(0);
  }
  console.log(problems.map((p) => `  · ${p}`).join('\n'));
  console.log('\n  ✗ the facade changed. In Hidden mode that is a covert-mode failure, so this is a stop.\n');
  process.exit(1);
}

if (args.diff && args.diff !== 'true') {
  const [a, b] = args.diff.split(',');
  diff(a, b);
} else if (args.snapshot) {
  snapshot(args.label && args.label !== 'true' ? args.label : 'unlabelled');
} else {
  audit();
}
