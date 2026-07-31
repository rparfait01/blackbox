/**
 * Types for scripts/api-origin.mjs so the Vite config (TypeScript) can import the
 * SAME validator the deploy scripts use. One rule, one implementation — a second
 * copy in TS would be free to drift weaker, and the weaker one would be the one that
 * let an origin-less build through.
 */

export declare const API_ORIGIN_VAR: 'VITE_API_BASE_URL';

export type ApiOriginResult = { ok: true; origin: string } | { ok: false; reason: string };

export declare function validateApiOrigin(value: string | undefined | null): ApiOriginResult;

/** Returns the normalised origin, or THROWS with a message naming the variable. */
export declare function assertApiOrigin(value: string | undefined | null, context?: string): string;

export interface DeployTarget {
  environment: string;
  apiOrigin: string;
  pwaOrigin: string;
  pagesProject: string;
  pagesBranch: string;
}

export declare function loadDeployTargets(): Record<string, Partial<DeployTarget>>;

export declare function deployTarget(environment: string): DeployTarget;
