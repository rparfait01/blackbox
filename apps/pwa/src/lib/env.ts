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
 * Zero-knowledge capture envelope (Brief 26) — **ARMED 2026-07-30**, operator decision.
 *
 * Encryption is the mechanism, and it is on. Even armed, the send path FAILS OPEN to a
 * plaintext upload rather than ever dropping a survivor's capture: arming can improve
 * confidentiality, it can never cost availability (see docs/brief26).
 *
 * WHY THE DEFAULT LIVES IN TRACKED CODE AND NOT IN `.env`.
 * `.env` and `.env.*` are gitignored, so a flag that lived there would be armed on the one
 * machine that set it and silently DISARMED in every fresh clone, CI build, and future
 * deploy — with no error, just quietly unencrypted captures. That is the same failure shape
 * as migration 0038, which silently un-armed every account. So the armed state is the
 * committed default and travels with the source; `VITE_ENVELOPE_ENC=false` is the explicit,
 * deliberate way back out.
 */
const ENVELOPE_DEFAULT = 'true';
export const envelopeEncryptionEnabled =
  (import.meta.env.VITE_ENVELOPE_ENC ?? ENVELOPE_DEFAULT) !== 'false';
