/**
 * Canonical serialization + hashing for the certified report (Brief 29 §2).
 *
 * The implementation lives in @blackbox/shared so the device computing a hash and the
 * Worker signing it are provably using the same bytes — two copies that drift by one
 * character would produce signatures that never verify. This module exists only so the
 * report code reads against a local path; it adds no behaviour of its own.
 *
 * See packages/shared/src/canonical.ts for the ruleset, and docs/brief29/VERIFICATION.md
 * for the third-party specification.
 */
export { canonicalize, canonicalHash, normalizeRenderedText, renderedHash } from '@blackbox/shared';
