/**
 * Types for the deploy currency gate, so the guard test that imports it typechecks.
 * Brief 35 Fix A §B — the poll returns a CLASSIFICATION, never a boolean. A caller that
 * reads a `.ok` off a GateResult is now a type error rather than a silently-undefined
 * falsy read, which is exactly how the canary came to fail every deploy.
 */
export declare const OUTCOME: {
  readonly CURRENT: 'CURRENT';
  readonly PROPAGATING: 'PROPAGATING';
  readonly UNAVAILABLE: 'UNAVAILABLE';
  readonly QUOTA_EXCEEDED: 'QUOTA_EXCEEDED';
  readonly WRONG_ARTIFACT: 'WRONG_ARTIFACT';
  readonly INFRASTRUCTURE_UNAVAILABLE: 'INFRASTRUCTURE_UNAVAILABLE';
};
export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

export declare const PROPAGATION_BUDGET_MS: number;
export declare const UNAVAILABLE_BUDGET_MS: number;
export declare const MAX_ATTEMPTS: number;

export interface GateResult {
  outcome: Outcome;
  detail: string;
  attempts: number;
  elapsedMs: number;
  seen: string;
}

export interface PollOptions {
  maxAttempts?: number;
  propagationBudgetMs?: number;
  unavailableBudgetMs?: number;
}

export declare function classify(input: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  error?: string;
  field: string;
  expected: string;
}): GateResult;

export declare function proveCurrent(
  url: string,
  field: string,
  expected: string,
  opts?: PollOptions,
): Promise<GateResult>;

export declare function checkDeployCurrency(
  opts: { expected: string; prodUrl: string; workerUrl: string } & PollOptions,
): Promise<{ ok: boolean; pwa: GateResult; worker: GateResult }>;

export declare function operatorGuidance(outcome: Outcome): string;
export declare function recordGateOutcome(half: string, result: GateResult): void;
export declare function assertDeployCurrencyOrExit(opts: {
  expected: string;
  prodUrl: string;
  workerUrl: string;
}): Promise<void>;
export declare function gateRequestCount(): number;
export declare function resetGateRequestCount(): void;
