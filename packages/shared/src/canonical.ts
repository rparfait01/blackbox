/**
 * Canonical JSON serialization (Brief 29 §2) — SHARED, so the device that computes a hash
 * and the Worker that signs one are provably using the same bytes. Two implementations
 * that drift by one character produce signatures that never verify; there is exactly one
 * implementation, and it lives here.
 *
 * The signature is only as trustworthy as the bytes it covers are reproducible. A court's
 * own expert must be able to take the document, re-derive the same hash, and check it
 * against the published key WITHOUT this code. So the rules are deliberately small, boring,
 * and fully specified in docs/brief29/VERIFICATION.md:
 *
 *   1. Objects serialize with keys sorted by Unicode code point (`<` on the raw string).
 *   2. `undefined` members are omitted entirely; `null` is kept and serializes as `null`.
 *   3. Arrays keep their order — order is meaning (chunk sequence, notification order).
 *   4. No insignificant whitespace anywhere.
 *   5. Strings/numbers/booleans use JSON.stringify's own escaping (RFC 8259).
 *   6. Non-finite numbers are refused rather than silently coerced to null — a NaN in a
 *      signed evidence zone would be a hash that cannot be reproduced from the document.
 *
 * This matches JCS (RFC 8785) over the subset we emit. We do not depend on a JCS library:
 * the ruleset above is short enough to re-implement in any language, which is the whole
 * point — independence from BLACK BOX is the trust (§0).
 */
import { sha256Hex } from './hmac';

/** Serialize a value to its canonical form. Throws on values that cannot be canonically
 *  represented, rather than emitting bytes a third party could not reproduce. */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error('canonicalize: non-finite number is not representable');
    }
    return JSON.stringify(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalize: unsupported type ${t}`);
}

/** SHA-256 (hex) of a value's canonical serialization. This is the evidence-zone hash the
 *  device computes and the server signs — the server receives ONLY this, never the content
 *  (§2: sign the hash, not the content). */
export async function canonicalHash(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalize(value)));
}

/**
 * Normalize the VISIBLE evidence text before hashing it.
 *
 * The signed payload binds the rendered text as well as the structured data, so editing
 * what a reader actually sees is detected even if the embedded JSON is left alone. But a
 * document legitimately gets reflowed — opened in a different browser, saved, printed. So
 * we hash the text content with runs of whitespace collapsed and the ends trimmed. Anything
 * that survives that normalization is a real change to what the document asserts.
 */
export function normalizeRenderedText(text: string): string {
  // §C — the text being normalized comes out of an uploaded document, and a caller that had
  // something other than a string (a failed read, a JSON field that was a number) hit
  // `null.replace` here. `String(x)` is the identity on strings, so every hash ever computed is
  // unchanged; a non-string now normalizes to its printed form instead of throwing.
  return String(text).replace(/\s+/g, ' ').trim();
}

/** SHA-256 (hex) of the normalized visible evidence text. */
export async function renderedHash(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(normalizeRenderedText(text)));
}
