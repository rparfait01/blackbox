/**
 * Brief 35 Fix B §A/§B — ENVIRONMENT-BOUND DISPATCH SUPPRESSION.
 *
 * Brief 35 §D suppressed dispatch BY IDENTITY: an event's `isTest` flag and its owner's
 * `isCanary` flag, both re-derived at dispatch time. That control is correct and stays exactly as
 * it is. It does not answer a different question: staging holds a live SENDGRID_API_KEY, and a
 * staging send to a non-reserved address reaches a real inbox and spends real credits. This adds
 * the second axis. Neither substitutes for the other.
 *
 * ═══ THE ASYMMETRY THAT DECIDES EVERY DEFAULT HERE ════════════════════════════════════════════
 *
 * A leaked staging email is embarrassing. Production silently deciding it is not production, and
 * swallowing a real cascade, is a survivor who called for help and was not heard. Those are not
 * comparable, so every uncertain case in this file resolves toward DISPATCH.
 *
 *   PRODUCTION        positively proven → dispatch externally.
 *   NON_PRODUCTION    positively proven, and not on the allow-list → suppress.
 *   INDETERMINATE     no proof either way → DISPATCH, and alert loudly (§B).
 *
 * That third state is not a gap, it is the design. A database nobody has stamped yet, an
 * unreachable D1, a value written by a future version this build does not recognise — all of them
 * dispatch. The gate closes only on positive evidence that this is somewhere a real person should
 * not be contacted from.
 *
 * ═══ §A — ALLOW-LIST, NOT DENY-LIST ═══════════════════════════════════════════════════════════
 *
 * `PERMITTED_TO_DISPATCH` contains exactly one name. An environment added later — 'qa',
 * 'preview', 'demo' — is suppressed because it was never added, which is the ratified rule and the
 * same shape as Brief 41's `ruleFor()`. A deny-list would silently permit every environment
 * created after it was written.
 *
 * ═══ §E4 — THERE IS NO BYPASS ═════════════════════════════════════════════════════════════════
 *
 * No flag, header, query parameter or argument re-enables external dispatch in a non-production
 * environment. If a real provider ever needs shape-testing, that is a production canary account
 * whose contacts are reserved addresses — not a staging bypass. A control anything can opt out of
 * is not a control, which Brief 35 Fix A §C established by removing exactly that from the deploy
 * gate.
 */
import type { Env } from '../types';

export type EnvironmentVerdict = 'PRODUCTION' | 'NON_PRODUCTION' | 'INDETERMINATE';

/** §A — the allow-list. One entry. Adding a second is a decision, not a default. */
const PERMITTED_TO_DISPATCH = new Set(['production']);

export interface EnvironmentIdentity {
  verdict: EnvironmentVerdict;
  /** The stamped name, when there is one. Null when indeterminate. */
  name: string | null;
  /** Always populated — a suppression an operator cannot explain is not reviewable. */
  detail: string;
}

/**
 * Per-isolate cache.
 *
 * A determined answer is cached indefinitely: the marker is stamped once per database and cannot
 * change under a running isolate without the binding changing, which would be a new deploy.
 * INDETERMINATE is deliberately NOT cached — it means something is wrong, it alerts every time it
 * is hit, and a stamp applied while an isolate is warm must take effect without waiting for that
 * isolate to be recycled.
 */
let cached: EnvironmentIdentity | null = null;

/**
 * Ask the BOUND DATABASE what environment it is.
 *
 * Never throws. An exception here would become a 500 on the dispatch path, which is the failure
 * this file exists to prevent.
 */
export async function resolveEnvironment(env: Env): Promise<EnvironmentIdentity> {
  if (cached) return cached;
  try {
    const row = await env.DB.prepare('SELECT name FROM environment_identity WHERE id = 1')
      .first<{ name: string }>();
    const name = (row?.name ?? '').trim().toLowerCase();
    if (!name) {
      // §B — unstamped. Dispatch, and say so every single time.
      return {
        verdict: 'INDETERMINATE',
        name: null,
        detail: 'no environment stamp in the bound database — dispatching, because refusing here would silence a real cascade',
      };
    }
    const verdict: EnvironmentVerdict = PERMITTED_TO_DISPATCH.has(name) ? 'PRODUCTION' : 'NON_PRODUCTION';
    cached = {
      verdict,
      name,
      detail:
        verdict === 'PRODUCTION'
          ? 'bound database is stamped production — external dispatch enabled'
          : `bound database is stamped '${name}', which is not on the dispatch allow-list — external providers are unreachable from here`,
    };
    return cached;
  } catch (err) {
    // §B — an unreadable marker is not evidence that this is staging.
    return {
      verdict: 'INDETERMINATE',
      name: null,
      detail: `environment stamp unreadable (${String(err).slice(0, 80)}) — dispatching, because refusing here would silence a real cascade`,
    };
  }
}

/**
 * The one question every provider boundary asks.
 *
 * Returns true when an external provider may be called. INDETERMINATE returns TRUE — see the
 * asymmetry at the top of this file.
 */
export async function mayDispatchExternally(env: Env): Promise<{ allowed: boolean; identity: EnvironmentIdentity }> {
  const identity = await resolveEnvironment(env);
  if (identity.verdict === 'INDETERMINATE') {
    // §B — loud, every time. This is a deploy or seeding fault and it must not become background.
    console.log(
      JSON.stringify({
        level: 'error',
        alert: 'environment_indeterminate',
        detail: identity.detail,
        action: 'dispatched anyway',
      }),
    );
    return { allowed: true, identity };
  }
  return { allowed: identity.verdict === 'PRODUCTION', identity };
}

/** Test seam, and used by the stamping endpoint so a fresh stamp takes effect immediately. */
export function clearEnvironmentCache(): void {
  cached = null;
}

/** §C — what the readiness panel reports, per environment. */
export async function dispatchPosture(env: Env) {
  const identity = await resolveEnvironment(env);
  const credentials = {
    sendgrid: Boolean(env.SENDGRID_API_KEY),
    twilio: Boolean(env.TWILIO_AUTH_TOKEN),
    line: Boolean(env.LINE_CHANNEL_ACCESS_TOKEN),
  };
  const present = Object.entries(credentials)
    .filter(([, v]) => v)
    .map(([k]) => k);
  // §C — a non-production environment holding a provider credential is an alertable condition:
  // §A prevents the call, but two independent barriers is the requirement, not one.
  const alerting = identity.verdict === 'NON_PRODUCTION' && present.length > 0;
  return {
    environment: identity.name ?? 'INDETERMINATE',
    verdict: identity.verdict,
    externalDispatch: identity.verdict !== 'NON_PRODUCTION',
    providerCredentials: present,
    alerting,
    summary:
      `DISPATCH: ${identity.name ?? 'INDETERMINATE'} · external ${identity.verdict === 'NON_PRODUCTION' ? 'SUPPRESSED' : 'ENABLED'}` +
      (present.length ? ` · credentials present: ${present.join(', ')}` : ' · no provider credentials') +
      (alerting ? ' · ALERT: a non-production environment holds provider credentials (§C)' : ''),
    detail: identity.detail,
  };
}
