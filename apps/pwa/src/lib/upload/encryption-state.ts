/**
 * Capture encryption state machine (Brief 36 §A) — the ONE owner of "may these bytes
 * leave the device, and in what condition".
 *
 * WHAT WENT WRONG BEFORE. `openEvent()` launched `prepareEncryptor(ctx)` WITHOUT awaiting
 * it and returned true. The queue could drain immediately, and until the key fetch, DEK
 * generation, wrapping and wrapped-key upload had all finished, `ctx.encryptor` was null
 * and the send path shipped the plaintext unchanged — silently. That was not an
 * exceptional path: it was a race on ordinary timing, so the early chunks of a normal
 * capture went out in the clear while the deployment was described as encryption-armed.
 * Encryption state was INFERRED from whether a key object happened to exist yet, which is
 * why nothing could tell "not encrypted yet" from "will never be encrypted".
 *
 * So the state is now explicit, and it is the thing the send path reads:
 *
 *   PREPARING         key setup in flight              → HOLD (buffer on device)
 *   READY             encryptor established AND PROVEN → transmit, encrypted
 *   FAILED_RETRYABLE  transient failure, retry booked  → HOLD (buffer on device)
 *   FAILED_TERMINAL   cannot encrypt this capture      → transmit, DECLARED unencrypted
 *
 * FAILED_TERMINAL TRANSMITS, AND THAT IS DELIBERATE (operator amendment to §B). The audit
 * finding was SILENT plaintext, not plaintext. Brief 26's rule — capture availability
 * outranks confidentiality — survives here intact: a survivor whose device cannot encrypt
 * still gets her evidence off the phone, because a phone that is taken takes buffered-only
 * evidence with it. What changes is that the condition is now declared: the server marks
 * the chunk `UNENCRYPTED_DECLARED` from its OWN observation, the survivor is told, and an
 * operator alert fires. Confidentiality is never traded away quietly.
 *
 * A MISSING KEY IS NEVER TERMINAL. The device can mint and publish a keypair on the spot,
 * so "this account has no public key" is a PREPARING sub-step, not a dead end. That
 * distinction is load-bearing: at the time this was written, zero production accounts had
 * an envelope public key, because provisioning only ever ran during onboarding and every
 * existing account predated it. Treating that as terminal would have made the common case
 * the failing one.
 *
 * Transitions are one-way except FAILED_RETRYABLE → PREPARING → READY. FAILED_TERMINAL is
 * terminal for the capture and never resolves to READY — a capture must not switch schemes
 * halfway through, or its chunks cannot be assembled or verified as one artifact.
 */

import { log } from '@/lib/log';
import type { CaptureEncryptor } from './capture-encryptor';

export type EncryptionState = 'PREPARING' | 'READY' | 'FAILED_RETRYABLE' | 'FAILED_TERMINAL';

/**
 * Safety degradation is a SEPARATE axis from encryption state (§D). Encryption state says
 * whether bytes can be protected; this says whether they are being retained at all.
 * Holding bytes on-device is only a safe answer while the device can actually store them —
 * without this distinction the policy silently becomes "confidential but lost", which is a
 * worse failure than plaintext.
 */
export type DegradationState = 'NONE' | 'EVIDENCE_AT_RISK' | 'EVIDENCE_NOT_RETAINED';

export interface CaptureEncryptionRecord {
  state: EncryptionState;
  degradation: DegradationState;
  /** Present only in READY. Never read directly by the send path — go through mayTransmit. */
  encryptor: CaptureEncryptor | null;
  /** Why we are in a failed state, for the report and the operator alert. */
  reason: string | null;
  attempts: number;
}

/** After this many failed preparation rounds the capture stops waiting and declares. Bounded
 *  so a capture cannot sit in FAILED_RETRYABLE forever, buffering silently and forever. */
export const MAX_PREPARE_ATTEMPTS = 3;

const records = new Map<string, CaptureEncryptionRecord>();
type Listener = (sessionId: string, record: CaptureEncryptionRecord) => void;
const listeners = new Set<Listener>();

function emit(sessionId: string, record: CaptureEncryptionRecord): void {
  for (const l of listeners) {
    try {
      l(sessionId, record);
    } catch {
      /* a UI listener must never break the capture path */
    }
  }
}

/** Subscribe to state changes — the overt warning and the covert signal both ride this. */
export function onEncryptionStateChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRecord(sessionId: string): CaptureEncryptionRecord {
  const existing = records.get(sessionId);
  if (existing) {
    return existing;
  }
  const fresh: CaptureEncryptionRecord = {
    state: 'PREPARING',
    degradation: 'NONE',
    encryptor: null,
    reason: null,
    attempts: 0,
  };
  records.set(sessionId, fresh);
  return fresh;
}

export function getState(sessionId: string): EncryptionState {
  return getRecord(sessionId).state;
}

/** Legal transitions. Everything else is refused and logged rather than silently applied —
 *  a state machine that accepts any transition is just a variable. */
function canTransition(from: EncryptionState, to: EncryptionState): boolean {
  if (from === to) return true;
  if (from === 'FAILED_TERMINAL') return false; // terminal, always
  switch (to) {
    case 'PREPARING':
      return from === 'FAILED_RETRYABLE'; // the ONE way back
    case 'READY':
      return from === 'PREPARING';
    case 'FAILED_RETRYABLE':
    case 'FAILED_TERMINAL':
      return from === 'PREPARING' || from === 'FAILED_RETRYABLE';
    default:
      return false;
  }
}

function set(sessionId: string, next: Partial<CaptureEncryptionRecord> & { state: EncryptionState }): void {
  const record = getRecord(sessionId);
  if (!canTransition(record.state, next.state)) {
    log.error(`illegal encryption transition ${record.state} → ${next.state}; ignored`);
    return;
  }
  Object.assign(record, next);
  emit(sessionId, record);
}

export function markPreparing(sessionId: string): void {
  const record = getRecord(sessionId);
  set(sessionId, { state: 'PREPARING', reason: null, attempts: record.attempts + 1 });
}

/**
 * Declare READY. The encryptor must already have been PROVEN by a round trip — a non-null
 * object is not proof, and "it exists" is exactly the inference this brief removed.
 */
export function markReady(sessionId: string, encryptor: CaptureEncryptor): void {
  set(sessionId, { state: 'READY', encryptor, reason: null });
}

export function markRetryable(sessionId: string, reason: string): void {
  const record = getRecord(sessionId);
  // Bounded: past the attempt ceiling this becomes a declaration rather than an
  // indefinite hold, so evidence is never withheld forever in silence.
  if (record.attempts >= MAX_PREPARE_ATTEMPTS) {
    markTerminal(sessionId, `${reason} (after ${record.attempts} attempts)`);
    return;
  }
  set(sessionId, { state: 'FAILED_RETRYABLE', encryptor: null, reason });
}

export function markTerminal(sessionId: string, reason: string): void {
  set(sessionId, { state: 'FAILED_TERMINAL', encryptor: null, reason });
}

/** Record that on-device buffering itself is failing (§D) — the state that turns "held
 *  safely" into "at risk", and the only one the survivor is ever told about. */
export function markDegradation(sessionId: string, degradation: DegradationState): void {
  const record = getRecord(sessionId);
  if (record.degradation === degradation) {
    return;
  }
  record.degradation = degradation;
  emit(sessionId, record);
}

/** The §D table, evaluated: what does a buffering failure mean in the current state? */
export function degradationForBufferFailure(state: EncryptionState): DegradationState {
  return state === 'FAILED_TERMINAL' ? 'EVIDENCE_NOT_RETAINED' : 'EVIDENCE_AT_RISK';
}

export interface TransmitDecision {
  /** May this chunk leave the device at all? */
  transmit: boolean;
  /** When transmitting: encrypted under the capture DEK, or declared unencrypted. */
  mode: 'ENCRYPTED' | 'UNENCRYPTED_DECLARED' | null;
  encryptor: CaptureEncryptor | null;
  reason: string | null;
}

/**
 * THE TRANSMISSION RULE (§B, as amended). The single question the send path asks.
 *
 * Only two states put bytes on the wire, and they are not the same event:
 *   READY            → ENCRYPTED
 *   FAILED_TERMINAL  → UNENCRYPTED_DECLARED (loud, marked, alerted — never silent)
 *
 * PREPARING and FAILED_RETRYABLE HOLD. That is the race this brief closes: a chunk
 * produced in the first moments of a capture now waits for the encryptor instead of
 * racing it to the network.
 */
export function transmitDecision(sessionId: string): TransmitDecision {
  const record = getRecord(sessionId);
  switch (record.state) {
    case 'READY':
      // Defensive: READY without an encryptor is a programming error, not a fallback.
      // Holding is the safe answer — the bytes stay on the device, nothing leaks.
      if (!record.encryptor) {
        log.error('READY with no encryptor — holding rather than sending');
        return { transmit: false, mode: null, encryptor: null, reason: 'ready_without_encryptor' };
      }
      return { transmit: true, mode: 'ENCRYPTED', encryptor: record.encryptor, reason: null };
    case 'FAILED_TERMINAL':
      return { transmit: true, mode: 'UNENCRYPTED_DECLARED', encryptor: null, reason: record.reason };
    default:
      return { transmit: false, mode: null, encryptor: null, reason: record.state };
  }
}

/** Drop a capture's record when its session ends. */
export function clearCapture(sessionId: string): void {
  records.delete(sessionId);
}

/** Test seam only — reset all state between cases. */
export function __resetEncryptionState(): void {
  records.clear();
}
