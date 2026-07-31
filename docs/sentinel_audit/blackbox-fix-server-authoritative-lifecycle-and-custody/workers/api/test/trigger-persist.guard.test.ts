import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * HONEST STATUS AT THE TRIGGER WRITE: a 201 must mean the event PERSISTED.
 *
 * The failure being guarded against is the worst kind this product can have — a phone
 * showing "ALERT ACTIVE · RECORDING" over an event that does not exist. Everything
 * downstream inherits that lie: nothing to close (the closure deadlock), nothing to
 * dispatch from, nothing to review afterwards.
 *
 * The rule is narrow and absolute: POST /v1/events may return 201 for exactly two
 * reasons — it inserted a row, or it re-read an EXISTING row from D1 and is resuming it.
 * A failed persist must surface as an error. There is no third path, and no catch may
 * invent success.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(HERE, '..', 'src', 'index.ts'), 'utf8');
/** The POST /v1/events handler ONLY — bounded to the next top-level route declaration,
 *  so the assertions below cannot accidentally range over the rest of the worker. */
const handlerStart = index.indexOf("app.post('/v1/events'");
const handler = index.slice(handlerStart, index.indexOf('\napp.', handlerStart + 10));

describe('a failed insert is never reported as success', () => {
  it('the insert catch RE-THROWS when there is no verified existing event', () => {
    const block = handler.slice(handler.indexOf('} catch (error) {'), handler.indexOf('// Seed the first location'));
    expect(block).toMatch(/throw error;/);
    // It may only short-circuit via resolveSingleActive — a fresh D1 READ, not a guess.
    expect(block).toMatch(/const raced = await resolveSingleActive\(/);
    expect(block).toMatch(/if \(raced\) \{[\s\S]{0,160}return resumeResponse\(/);
  });

  it('the catch never fabricates a 201 of its own', () => {
    const block = handler.slice(handler.indexOf('} catch (error) {'), handler.indexOf('// Seed the first location'));
    // Any c.json(..., 201) inside the catch would be success invented from a failure.
    expect(block).not.toMatch(/c\.json\([\s\S]*201/);
  });

  it('the error reaches the client as a failure, not a silent swallow', () => {
    // onError is the only exit for a thrown insert, and it is a 500 — the client cannot
    // mistake it for a created event.
    expect(index).toMatch(/app\.onError\(\(error, c\) => \{[\s\S]{0,240}c\.json\(\{ error: 'internal' \}, 500\)/);
  });

  it('resumeResponse only ever describes a row that was READ from the database', () => {
    const fn = index.slice(index.indexOf('async function resumeResponse'), index.indexOf("app.post('/v1/events'"));
    // It echoes fields off `existing`, which resolveSingleActive selected from D1.
    expect(fn).toMatch(/eventId: existing\.id/);
    expect(fn).toMatch(/hmacSecret: existing\.hmacSecret/);
    // It must not mint a new id/secret and present it as an existing event.
    expect(fn).not.toMatch(/crypto\.randomUUID\(\)|randomHex\(/);
  });

  it('the success 201 is returned AFTER the insert, never before it', () => {
    const insertAt = handler.indexOf('INSERT INTO events');
    const successAt = handler.lastIndexOf('return c.json({ eventId, hmacSecret, createdAt }, 201)');
    expect(insertAt).toBeGreaterThan(-1);
    expect(successAt).toBeGreaterThan(insertAt);
  });

  it('nothing between the insert and the 201 can swallow a persist failure', () => {
    // A try/catch wrapped around the INSERT that did not re-throw would be the bug; the
    // only catch in the handler is the race path asserted above.
    const catches = handler.match(/catch\s*\(/g) ?? [];
    // Exactly two: the body-parse `.catch(() => ({}))` and the insert race catch.
    expect(catches.length).toBeLessThanOrEqual(2);
  });
});
