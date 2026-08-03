/**
 * Brief 2 Fix A §B — THE ONE CANONICAL FORM, shared by both sides.
 *
 * The device signs it and the server verifies it. If those were two implementations, they could
 * drift — a reordered field, a different separator, a lower-cased method — and the symptom would
 * be every signature failing verification, which on an armed account means refused writes on the
 * capture path. Make the unsafe state unrepresentable rather than test for it: there is one
 * function, both sides import it, and disagreement is not expressible.
 */
export function deviceCanonical(input: {
  method: string;
  path: string;
  eventId: string;
  bodyDigestHex: string;
  timestamp: number;
}): string {
  // ═══ Brief 43 §C — TOTAL, BECAUSE A THROW HERE IS A BYPASS SHAPE ════════════════════════════
  //
  // The server side of this call sits inside the capture path's fail-open catch, which is
  // correct — an infrastructure failure must never cost a survivor her evidence. But it means a
  // THROWN error here does not surface as an error: it converts a REFUSED verdict into
  // ACCEPTED_FAIL_OPEN. Anything that can make this function throw is therefore a way to turn
  // off device verification, and `input.method.toUpperCase()` threw on a null method.
  //
  // Not reachable today — the one call site passes the literal 'POST', a URL pathname, a route
  // param and a computed digest, none of which can be null. That makes this latent rather than
  // live, and latent is worth closing on a path whose failure mode is silent acceptance.
  //
  // `String(x)` is the IDENTITY on strings, so every signature ever produced is unaffected. A
  // null field now yields the text "null" on whichever side had it, the two canonical strings
  // disagree, and the result is a signature mismatch — a REFUSED, which is the honest outcome —
  // instead of a fail-open that looks like success.
  return [
    String(input.method).toUpperCase(),
    String(input.path),
    String(input.eventId),
    String(input.bodyDigestHex),
    String(input.timestamp),
  ].join('\n');
}
