#!/usr/bin/env node
/**
 * SUPERSESSION_INDEX generator + corrections-block parser (Brief 34 §6, §7.3, §7.4).
 *
 * WHY THIS IS GENERATED AND NEVER HAND-MAINTAINED. The index answers "was Brief 12 §3 ever
 * touched?" in one lookup instead of a forward read through sixty-odd documents. An index
 * that is written by hand drifts from the corpus the first time someone is in a hurry, and a
 * drifted index is worse than none: it answers confidently and wrongly. So the corrections
 * blocks in the briefs are the source of truth, and this file is the only thing allowed to
 * write the index.
 *
 * IT IS ALSO THE PARSER THE GATE RUNS. A corrections block that does not parse fails the
 * push (§7.4). That is deliberate: §1.2 says silence is never implicit, so a brief from 035
 * forward that omits the block, or writes a delta instead of the full current reading, has to
 * be rejected mechanically rather than caught by whoever happens to read it next.
 *
 *   node scripts/supersession-index.mjs           generate SUPERSESSION_INDEX.md
 *   node scripts/supersession-index.mjs --check   parse only; non-zero on a malformed block
 *
 * Makes no network calls and touches nothing outside docs/ and the index file.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const INDEX = path.join(ROOT, 'SUPERSESSION_INDEX.md');

/**
 * The convention became mandatory at 035 (§1, §2). Earlier briefs were written before it
 * existed and are NOT rewritten (§7.6) — their history is carried by the seed ledger below
 * instead. So the parser only *enforces* from here.
 */
const CONVENTION_FROM = 35;

/** `BRIEF_035_FIX_DEPLOY_GATE.md` → 35. Returns null for anything not numbered that way. */
function briefNumber(filename) {
  const m = /^BRIEF_(\d{2,3})(?:_|\b)/.exec(filename);
  return m ? Number(m[1]) : null;
}

/**
 * Parse one brief's corrections block.
 *
 * Returns { ok, entries, problems }. A brief with `## CORRECTIONS — None.` (or a body whose
 * only content is "None") is VALID and yields no entries — §1.2 requires the block to be
 * present, not to be non-empty.
 */
export function parseCorrections(source, label) {
  const problems = [];
  const start = source.search(/^##\s+CORRECTIONS/m);
  if (start === -1) {
    return { ok: false, entries: [], problems: [`${label}: no "## CORRECTIONS" block (§1.2 — silence is never implicit)`] };
  }
  // The block runs to the next top-level heading or horizontal rule.
  const rest = source.slice(start);
  const endRel = rest.slice(1).search(/^(?:##\s|---\s*$)/m);
  const block = endRel === -1 ? rest : rest.slice(0, endRel + 1);

  if (/^##\s+CORRECTIONS\s*[—-]\s*None\.?\s*$/m.test(block) || /^\s*None\.?\s*$/m.test(block)) {
    return { ok: true, entries: [], problems };
  }

  const entries = [];
  // **BRIEF 036 §B — corrected to read:** followed by a quoted current reading, optionally
  // followed by `Path: \`...\``.
  const re = /\*\*BRIEF\s+(\d{1,3})\s+([^\n—]*?)\s*—\s*corrected to read:\*\*\s*\n+"([\s\S]*?)"\s*(?:\n\s*Path:\s*`([^`]+)`)?/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const [, num, section, reading, filePath] = m;
    const firstLine = reading.trim().split('\n')[0].trim();
    if (!firstLine) {
      problems.push(`${label}: BRIEF ${num} ${section} — empty current reading (§1.1)`);
      continue;
    }
    // §1.1 — the correction IS the current reading. A block that narrates the old text
    // ("previously", "used to say") is writing a delta, which §1.5 forbids because it forces
    // the reader backward.
    if (/\b(previously|used to (say|read)|was:|formerly)\b/i.test(reading)) {
      problems.push(`${label}: BRIEF ${num} ${section} — states prior text; corrections carry new text only (§1.1/§1.5)`);
    }
    entries.push({
      correctsBrief: Number(num),
      section: section.trim(),
      reading: reading.trim(),
      firstLine,
      path: filePath ?? null,
    });
  }

  if (entries.length === 0) {
    problems.push(`${label}: CORRECTIONS block present but no parseable entries and not marked "None" (§1.2)`);
  }
  return { ok: problems.length === 0, entries, problems };
}

/**
 * §3 and §5 of Brief 34, seeded verbatim as the pre-convention history. These are NOT
 * regenerated from documents — the briefs that made these changes predate the convention and
 * are deliberately not rewritten (§7.6). This table is how their history survives.
 */
const SEED = [
  ['—', 'Trigger', 'Trigger-unify', 'One triggerAlert() core. Mode is display-only. Triggering is instant — no gates.'],
  ['011', 'Dispatch', 'cascade_and_line', 'Sequential cascade, 10-second intervals, full chain under 60s. Coordinator claim halts it.'],
  ['009', 'Contact ceiling', 'later decision', 'Two — guardian plus one. (Confirm.)'],
  ['—', 'Armed state', 'current model', 'Not Armed without at least one confirmed contact. Text-based emergency fallback does not count.'],
  ['007', 'Coordinator claim', '007 (locked)', 'Explicit user interaction only. Never on passive GET or page load.'],
  ['0B', 'Closure', '0B (open)', 'Consent scales to engaged parties. NOT BUILT — dual-consent remains hardcoded to 2.'],
  ['012', 'Closure PIN', '012, then dual-consent', 'Legacy 4-digit server pin retired. Any document describing PIN-based closure is stale.'],
  ['017 §1', 'Check-in recipient', '019', 'User-designated contact. Not the guardian.'],
  ['014', 'Auth', 'passwordless rebuild', 'Passkey primary; magic-link disabled once a passkey exists. Signup never depends on outbound email.'],
  ['—', 'Live-alert lock', '020', 'Settings, sign-out and delete are blocked during an active alert, enforced server-side.'],
  ['021', 'Deploy currency', '035', 'Build IDs alone are insufficient — a build with no API origin passed. Corrected by 035.'],
  ['026', 'Encryption', '036', '"Armed" did not mean encrypted; plaintext fallback was reachable on ordinary timing.'],
  ['002 §C3', 'Vault retention', '040', 'Designed to retain 36 months. Write-once is NOT enforced by the repository.'],
  ['—', 'Anti-truncation', '038', 'Exports include integrity records and sequence. Not verified until 038 ships.'],
  ['002 §C2', 'Chain of custody', '037', 'Four-step design. Chain append was not concurrency-safe. Corrected by 037.'],
  ['—', 'Data custody', 'locked principle', 'The incident record belongs to the user. Never a BLACK BOX asset in any form.'],
];

function collect() {
  const files = readdirSync(DOCS).filter((f) => f.endsWith('.md'));
  const rows = [];
  const problems = [];
  const seenNumbers = new Map();

  for (const file of files.sort()) {
    const n = briefNumber(file);
    if (n == null) continue;
    if (seenNumbers.has(n)) {
      // Not fatal: the pre-34 corpus has genuine collisions (§4) that are Royce's to
      // adjudicate, and a duplicate FILE is a hygiene issue rather than a malformed block.
      // Recorded loudly in the index so it cannot be mistaken for resolved.
      problems.push(`DUPLICATE brief number ${n}: ${seenNumbers.get(n)} and ${file} (recorded, not fatal)`);
      // …but only ONE file per number is parsed, or a stray download copy makes the index
      // claim the same address was corrected twice — an index that invents corrections is
      // worse than none. A " (1)" suffix is the copy; anything else wins on first sight.
      const incumbent = seenNumbers.get(n);
      const incumbentIsCopy = / \(\d+\)\.md$/.test(incumbent);
      const thisIsCopy = / \(\d+\)\.md$/.test(file);
      if (!(incumbentIsCopy && !thisIsCopy)) {
        continue; // keep the incumbent, skip this one
      }
      seenNumbers.set(n, file); // incumbent was the copy; this one replaces it
      for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].byBrief === n) rows.splice(i, 1);
    } else {
      seenNumbers.set(n, file);
    }
    if (n < CONVENTION_FROM) continue;

    const parsed = parseCorrections(readFileSync(path.join(DOCS, file), 'utf8'), file);
    for (const p of parsed.problems) problems.push(p);
    for (const e of parsed.entries) rows.push({ ...e, byBrief: n, byFile: file });
  }
  return { rows, problems, seenNumbers };
}

function render(rows, problems) {
  // Newest-first, matching §1's reading order: a reader stops when the picture is complete.
  rows.sort((a, b) => b.byBrief - a.byBrief || a.correctsBrief - b.correctsBrief);
  const lines = [];
  lines.push('# SUPERSESSION INDEX');
  lines.push('');
  lines.push('**Generated — do not edit.** `node scripts/supersession-index.mjs`');
  lines.push('');
  lines.push(
    'Built from the `## CORRECTIONS` blocks in `docs/BRIEF_*.md` (Brief 34 §6). Sorted newest-first,',
    'matching the reading order in Brief 34 §1: read down until the picture is complete, then stop.',
  );
  lines.push('');
  lines.push('Answering "was Brief 12 §3 ever touched?" is one lookup here, never a forward read.');
  lines.push('');
  lines.push(`## Corrections (from Brief ${CONVENTION_FROM} forward)`);
  lines.push('');
  lines.push('| Corrected | By | Current reading (first line) | Path |');
  lines.push('|---|---|---|---|');
  for (const r of rows) {
    const addr = `Brief ${String(r.correctsBrief).padStart(3, '0')}${r.section ? ` ${r.section}` : ''}`;
    const reading = r.firstLine.replace(/\|/g, '\\|');
    lines.push(`| ${addr} | Brief ${String(r.byBrief).padStart(3, '0')} | ${reading} | ${r.path ? `\`${r.path}\`` : '—'} |`);
  }
  lines.push('');
  lines.push('## Pre-34 ledger (seeded from Brief 34 §3 and §5)');
  lines.push('');
  lines.push(
    'These predate the corrections convention. The briefs that made them are **not rewritten**',
    '(Brief 34 §7.6) — this table is how their history survives.',
  );
  lines.push('');
  lines.push('| Subject | Corrected | By | Current authoritative reading |');
  lines.push('|---|---|---|---|');
  for (const [corrected, subject, by, reading] of SEED) {
    lines.push(`| ${subject} | ${corrected} | ${by} | ${reading.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  if (problems.length > 0) {
    lines.push('## Corpus notes');
    lines.push('');
    lines.push('Recorded rather than silently tolerated. Collisions are Brief 34 §4 items and need adjudication.');
    lines.push('');
    for (const p of problems) lines.push(`- ${p}`);
    lines.push('');
  }
  return lines.join('\n');
}

const checkOnly = process.argv.includes('--check');
const { rows, problems } = collect();

// A malformed BLOCK fails the gate; a duplicate FILE is recorded and does not (see collect()).
const fatal = problems.filter((p) => !p.startsWith('DUPLICATE'));
if (fatal.length > 0) {
  console.error('✗ corrections blocks failed to parse:\n');
  for (const p of fatal) console.error(`  - ${p}`);
  console.error('\nBrief 34 §1.2: a brief that supersedes nothing writes "## CORRECTIONS — None."');
  console.error('A missing or malformed block is a defect, and the brief is rejected.');
  process.exit(1);
}

if (checkOnly) {
  console.log(`✓ corrections blocks parse (${rows.length} corrections across briefs ${CONVENTION_FROM}+)`);
  for (const p of problems) console.log(`  note: ${p}`);
  process.exit(0);
}

writeFileSync(INDEX, render(rows, problems) + '\n');
console.log(`✓ SUPERSESSION_INDEX.md written — ${rows.length} corrections, ${SEED.length} seeded ledger rows`);
for (const p of problems) console.log(`  note: ${p}`);
