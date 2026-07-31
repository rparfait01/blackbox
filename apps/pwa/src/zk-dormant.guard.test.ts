import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { envelopeEncryptionEnabled } from '@/lib/env';

/**
 * Brief 26 — fail-open guard for the capture path. The envelope is now WIRED into the
 * upload send path (step 3), so the invariant is no longer "not imported" but
 * "encryption can never break or block a capture." These pin that structurally:
 *   - the flag is ARMED (and arming still cannot break a capture);
 *   - the media recorder is still untouched (encryption lives in the upload layer);
 *   - the send path goes through sealChunkForSend (plaintext-by-default) and never calls
 *     the raw encrypt primitive directly;
 *   - encryptor setup is fire-and-forget, never awaited on the open/send path.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');
const uploadMgr = read('./lib/upload/upload-manager.ts');
const sealer = read('./lib/upload/capture-encryptor.ts');

describe('the envelope flag is ARMED', () => {
  it('is on by default, so no build can silently ship unencrypted captures', () => {
    // Armed 2026-07-30. The default lives in tracked code precisely so a fresh clone or CI
    // build cannot quietly disarm custody; `VITE_ENVELOPE_ENC=false` is the explicit way out.
    expect(envelopeEncryptionEnabled).toBe(true);
  });

  it('is still a real switch — the opt-out is a single explicit value', () => {
    const env = read('./lib/env.ts');
    expect(env).toMatch(/const ENVELOPE_DEFAULT = 'true';/);
    expect(env).toMatch(/!== 'false'/);
  });
});

describe('the media recorder is untouched — encryption is in the upload layer only', () => {
  it('media-capture does not import the crypto core', () => {
    expect(read('./lib/capture/media-capture.ts')).not.toMatch(/crypto\/envelope|encryptChunk/);
  });
});

describe('the send path is fail-open by construction', () => {
  it('chunk sending goes through sealChunkForSend, not a raw encryptChunk call', () => {
    expect(uploadMgr).toMatch(/sealChunkForSend\(/);
    // The send path must not call the raw AEAD directly — only via the fail-open wrapper.
    const sendItem = uploadMgr.slice(uploadMgr.indexOf('async function sendItem'), uploadMgr.indexOf('async function drainQueue'));
    expect(sendItem).not.toMatch(/\bencryptChunk\(/);
  });

  it('Brief 36 §B — there is NO plaintext default left in the sealer', () => {
    // This assertion is the inverse of the one it replaces. The old contract was "the body
    // STARTS as the plaintext and is only replaced with ciphertext on success", which made
    // every failure mode — no key, not ready yet, throw, hang — a silent clear-text upload.
    // The sealer now throws instead, and the bytes stay queued on the device.
    expect(sealer).not.toMatch(/plaintextResult/);
    expect(sealer).toMatch(/refusing to send plaintext/);
    // Whether a chunk may leave at all is decided by the state machine, not by the sealer.
    expect(uploadMgr).toMatch(/transmitDecision\(item\.sessionId\)/);
    expect(uploadMgr).toMatch(/if \(!decision\.transmit\)/);
  });

  it('§C encryption setup is fire-and-forget — never awaited on the open path', () => {
    // Unchanged and load-bearing: the alert path must never wait on encryption. Event
    // creation and the cascade have already happened server-side by the time this runs.
    expect(uploadMgr).toMatch(/void prepareEncryption\(ctx\)/);
    expect(uploadMgr).not.toMatch(/await prepareEncryption\(/);
  });

  it('the seal is time-bounded so a hung crypto call cannot wedge the send', () => {
    expect(sealer).toMatch(/withTimeout\(/);
    expect(sealer).toMatch(/ENCRYPT_TIMEOUT_MS/);
  });
});
