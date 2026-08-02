/**
 * Types for the vault retention gate (Brief 40 §B/§C), so the guard test that imports it
 * typechecks. See vault-lock.mjs for §D — what the rule does and does not prevent.
 */
export declare const RETENTION_MONTHS: number;
export declare const RETENTION_DAYS: number;
export declare const VAULT_PREFIX: string;
export declare const VAULT_LOCK_NAME: string;

export interface LockRule {
  name: string;
  enabled: boolean;
  prefix: string;
  condition: string;
  retentionDays: number | null;
  indefinite: boolean;
}

export interface LockVerdict {
  ok: boolean;
  problems: string[];
  rule: LockRule | null;
}

export declare function parseLockRules(text: string): LockRule[];
export declare function assertVaultLock(
  rules: LockRule[],
  expected?: { prefix?: string; retentionDays?: number },
): LockVerdict;
export declare function readVaultLock(bucket: string, cwd?: string): string;
export declare function provisionCommand(): string;
export declare const VAULT_BUCKET: string;
export declare const LOCK_CONFIG_PATH: string;
export declare function loadLockConfig(file?: string): {
  bucket: string;
  name: string;
  prefix: string;
  retentionDays: number;
  retentionMonths: number;
  rules: unknown[];
};
