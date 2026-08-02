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
  return [
    input.method.toUpperCase(),
    input.path,
    input.eventId,
    input.bodyDigestHex,
    String(input.timestamp),
  ].join('\n');
}
