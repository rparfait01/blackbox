import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(HERE, p), 'utf8');

/**
 * Brief 38 — the terminal marker, pinned at every point it could be lost again.
 *
 * THE DEFECT. `sendItem()` called `sealChunkForSend()` with a hardcoded `isFinal: false` on
 * every chunk. `X-Is-Final` was therefore never 1, every row got isFinal=0, and report
 * generation always answered `finalChunkPresent: false`. The schema column, the header, the
 * AAD field and the report field all existed — nothing ever produced the value.
 *
 * So every real capture appeared truncated, and a capture that ended normally was
 * indistinguishable from one whose tail was silently lost, by the exact mechanism built to
 * tell them apart. A single hardcoded literal disabled a documented admissibility property.
 * That is why these are source assertions: the value has to be PRODUCED somewhere, and a
 * regression would look like a plausible constant rather than an obvious break.
 */
describe('§A the marker is created where the chunk is produced', () => {
  const capture = read('./lib/capture/media-capture.ts');
  const activation = read('./lib/activation/index.ts');

  it('the capture layer decides, not the upload layer', () => {
    // Only the recorder knows which payload was flushed by stop(). The upload layer sees an
    // indistinguishable stream of blobs and could only ever guess.
    expect(capture).toMatch(/const isFinal = this\.stopping;/);
    expect(capture).toMatch(/this\.stopping = true;/);
  });

  it('a stop with no trailing payload still names a terminal chunk, with a reason', () => {
    expect(capture).toMatch(/onTerminalFallback\?\.\(this\.lastSequenceEmitted, 'no_trailing_payload'\)/);
    expect(activation).toMatch(/markQueuedChunkTerminal\(newSessionId, sequence, reason\)/);
  });

  it('the marker travels through PERSISTENCE, not just memory', () => {
    // A queue that survives a page termination must not lose which chunk was last, or a
    // capture that ended normally comes back looking truncated.
    expect(read('./lib/storage/types.ts')).toMatch(/isFinal\?: boolean;/);
    // \s+ rather than \n — this repo checks out CRLF, and a guard that only matches LF
    // would pass or fail on line endings rather than on the code.
    expect(read('./lib/upload/upload-manager.ts')).toMatch(/isFinal,\s+attempts: 0,/);
  });
});

describe('§B the marker is authenticated, and the hardcoded false is gone', () => {
  const manager = read('./lib/upload/upload-manager.ts');

  it('the seal receives the REAL flag — this is the defect, pinned', () => {
    expect(manager).toMatch(/isFinal: item\.isFinal === true,/);
    // The literal that disabled the whole property must never come back.
    expect(manager).not.toMatch(/sequence: item\.sequence \?\? 0,\s*\n\s*isFinal: false,/);
  });

  it('the AAD is what authenticates it — the header only routes', () => {
    // sealChunkForSend passes isFinal into encryptChunk, whose AAD binds
    // captureId ‖ chunkIndex ‖ finalFlag. A stripped or forged marker no longer matches the
    // AAD the chunk was sealed under, so it fails to decrypt at verification.
    const envelope = read('./lib/crypto/envelope.ts');
    expect(envelope).toMatch(/function makeAad\(captureId: string, chunkIndex: number, isFinal: boolean\)/);
    expect(envelope).toMatch(/tail\[5\] = isFinal \? 1 : 0;/);
  });

  it('a declared-plaintext chunk still carries its marker, unauthenticated', () => {
    // The capture DID end normally. Downgrading it to ABNORMAL because the envelope was
    // missing would be its own dishonesty.
    const at = manager.indexOf('UNENCRYPTED_DECLARED');
    expect(at).toBeGreaterThan(-1);
    const declaredBranch = manager.slice(Math.max(0, at - 500), at + 200);
    expect(declaredBranch).toMatch(/X-Is-Final/);
  });
});

describe('§C a terminal chunk never overtakes an earlier one', () => {
  it('the bulk lane holds a terminal chunk while earlier siblings are queued', () => {
    const manager = read('./lib/upload/upload-manager.ts');
    expect(manager).toMatch(/item\.isFinal === true && bulk\.some\(/);
  });
});
