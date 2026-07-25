/**
 * The verifier (Brief 29 §3).
 *
 * The implementation lives in @blackbox/shared so the verification page, the Worker
 * endpoint, and any client all check documents with ONE implementation. This module adds
 * no behaviour — it exists so the report code reads against a local path.
 *
 * The verifier is a leaf: nothing in the running app imports it, and deleting it leaves
 * the system unchanged (see report-leaf.guard.test.ts).
 */
export {
  verifyEd25519,
  verifyReportDocument,
  CERTIFIED_PREFIX,
  STATEMENT_NOTE,
  TAMPERED_HEADLINE,
  type VerificationChecks,
  type VerificationResult,
  type Verdict,
} from '@blackbox/shared';
