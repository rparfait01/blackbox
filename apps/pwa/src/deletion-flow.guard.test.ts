import { describe, expect, it } from 'vitest';

import { code } from '../../../test-utils/guard-source.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
const FLOW = code(join(SRC, 'routes', 'settings', 'DeleteRecordings.tsx')) as string;
const PURGE = code(join(SRC, 'lib', 'review', 'purge.ts')) as string;
const SETTINGS = code(join(SRC, 'routes', 'settings', 'Settings.tsx')) as string;

/**
 * BRIEF 56 §B — THE SHAPE OF THE DELETION FLOW.
 *
 * ═══ WHY THESE ARE GUARDED AND NOT LEFT TO REVIEW ════════════════════════════════════════════
 *
 * Every property below is one that a well-meaning later edit removes. "Add a select-all, users
 * keep asking for it." "Make them type DELETE, it is safer." "Add a second are-you-sure." Each is
 * a normal product instinct and each one converts a decision that is HERS into a machine
 * demanding she prove herself — on the one screen in the app where she has least to prove.
 *
 * The friction is calibrated, not maximal, and calibration is exactly the thing that erodes
 * silently. So it is pinned.
 */
describe('§B1 — friction is clarity, never obstruction', () => {
  it('the subject exists — this guard names what it reads', () => {
    expect(FLOW.length, 'DeleteRecordings.tsx read as empty').toBeGreaterThan(500);
    expect(FLOW).toMatch(/export function DeleteRecordings/);
  });

  it('there is NO typed-word confirmation', () => {
    // "Type DELETE to continue" is the canonical way software makes a person perform their own
    // certainty. She is not the risk here.
    expect(FLOW).not.toMatch(/type\s+["'`]?DELETE/i);
    expect(FLOW, 'a free-text confirmation input appeared').not.toMatch(/type="text"/);
  });

  it('there is NO cooling-off period, delay, or scheduled deletion', () => {
    expect(FLOW).not.toMatch(/setTimeout|cooling|cool-off|grace period|scheduled/i);
  });

  it('the facts are stated ONCE, in their own block', () => {
    // Repetition is how an interface argues. One statement, at the start.
    expect(FLOW).toMatch(/function WhatThisMeans/);
    const occurrences = (FLOW.match(/<WhatThisMeans \/>/g) ?? []).length;
    expect(occurrences, 'the warning is rendered more than once').toBe(1);
  });

  it('§B3 — it says what survives, and frames it as protection', () => {
    // JSX wraps prose across source lines, so these match on flexible whitespace rather than
    // on the exact line breaks Prettier happens to choose today.
    expect(FLOW).toMatch(/The recordings are gone/);
    expect(FLOW).toMatch(/signed record that they existed\s+stays/);
    expect(FLOW).toMatch(/nobody can claim\s+they never did/);
  });
});

describe('§B2 — selection is explicit at every step', () => {
  it('THREE steps, in order', () => {
    expect(FLOW).toMatch(/type Step = 'select' \| 'confirm' \| 'final'/);
  });

  it('there is NO select-all control', () => {
    // One mis-tap away from destroying everything, on the one screen where a mis-tap cannot be
    // undone. The absence is the feature.
    expect(FLOW).not.toMatch(/select[- ]?all/i);
    expect(FLOW, 'a bulk-select handler appeared').not.toMatch(/setSelected\(new Set\((?!\))/);
  });

  it('every selected entry is individually removable AT the confirm step', () => {
    // Changing her mind about one of twelve must not mean starting over.
    const confirm = FLOW.slice(FLOW.indexOf("step === 'confirm'"), FLOW.indexOf("step === 'final'"));
    expect(confirm).toMatch(/Keep this one/);
    expect(confirm).toMatch(/onClick=\{\(\) => toggle\(e\.eventId\)\}/);
  });

  it('the specific records are named at every step, never only a count', () => {
    // "Delete 12 recordings" without showing which twelve is the shape the brief forbids.
    const named = (FLOW.match(/formatEvidenceLabel\(/g) ?? []).length;
    expect(named, 'entries are not labelled by date and time on every list').toBeGreaterThanOrEqual(2);
    expect(FLOW).toMatch(/These recordings will be permanently deleted/);
    expect(FLOW).toMatch(/Any changes before this is permanent\?/);
  });
});

describe('§B4 — the entry survives its own deletion', () => {
  it('already-purged entries stay in the list, marked', () => {
    // Removing the row would erase her own record that something happened — a second deletion
    // she never asked for.
    expect(FLOW).toMatch(/Already deleted/);
    expect(FLOW).toMatch(/e\.capturePurged/);
    expect(FLOW).toMatch(/recordings deleted/);
  });

  it('nothing is notified to anyone — the specified DEFAULT, and no dead toggle', () => {
    // The optional notification is not built. A checkbox that reaches no dispatcher would be a
    // control that reads as functional and is not, which is the defect class this brief series
    // exists to remove.
    expect(FLOW).toMatch(/nobody will be told/);
    expect(FLOW, 'a notify toggle exists — it must reach a dispatcher or not exist').not.toMatch(
      /notifyContact/,
    );
  });
});

describe('§B5/§B6 — refusal is honest, bulk is batched', () => {
  it('a refusal states its reason and never no-ops silently', () => {
    expect(PURGE).toMatch(/export function purgeRefusalText/);
    expect(PURGE).toMatch(/locked_during_active_alert/);
    // The active-alert refusal explains WHY the protection exists rather than reading as a fault.
    expect(PURGE).toMatch(/protection exists so nobody can destroy your evidence during an incident/);
  });

  it('a refusal is not reported as a network failure', () => {
    // The server answers 403/404/409 with a named reason, so `res.ok` is false for both "you may
    // not" and "it never arrived". Reading ok first collapses them.
    const errFirst = PURGE.indexOf('res.data?.error');
    const okCheck = PURGE.indexOf('!res.ok');
    expect(errFirst).toBeGreaterThan(-1);
    expect(errFirst, 'the ok check runs first, so refusals read as network failures').toBeLessThan(okCheck);
  });

  it('the confirm flag is sent as a VALUE, not as pre-stringified JSON', () => {
    // `api` serialises the body itself. A pre-stringified object arrives as a JSON string, the
    // server reads `confirm` as undefined, and a DELETE silently becomes a dry run.
    expect(PURGE).toMatch(/body: \{ confirm \}/);
    expect(PURGE).not.toMatch(/body: JSON\.stringify/);
  });

  it('§B6.3 — bulk deletion is bounded and reports progress', () => {
    expect(PURGE).toMatch(/export const PURGE_CONCURRENCY/);
    expect(PURGE).toMatch(/onProgress\(done, eventIds\.length, outcome\)/);
    expect(FLOW, 'the UI never shows a live count').toMatch(/progress\?\.done/);
  });

  it('one failure never stops the rest', () => {
    // Each event is independent; a refusal on one is recorded and the others proceed.
    expect(PURGE).toMatch(/\.catch\(/);
    expect(PURGE).toMatch(/outcomes\.push\(outcome\)/);
  });
});

describe('availability of destruction is not behind a feature flag', () => {
  it('the deletion entry is NOT gated on envelope encryption', () => {
    // Review needs the envelope key to open the bytes; deleting them does not. Gating deletion
    // would mean telling a survivor who needs recordings off her phone to come back later.
    const buttonAt = SETTINGS.indexOf('setDeleteOpen(true)');
    const flagAt = SETTINGS.indexOf('envelopeEncryptionEnabled ? (');
    expect(buttonAt, 'the delete entry point is missing from Settings').toBeGreaterThan(-1);
    expect(flagAt, 'the review flag ternary moved — this guard is asserting over nothing').toBeGreaterThan(-1);
    // The delete button sits AFTER the flag ternary's else branch closes, so it is reachable
    // whether or not envelope encryption is on. If someone moves it inside the true branch, the
    // NotYet fallback no longer sits between them and this fails.
    expect(
      SETTINGS.slice(flagAt, buttonAt),
      'the delete entry moved inside the encryption-flag branch',
    ).toMatch(/NotYet/);
  });
});
