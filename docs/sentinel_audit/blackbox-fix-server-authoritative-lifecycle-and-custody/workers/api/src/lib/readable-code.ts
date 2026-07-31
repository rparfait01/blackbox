/**
 * Readable one-time codes — the ONE code generator (Brief 28 §4).
 *
 * A single Crockford-style base32 alphabet, deliberately without I / L / O / U: no
 * character an anxious person reads aloud can be confused (0/O, 1/I/L), and nothing
 * spells a word. Used for recovery codes AND org enrolment / activation / registration
 * codes — one implementation so no two code systems can drift apart.
 *
 * Codes are STORED normalized (uppercase, no separators) and REDEEMED after
 * normalization, so a survivor may type them lower-case, with or without the dashes we
 * show for legibility, and still redeem. Legacy hex codes (issued before this brief)
 * are redeemed by exact match — normalization never breaks them (see the redeem paths).
 */

/** Crockford base32 minus I, L, O, U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A fresh code of `length` characters (default 10 ≈ 32^10 ≈ 1.1e15 — with the redeem
 * rate limit, not brute-forceable). Returned normalized (no separators); group it for
 * display with groupCode().
 */
export function generateReadableCode(length = 10): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Normalize user entry to the stored form: upper-case, separators/spaces removed. */
export function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Group a normalized code with dashes for legibility, e.g. "K4M9XR2T8P" → "K4M9-XR2T-8P". */
export function groupCode(code: string, groupLen = 4): string {
  return (code.match(new RegExp(`.{1,${groupLen}}`, 'g')) ?? [code]).join('-');
}
