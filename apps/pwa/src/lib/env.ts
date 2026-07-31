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
 * Backend Worker base URL — Brief 35 §A.
 *
 * WHAT THIS USED TO BE, AND WHY IT WAS THE WORST BUG IN THE PRODUCT. This read
 * `(import.meta.env.VITE_API_BASE_URL ?? '').trim()`, so a build with the variable
 * absent got an empty origin and `uploadsEnabled === false`. Every consequence of
 * that was SILENT: activation still started local capture, the UI still showed an
 * active alert, and `registerUploadSession()`, the heartbeat, closure monitoring and
 * every upload returned early. No event created. No contact notified. No evidence off
 * the device. `.env*` is gitignored and no tracked `apps/pwa/.env` exists, so any
 * clean machine or CI runner produced exactly that build — and the deploy reported
 * green, because build ids matched.
 *
 * A production build with no API origin is not a degraded build. It is a build in
 * which the alert path does not exist. So there is no fallback here any more:
 *
 *   - PRODUCTION — the build itself fails (vite.config.ts refuses to compile without
 *     a valid HTTPS, routable origin). This module then re-states the same rule at
 *     runtime, so an artifact produced by some other route still fails LOUDLY rather
 *     than pretending to work. Unreachable in practice; that is the point of a guard.
 *   - DEVELOPMENT — permissive, gated on `import.meta.env.DEV` (an explicit flag Vite
 *     sets), NEVER on the variable being absent. Missing origin in dev means "no
 *     backend running", uploads stay off, capture stays local.
 *
 * The distinction is the entire fix: absence used to mean "quietly disable the
 * product". It now means "development", and only where development was asked for.
 */
function resolveApiBaseUrl(): string {
  const raw = import.meta.env.VITE_API_BASE_URL;
  const configured = typeof raw === 'string' ? raw.trim() : '';
  if (configured === '') {
    if (import.meta.env.DEV) {
      // The DEV FLAG — not the absence of the variable — is what makes this permissible.
      // No backend running locally: uploads stay off, capture stays local.
      return '';
    }
    throw new Error(
      'VITE_API_BASE_URL is missing or empty — this build has no alert path and must not run.',
    );
  }
  if (!import.meta.env.DEV && !/^https:\/\//i.test(configured)) {
    // Deliberately fatal. A safety product that cannot reach its backend must say so,
    // not present a working-looking alert screen that reaches nobody. (Dev keeps http://
    // so a local Worker on :8787 still works.)
    throw new Error(
      `VITE_API_BASE_URL must be https: in a production build — got '${configured}'.`,
    );
  }
  return configured.replace(/\/+$/, '');
}

export const API_BASE_URL = resolveApiBaseUrl();

/**
 * Whether the backend pipeline exists. In a production build this is ALWAYS true —
 * `resolveApiBaseUrl` throws otherwise, so there is no production path on which the
 * upload/event/heartbeat calls silently no-op. It stays a value (rather than a
 * constant `true`) because a dev session genuinely can run without a backend.
 */
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
