import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ITEM B — the life-safety upload lane, pinned structurally.
 *
 * Measured on prod before this fix: events of 67 s and 108 s carried ZERO classifications
 * and ZERO transcripts to the server, while the on-device classifier had produced roughly
 * twenty of each. Megabyte video chunks were standing in front of 300-byte life-safety
 * messages in a single-file queue, and a failed chunk's 30-second backoff also captured the
 * scheduler. A coordinator who cannot see the situation cannot act on it.
 *
 * These assertions exist because the failure was invisible: everything "worked", uploads
 * retried politely, and the summary was simply empty.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const MANAGER = readFileSync(join(SRC, 'lib', 'upload', 'upload-manager.ts'), 'utf8');

/** The body of drainQueue, where lane order is decided. */
function drainBody(): string {
  const at = MANAGER.indexOf('async function drainQueue');
  expect(at, 'drainQueue must exist').toBeGreaterThan(-1);
  return MANAGER.slice(at);
}

describe('B [A] two lanes, life-safety first', () => {
  it('BULK is exactly one kind — anything new defaults to the urgent lane', () => {
    expect(MANAGER).toMatch(/function isBulk\(item: UploadQueueItem\): boolean \{\s*return item\.kind === 'chunk';/);
  });

  it('the signal lane is drained BEFORE the bulk lane', () => {
    const body = drainBody();
    const signalAt = body.indexOf('!isBulk(i)');
    const bulkAt = body.indexOf('items.filter(isBulk)');
    expect(signalAt, 'signal lane must exist').toBeGreaterThan(-1);
    expect(bulkAt, 'bulk lane must exist').toBeGreaterThan(-1);
    expect(signalAt, 'signal must be drained first').toBeLessThan(bulkAt);
  });

  it('a signal failure skips that item — it never ends the lane', () => {
    const body = drainBody();
    const lane = body.slice(body.indexOf('!isBulk(i)'), body.indexOf('items.filter(isBulk)'));
    // `continue`/no-op on failure, and NO `break` or `return` anywhere in the signal lane.
    expect(lane).not.toMatch(/\bbreak\b|\breturn\b/);
  });

  it('the bulk lane STOPS at the first failure, so chunk sequence stays contiguous', () => {
    const body = drainBody();
    const lane = body.slice(body.indexOf('items.filter(isBulk)'));
    const laneEnd = lane.indexOf('const remaining');
    const bulkLoop = lane.slice(0, laneEnd);
    // Two breaks: one for a not-yet-due chunk, one for a failed chunk. Never a `continue`,
    // which would let a later chunk overtake an earlier one.
    expect((bulkLoop.match(/\bbreak;/g) ?? []).length).toBe(2);
    expect(bulkLoop).not.toMatch(/\bcontinue;/);
  });

  it('bulk is sorted by sequence — the contiguity guarantee is stated, not inherited', () => {
    expect(MANAGER).toMatch(/\.sort\(\(a, b\) => \(a\.sequence \?\? 0\) - \(b\.sequence \?\? 0\)\)/);
  });

  it('stopping a LANE never ends the PASS — no bare return inside the drain body', () => {
    const body = drainBody();
    const upToFinally = body.slice(0, body.indexOf('} finally {'));
    // The only early return is the single-flight/offline guard at the very top.
    const guards = upToFinally.slice(0, upToFinally.indexOf('draining = true;'));
    const afterGuards = upToFinally.slice(upToFinally.indexOf('draining = true;'));
    expect(guards).toMatch(/return;/);
    expect(afterGuards, 'the pass must run both lanes to completion').not.toMatch(/\n\s*return;/);
  });
});

describe('B [A] a bulk backoff cannot capture the scheduler', () => {
  it('an earlier wake-up preempts a later one', () => {
    // The old `if (drainScheduled) return` dropped every later request, so a 30 s chunk
    // backoff blacked out the signal lane for 30 s regardless of lane order.
    expect(MANAGER).not.toMatch(/if \(drainScheduled\) \{/);
    expect(MANAGER).toMatch(/if \(dueAt >= drainDueAt\) \{\s*return;/);
    expect(MANAGER).toMatch(/window\.clearTimeout\(drainTimer\)/);
  });

  it('the follow-up never sleeps longer than the soonest lane wants', () => {
    expect(MANAGER).toMatch(/scheduleDrain\(Math\.min\(2000, idle\)\)/);
  });
});

describe('B [A] nothing is dropped, and capture is untouched', () => {
  it('an item leaves the queue ONLY on success', () => {
    const send = MANAGER.slice(MANAGER.indexOf('async function trySend'), MANAGER.indexOf('async function drainQueue'));
    // The single delete sits on the success path, after the throw-on-failure check.
    expect((send.match(/deleteQueuedUpload/g) ?? []).length).toBe(1);
    expect(send.indexOf("throw new Error('upload failed')")).toBeLessThan(send.indexOf('deleteQueuedUpload'));
    // Failure books a backoff and reports it; the failure branch never discards.
    expect(send).toMatch(/item\.nextAttemptAt = Date\.now\(\) \+ backoff\(item\.attempts\)/);
    const failureBranch = send.slice(send.indexOf('} catch (error) {'));
    expect(failureBranch, 'a failed item must stay queued').not.toMatch(/deleteQueuedUpload/);
  });

  it('trySend never throws — the caller decides what a failure means for its lane', () => {
    const send = MANAGER.slice(MANAGER.indexOf('async function trySend'), MANAGER.indexOf('async function drainQueue'));
    expect(send).toMatch(/return false;/);
    // Persisting the backoff is itself guarded, so a storage error cannot escape.
    expect(send).toMatch(/catch \(persistError\)/);
  });

  it('single-flight is retained: this changes ORDER, not concurrency', () => {
    expect(MANAGER).toMatch(/if \(draining\) \{\s*return;/);
    expect(MANAGER).toMatch(/draining = true;/);
    expect(MANAGER).toMatch(/draining = false;/);
  });

  it('offline behaviour is unchanged', () => {
    expect(MANAGER).toMatch(/if \(!navigator\.onLine\) \{\s*scheduleDrain\(5000\);\s*return;/);
  });

  it('B touches no capture, trigger, closure, or classifier code', () => {
    for (const f of [
      './lib/capture/media-capture.ts',
      './lib/capture/config.ts',
      './lib/activation/index.ts',
      './lib/closure/index.ts',
    ]) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src, `${f} must not know about upload lanes`).not.toMatch(/isBulk|drainDueAt|SIGNAL_KIND/);
    }
  });
});
