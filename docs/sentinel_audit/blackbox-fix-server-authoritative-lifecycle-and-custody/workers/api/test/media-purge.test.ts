/**
 * Brief 32 follow-up — the orphaned-capture purge, and the two guards that make it safe.
 *
 * The failure this exists to prevent already happened once: a lifecycle rule expiring all
 * prefixes would have deleted NEW captures, suspending a safety guarantee in order to
 * clean up junk. These pin the properties that make the replacement incapable of that:
 *
 *   1. an object uploaded at/after the invocation cutoff is NEVER deleted;
 *   2. an object still referenced by chunks_index is NEVER deleted, at any age;
 *   3. nothing is deleted at all unless `confirm` is explicitly true.
 */
import { describe, expect, it, vi } from 'vitest';

import { purgeOrphanedMedia } from '../src/lib/media-purge';
import type { Env } from '../src/types';

interface FakeObject {
  key: string;
  uploaded: Date;
}

function fakeEnv(objects: FakeObject[], referenced: string[] = []) {
  const deleted: string[][] = [];
  const env = {
    DB: {
      prepare: () => ({
        all: async () => ({ results: referenced.map((r2Key) => ({ r2Key })) }),
        bind: () => ({ all: async () => ({ results: referenced.map((r2Key) => ({ r2Key })) }) }),
      }),
    },
    MEDIA: {
      // One page; enough to exercise filtering. Pagination is exercised separately.
      list: vi.fn(async () => ({ objects, truncated: false, cursor: undefined })),
      delete: vi.fn(async (keys: string[]) => {
        deleted.push(keys);
      }),
    },
  } as unknown as Env;
  return { env, deleted, media: (env as unknown as { MEDIA: { delete: ReturnType<typeof vi.fn> } }).MEDIA };
}

const NOW = Date.UTC(2026, 6, 26, 12, 0, 0);
const old = (mins: number) => new Date(NOW - mins * 60_000);

describe('GUARD 1 — an object created after invocation is never deleted', () => {
  it('excludes objects uploaded at or after the cutoff', async () => {
    const { env, deleted } = fakeEnv([
      { key: 'events/a/chunks/0.webm', uploaded: old(60) }, // old residue
      { key: 'events/b/chunks/0.webm', uploaded: new Date(NOW) }, // EXACTLY at cutoff
      { key: 'events/c/chunks/0.webm', uploaded: new Date(NOW + 5_000) }, // written mid-run
    ]);
    const r = await purgeOrphanedMedia(env, { confirm: true, now: NOW });

    expect(r.skippedTooNew).toBe(2);
    expect(r.deleted).toBe(1);
    expect(deleted.flat()).toEqual(['events/a/chunks/0.webm']);
    // The boundary is >=, not >: an object uploaded in the same millisecond as the
    // cutoff is treated as new. Ties go to keeping the capture.
    expect(deleted.flat()).not.toContain('events/b/chunks/0.webm');
  });

  it('a capture written DURING a long paging run still survives', async () => {
    // The exact scenario a naive "delete what list() returns" would lose.
    const { env, deleted } = fakeEnv([
      { key: 'events/old/chunks/0.webm', uploaded: old(1440) },
      { key: 'events/live/chunks/0.webm', uploaded: new Date(NOW + 120_000) },
    ]);
    const r = await purgeOrphanedMedia(env, { confirm: true, now: NOW });
    expect(deleted.flat()).toEqual(['events/old/chunks/0.webm']);
    expect(r.skippedTooNew).toBe(1);
  });
});

describe('GUARD 2 — an object D1 still references is never deleted', () => {
  it('keeps a referenced object however old it is', async () => {
    const { env, deleted } = fakeEnv(
      [
        { key: 'events/live/chunks/0.webm', uploaded: old(100_000) }, // ancient but LIVE
        { key: 'events/dead/chunks/0.webm', uploaded: old(100_000) }, // ancient, orphaned
      ],
      ['events/live/chunks/0.webm'],
    );
    const r = await purgeOrphanedMedia(env, { confirm: true, now: NOW });

    expect(r.skippedReferenced).toBe(1);
    expect(deleted.flat()).toEqual(['events/dead/chunks/0.webm']);
  });

  it('purges nothing at all when every object is still referenced', async () => {
    const { env, deleted } = fakeEnv(
      [
        { key: 'events/a/chunks/0.webm', uploaded: old(5000) },
        { key: 'events/b/chunks/0.webm', uploaded: old(5000) },
      ],
      ['events/a/chunks/0.webm', 'events/b/chunks/0.webm'],
    );
    const r = await purgeOrphanedMedia(env, { confirm: true, now: NOW });
    expect(r.deleted).toBe(0);
    expect(deleted).toEqual([]);
  });
});

describe('it will not delete without an explicit confirm', () => {
  it('dry-runs by default, reporting what WOULD go without touching a byte', async () => {
    const { env, deleted, media } = fakeEnv([
      { key: 'events/a/chunks/0.webm', uploaded: old(60) },
      { key: 'events/b/chunks/0.webm', uploaded: old(60) },
    ]);
    const r = await purgeOrphanedMedia(env, { confirm: false, now: NOW });

    expect(r.dryRun).toBe(true);
    expect(r.eligible).toBe(2);
    expect(r.deleted).toBe(0);
    expect(media.delete).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it('an empty or malformed body is a dry run, never a mass delete', async () => {
    const { env, media } = fakeEnv([{ key: 'events/a/chunks/0.webm', uploaded: old(60) }]);
    const r = await purgeOrphanedMedia(env, { confirm: undefined as unknown as boolean, now: NOW });
    expect(r.dryRun).toBe(true);
    expect(media.delete).not.toHaveBeenCalled();
  });
});

describe('it leaves no standing rule and reports honestly', () => {
  it('reports the cutoff it used, so the operator can verify the boundary', async () => {
    const { env } = fakeEnv([]);
    const r = await purgeOrphanedMedia(env, { confirm: true, now: NOW });
    expect(r.cutoff).toBe(NOW);
    expect(r.done).toBe(true);
    expect(r.scanned).toBe(0);
  });

  it('is idempotent — a second run over the same live objects deletes nothing', async () => {
    const objs = [{ key: 'events/live/chunks/0.webm', uploaded: old(10) }];
    const first = await purgeOrphanedMedia(fakeEnv(objs, ['events/live/chunks/0.webm']).env, {
      confirm: true,
      now: NOW,
    });
    const second = await purgeOrphanedMedia(fakeEnv(objs, ['events/live/chunks/0.webm']).env, {
      confirm: true,
      now: NOW,
    });
    expect(first.deleted).toBe(0);
    expect(second.deleted).toBe(0);
  });
});
