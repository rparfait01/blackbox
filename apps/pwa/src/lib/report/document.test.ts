import { describe, expect, it } from 'vitest';

import { canonicalize, canonicalHash, normalizeRenderedText } from './canonical';
import { computeEvidenceHashes, parseReportDocument, renderEvidenceText, renderReportHtml } from './document';
import { sampleEvidence, sampleReport } from './test-fixtures';

/**
 * Brief 29 §2 — the canonical bytes and the document format. These are the foundation the
 * signature stands on: if canonicalization is not reproducible, or the document cannot be
 * parsed back to exactly what was signed, then "CERTIFIED" means nothing.
 */

describe('canonical serialization is reproducible', () => {
  it('sorts object keys by code point, so key order cannot change the hash', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: 2, b: 1 })).toBe(canonicalize({ b: 1, a: 2 }));
  });

  it('preserves ARRAY order — order is meaning (chunk sequence, notification order)', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it('keeps null and omits undefined', () => {
    expect(canonicalize({ a: null, b: undefined, c: 1 })).toBe('{"a":null,"c":1}');
  });

  it('refuses non-finite numbers rather than emitting an unreproducible hash', () => {
    expect(() => canonicalize({ a: NaN })).toThrow();
    expect(() => canonicalize({ a: Infinity })).toThrow();
  });

  it('nests deterministically', () => {
    const a = canonicalize({ z: { b: [1, { d: 4, c: 3 }] }, a: 'x' });
    const b = canonicalize({ a: 'x', z: { b: [1, { c: 3, d: 4 }] } });
    expect(a).toBe(b);
  });

  it('collapses whitespace when hashing visible text, so reflow is not tampering', () => {
    expect(normalizeRenderedText('a  b\n\nc  ')).toBe('a b c');
  });
});

describe('the evidence rendering is deterministic and asserts nothing', () => {
  it('has no hidden nondeterminism — two equal inputs render identically', async () => {
    // NARROW ON PURPOSE, and renamed to say so. Both sides call the same function, so for any
    // deterministic implementation this CANNOT fail; it is not a check that the output is
    // correct or stable. What it does catch is real and nothing else covers it: a clock, a
    // random value, or an iteration order leaking into the render would make two equal inputs
    // disagree. Flagged by the Brief 43 acceptance-6 fixture sweep and kept for that reason.
    //
    // The property its old name implied — that the bytes do not DRIFT — is covered properly in
    // packages/shared/src/report-render-stability.test.ts, against a hash computed from the code
    // as it stood before the change. That is the pin; this is the nondeterminism check.
    const evidence = sampleEvidence();
    expect(renderEvidenceText(evidence)).toBe(renderEvidenceText(sampleEvidence()));
    expect(await canonicalHash(evidence)).toBe(await canonicalHash(sampleEvidence()));
  });

  it('states the facts without characterizing the incident', () => {
    const text = renderEvidenceText(sampleEvidence());
    expect(text).toContain('no interpretation');
    expect(text).toContain('BLACK BOX — CERTIFIED EVIDENCE RECORD');
    // Nothing in the evidence zone grades, concludes, or narrates.
    expect(text).not.toMatch(/\b(likely|appears to|suggests|probably|we believe|assault occurred)\b/i);
  });

  it('surfaces a missing final-chunk marker rather than implying completeness', () => {
    const evidence = sampleEvidence();
    evidence.capture.finalChunkPresent = false;
    expect(renderEvidenceText(evidence)).toContain('may be incomplete');
  });
});

describe('the document round-trips exactly', () => {
  it('parses back to the payload it was rendered from', async () => {
    const report = await sampleReport();
    const html = renderReportHtml({ ...report, statement: 'My own words.' });
    const parsed = parseReportDocument(html);
    expect(parsed).not.toBeNull();
    expect(parsed!.payload.attestation).toEqual(report.attestation);
    expect(parsed!.payload.signature).toBe(report.signature);
    expect(parsed!.statement).toBe('My own words.');
    // The visible evidence text is exactly what was hashed.
    expect(parsed!.evidenceText).toBe(renderEvidenceText(report.evidence));
  });

  it('survives HTML-special characters in the statement without corrupting the document', async () => {
    const report = await sampleReport();
    const nasty = 'He said <b>"stop"</b> & I froze </pre></div><script>alert(1)</script>';
    const html = renderReportHtml({ ...report, statement: nasty });
    const parsed = parseReportDocument(html);
    // The statement is escaped, so its markup cannot break out of its own block or
    // truncate the document — and it round-trips byte-for-byte.
    expect(parsed).not.toBeNull();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(parsed!.statement).toBe(nasty);
  });

  it('carries the CERTIFIED mark and the verification pointer', async () => {
    const html = renderReportHtml({ ...(await sampleReport()), statement: '' });
    expect(html).toContain('BLACK BOX CERTIFIED');
    expect(html).toContain('https://www.blackboxsentinel.com/verification');
  });

  it('returns null for a file that is not a report at all', () => {
    expect(parseReportDocument('<html><body>hello</body></html>')).toBeNull();
  });

  it('computes the two hashes the server signs — and nothing else leaves the device', async () => {
    const evidence = sampleEvidence();
    const hashes = await computeEvidenceHashes(evidence);
    expect(hashes.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes.renderedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes.evidenceHash).toBe(await canonicalHash(evidence));
  });
});
