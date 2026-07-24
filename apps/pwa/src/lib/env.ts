/**
 * Activation-hold duration — how long the user must press the breathing circle
 * for the covert activation trigger to fire.
 *
 * Production uses a deliberate ~1.8s press (Fix Brief 1 #1): long enough to be
 * intentional, short enough to feel responsive under stress, with a filling
 * progress ring as feedback. During development the hold is shortened to 1.5s
 * for easier testing. An explicit `VITE_REVEAL_HOLD_MS` env value overrides
 * either default. (The env var keeps its original name for config
 * compatibility, though the gesture now triggers activation rather than
 * revealing anything.)
 */
const PROD_HOLD_MS = 1800;
const DEV_HOLD_MS = 1500;

function resolveHoldMs(): number {
  const override = import.meta.env.VITE_REVEAL_HOLD_MS;
  if (override !== undefined && override !== '') {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return import.meta.env.DEV ? DEV_HOLD_MS : PROD_HOLD_MS;
}

export const ACTIVATION_HOLD_MS = resolveHoldMs();

/**
 * Backend Worker base URL. When unset, the upload pipeline is a silent no-op —
 * recording stays entirely local and the app behaves exactly as before (covert:
 * a missing/unreachable backend never changes anything on screen).
 */
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').trim();
export const uploadsEnabled = API_BASE_URL.length > 0;

/**
 * Zero-knowledge capture envelope (Brief 26). Default OFF: unless `VITE_ENVELOPE_ENC`
 * is exactly "true" at build time, the capture pipeline is byte-identical to today —
 * no encryption, no key generation, no change on any path. Arming this is a deliberate,
 * test-accounts-first step, and even when armed the send path FAILS OPEN to a plaintext
 * upload rather than ever dropping a survivor's capture (capture availability is
 * paramount; see docs/brief26).
 */
export const envelopeEncryptionEnabled = (import.meta.env.VITE_ENVELOPE_ENC ?? '') === 'true';
