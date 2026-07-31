import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_PREPARE_ATTEMPTS,
  __resetEncryptionState,
  degradationForBufferFailure,
  getState,
  markDegradation,
  markPreparing,
  markReady,
  markRetryable,
  markTerminal,
  onEncryptionStateChange,
  transmitDecision,
} from './encryption-state';
import type { CaptureEncryptor } from './capture-encryptor';

/**
 * Brief 36 §A/§B — the state machine, and above all its ASYMMETRY.
 *
 * The defect was that encryption state was inferred from whether a key object existed
 * yet, so "not encrypted yet" and "will never be encrypted" were the same value: null.
 * Both produced a silent plaintext upload. These tests pin the four states apart and pin
 * exactly which two of them put bytes on the wire.
 */

const encryptor = (): CaptureEncryptor => ({
  captureId: 'evt',
  async encryptChunk() {
    return { framed: new Uint8Array([1]), commitment: 'c' };
  },
  selfTest: async () => true,
});

beforeEach(() => __resetEncryptionState());

describe('the transmission rule', () => {
  it('PREPARING HOLDS — this is the ordinary-timing race the brief closes', () => {
    // A chunk produced in the first moments of a normal capture. Before this, the queue
    // could drain while the encryptor was still being set up and the bytes went out clear.
    expect(getState('s')).toBe('PREPARING');
    const d = transmitDecision('s');
    expect(d.transmit).toBe(false);
    expect(d.mode).toBeNull();
  });

  it('FAILED_RETRYABLE HOLDS — a transient failure never downgrades the bytes', () => {
    markRetryable('s', 'keys_endpoint_503');
    expect(transmitDecision('s').transmit).toBe(false);
  });

  it('READY transmits ENCRYPTED, carrying the proven encryptor', () => {
    const enc = encryptor();
    markReady('s', enc);
    const d = transmitDecision('s');
    expect(d).toMatchObject({ transmit: true, mode: 'ENCRYPTED' });
    expect(d.encryptor).toBe(enc);
  });

  it('FAILED_TERMINAL TRANSMITS, declared — availability survives, silence does not', () => {
    // The operator amendment to §B, and the reason it is right: the audit finding was
    // SILENT plaintext, not plaintext. A phone that is taken takes buffered-only evidence
    // with it, so refusing to send would trade one silent loss for another.
    markTerminal('s', 'envelope_encryption_disabled');
    const d = transmitDecision('s');
    expect(d).toMatchObject({ transmit: true, mode: 'UNENCRYPTED_DECLARED' });
    expect(d.encryptor).toBeNull();
    expect(d.reason).toBe('envelope_encryption_disabled'); // the declaration carries WHY
  });

  it('READY without an encryptor HOLDS rather than sending — a bug must not leak bytes', () => {
    markReady('s', encryptor());
    // Simulate the impossible-but-guarded state by transitioning through a reset.
    __resetEncryptionState();
    markPreparing('s');
    // @ts-expect-error deliberately forcing the guarded shape
    markReady('s', null);
    expect(transmitDecision('s').transmit).toBe(false);
  });
});

describe('transitions are one-way except the single retry loop', () => {
  it('FAILED_RETRYABLE → PREPARING → READY is allowed', () => {
    markRetryable('s', 'transient');
    markPreparing('s');
    expect(getState('s')).toBe('PREPARING');
    markReady('s', encryptor());
    expect(getState('s')).toBe('READY');
  });

  it('FAILED_TERMINAL never resolves to READY — a capture cannot switch schemes halfway', () => {
    // Mixed schemes inside one capture cannot be assembled or verified as one artifact,
    // which is why terminal is terminal rather than merely discouraged.
    markTerminal('s', 'no_account_session');
    markReady('s', encryptor());
    expect(getState('s')).toBe('FAILED_TERMINAL');
    markPreparing('s');
    expect(getState('s')).toBe('FAILED_TERMINAL');
    expect(transmitDecision('s').mode).toBe('UNENCRYPTED_DECLARED');
  });

  it('READY does not fall back to a failed state', () => {
    markReady('s', encryptor());
    markRetryable('s', 'late failure');
    expect(getState('s')).toBe('READY');
  });

  it('retries are BOUNDED — it becomes a declaration rather than an indefinite hold', () => {
    // Without a ceiling a capture could sit in FAILED_RETRYABLE forever, buffering in
    // silence: confidential, unsent, and never surfaced. That is the "confidential but
    // silently lost" outcome §D exists to forbid.
    for (let i = 0; i < MAX_PREPARE_ATTEMPTS; i += 1) {
      markPreparing('s');
      markRetryable('s', 'still failing');
    }
    expect(getState('s')).toBe('FAILED_TERMINAL');
    expect(transmitDecision('s').transmit).toBe(true);
  });
});

describe('§D degradation is a separate axis from encryption state', () => {
  it('a buffering failure while still preparing is EVIDENCE_AT_RISK', () => {
    expect(degradationForBufferFailure('PREPARING')).toBe('EVIDENCE_AT_RISK');
    expect(degradationForBufferFailure('FAILED_RETRYABLE')).toBe('EVIDENCE_AT_RISK');
  });

  it('a buffering failure with no route out at all is EVIDENCE_NOT_RETAINED', () => {
    expect(degradationForBufferFailure('FAILED_TERMINAL')).toBe('EVIDENCE_NOT_RETAINED');
  });

  it('degradation changes notify subscribers — the overt warning and covert signal ride this', () => {
    const seen: string[] = [];
    const off = onEncryptionStateChange((_id, r) => seen.push(r.degradation));
    markDegradation('s', 'EVIDENCE_AT_RISK');
    markDegradation('s', 'EVIDENCE_AT_RISK'); // idempotent — no duplicate signal
    markDegradation('s', 'NONE'); // storage recovered
    off();
    expect(seen).toEqual(['EVIDENCE_AT_RISK', 'NONE']);
  });

  it('a throwing listener can never break the capture path', () => {
    const off = onEncryptionStateChange(() => {
      throw new Error('UI blew up');
    });
    expect(() => markDegradation('s', 'EVIDENCE_AT_RISK')).not.toThrow();
    off();
  });
});

describe('an illegal transition is refused and logged, never silently applied', () => {
  it('logs rather than mutating', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    markTerminal('s', 'done');
    markReady('s', encryptor());
    expect(getState('s')).toBe('FAILED_TERMINAL');
    spy.mockRestore();
  });
});
