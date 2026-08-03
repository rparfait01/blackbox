import { describe, expect, it } from 'vitest';

import {
  canonicalHash,
  canonicalize,
  deviceCanonical,
  evaluateSigner,
  findSigner,
  fingerprintSpki,
  formatDtg,
  formatEvidenceLabel,
  formatLocal,
  formatLocalClock,
  formatOffsetLabel,
  normalizeRenderedText,
  parseReportDocument,
  renderedHash,
  UNPARSEABLE_FINGERPRINT,
  verifyReportDocument,
  verifyReportSignature,
} from './index';

/*
 * Lives beside the code it tests. It was written in apps/pwa because `packages/shared` had no
 * test runner at all — §D gave it one, and these moved to where they belong. The verifier is the
 * artifact a third party runs against evidence without us present; it does not get to sit outside
 * the suite.
 */

/**
 * Brief 43 §C — HOSTILE INPUT NEVER THROWS.
 *
 * From Brief 39: `fingerprintSpki` threw on a malformed key, so a hostile export could crash the
 * verification tool. That is DENIAL OF VERIFICATION, and it needs no forgery to be useful to an
 * adversary's counsel — a tool that crashes on the document you hand it proves nothing about the
 * document actually in dispute, and "their own verifier could not open it" is a usable sentence
 * in a hearing.
 *
 * §E2: the verifier is a standalone offline artifact. Its hardening cannot lean on server-side
 * validation, because a hostile party feeds it directly. So every entry point below is driven with
 * the corpus and asserted to RETURN a value that fails closed, rather than throw.
 */
const CORPUS: Array<[string, unknown]> = [
  ['empty string', ''],
  ['whitespace', '   '],
  ['null', null],
  ['undefined', undefined],
  ['number', 42],
  ['boolean', true],
  ['array', [1, 2, 3]],
  ['empty object', {}],
  ['malformed base64', '!!!not-base64!!!'],
  ['padding abuse', 'AAAA===='],
  ['truncated base64', 'MFkwEwYHKoZIzj0CAQ'],
  ['valid base64, not a key', btoa('this is not a key at all')],
  ['very long string', 'A'.repeat(200_000)],
  ['embedded spaces', 'AAAA AAAA'],
  ['unicode', '\u{1F511}'.repeat(100)],
  ['embedded newlines', ['MFkw', 'EwYH', 'KoZI'].join('\n')],
  ['prototype pollution attempt', '{"__proto__":{"polluted":true}}'],
];

describe('§C fingerprintSpki never throws — the Brief 39 instance', () => {
  for (const [name, value] of CORPUS) {
    it(`returns rather than throws: ${name}`, async () => {
      const out = await fingerprintSpki(value as string);
      expect(typeof out, `${name} produced a non-string`).toBe('string');
    });
  }

  it('a malformed key fails CLOSED with a NAMED outcome, not a crash', async () => {
    // The distinction that matters: the failure must be distinguishable from a real fingerprint,
    // so no caller can mistake "could not parse" for "parsed, and this is the value".
    expect(await fingerprintSpki('!!!not-base64!!!')).toBe(UNPARSEABLE_FINGERPRINT);
    expect(UNPARSEABLE_FINGERPRINT).toMatch(/unparseable/);
  });
});

describe('§C signer evaluation never throws', () => {
  for (const [name, value] of CORPUS) {
    it(`findSigner survives: ${name}`, () => {
      expect(() => findSigner(value as string)).not.toThrow();
    });
  }

  it('evaluateSigner survives hostile shapes and still returns a verdict', () => {
    const hostile = [
      {},
      { fingerprint: null },
      { fingerprint: '!!!', signatureValid: 'yes' },
      { fingerprint: 'A'.repeat(100_000), signatureValid: true, signedAt: NaN, role: 'integrity' },
      { fingerprint: 'x', signatureValid: true, signedAt: -1, role: 'nonsense' },
    ];
    for (const h of hostile) {
      expect(() => evaluateSigner(h as never), JSON.stringify(h).slice(0, 60)).not.toThrow();
    }
  });
});

describe('§C the report verifier never throws — denial of verification is the attack', () => {
  const HOSTILE_DOCS: Array<[string, unknown]> = [
    ...CORPUS,
    ['report-shaped but empty', { version: 1 }],
    ['wrong types throughout', { version: 'x', evidence: 42, signature: [], publicKey: {} }],
    ['signature not base64', { signature: '!!!', publicKey: '!!!', evidence: {} }],
    ['huge evidence array', { evidence: { locations: new Array(10_000).fill({}) }, signature: 'A', publicKey: 'A' }],
    ['deeply nested', JSON.parse(`${'{"a":'.repeat(200)}1${'}'.repeat(200)}`)],
  ];

  for (const [name, doc] of HOSTILE_DOCS) {
    it(`verifyReportDocument returns a verdict: ${name}`, async () => {
      const r = await verifyReportDocument(doc as never);
      expect(r, `${name} returned nothing`).toBeTruthy();
      expect(['certified', 'tampered', 'not_a_report', 'unverifiable'], `${name} -> ${r?.verdict}`).toContain(r.verdict);
    });
  }

  // The WHOLE corpus, not a slice. A `.slice(0, 12)` here was silently dropping cases from a
  // sweep whose entire value is coverage — and reporting a pass over the ones it skipped.
  for (const [name, doc] of HOSTILE_DOCS) {
    it(`verifyReportSignature returns rather than throws: ${name}`, async () => {
      // Three arguments: data, signature, public key — all three attacker-supplied in a document.
      const out = await verifyReportSignature(doc as never, doc as never, doc as never);
      // `null` is the deliberate "could not check" value and is a legitimate return here;
      // `toBeDefined()` alone would also accept undefined, which no branch should produce.
      expect([true, false, null], `${name} returned ${String(out)}`).toContain(out);
    });
  }
});

describe('§C shared helpers on the request path never throw', () => {
  it('deviceCanonical survives hostile field values', () => {
    const hostile = [
      { method: null, path: null, eventId: null, bodyDigestHex: null, timestamp: null },
      { method: 42, path: {}, eventId: [], bodyDigestHex: undefined, timestamp: NaN },
      { method: 'A'.repeat(100_000), path: ' ', eventId: '\u{1F511}', bodyDigestHex: '', timestamp: -1 },
    ];
    for (const h of hostile) {
      expect(() => deviceCanonical(h as never), JSON.stringify(h).slice(0, 50)).not.toThrow();
    }
  });

  it('formatEvidenceLabel survives hostile instants and offsets', () => {
    // 8.64e15 is the largest instant a Date can hold; one past it is Invalid Date, and every
    // getter on it returns NaN rather than throwing — which must still produce a string.
    const cases: Array<[number, number]> = [
      [NaN, 0],
      [Infinity, 0],
      [-Infinity, 0],
      [0, NaN],
      [0, Infinity],
      [Number.MAX_SAFE_INTEGER, 0],
      [0, 1e9],
      [8.64e15 + 1, 0],
    ];
    for (const [ms, off] of cases) {
      expect(() => formatEvidenceLabel(ms, off), `${ms}/${off}`).not.toThrow();
    }
  });
});

/**
 * §C — THE REST OF THE SHARED SURFACE, driven with the same corpus.
 *
 * The first pass covered the verifier's entry points because that is where Brief 39's instance
 * was. These are the remaining shared exports a request or a document can reach. Fuzzing them is
 * how the two real defects above were found; a static grep for `.indexOf`/`.replace` produced 52
 * hits and judged none of them, which is a sweep that reports scope without reporting findings.
 *
 * `canonicalize` is deliberately EXCLUDED from the never-throws rule and asserted separately: it
 * throws by design on values JSON cannot represent (non-finite numbers, functions), and that is
 * correct — silently canonicalizing a value it cannot round-trip would produce a hash that means
 * nothing. It is only ever called on JSON-PARSED data, which cannot contain those, so the throw
 * is unreachable from a document. That reasoning is asserted rather than assumed.
 */
describe('§C the remaining shared surface never throws on hostile input', () => {
  for (const [name, value] of CORPUS) {
    it(`normalizeRenderedText / renderedHash: ${name}`, async () => {
      expect(() => normalizeRenderedText(value as string), name).not.toThrow();
      await expect(renderedHash(value as string), name).resolves.toMatch(/^[0-9a-f]{64}$/);
    });

    it(`parseReportDocument: ${name}`, () => {
      let out: unknown;
      expect(() => (out = parseReportDocument(value)), name).not.toThrow();
      // Nothing in the corpus is a report, so every one of them must parse to null. A corpus
      // value that returned a ParsedReport would mean the parser accepts garbage as a document.
      expect(out, `${name} parsed as a report`).toBeNull();
    });

    it(`canonicalHash accepts any JSON-representable value: ${name}`, async () => {
      // `undefined` is excluded: it is not JSON-representable, cannot be the top-level result of
      // JSON.parse, and canonicalize refusing it is the designed behaviour rather than a defect.
      if (value === undefined) return;
      await expect(canonicalHash(value), name).resolves.toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it('canonicalize refuses what JSON cannot represent, rather than hashing a lie', () => {
    // NOT a §C violation. A hash over a value that cannot round-trip is worse than an error: it
    // would verify against nothing. The guard is that these are unreachable from parsed input.
    expect(() => canonicalize(Number.NaN)).toThrow();
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonicalize(() => undefined)).toThrow();
    // I ASSUMED THIS WAS UNREACHABLE FROM A DOCUMENT, AND THE CORPUS DISPROVED IT.
    // The reasoning was "JSON has no Infinity literal, so parsed data is always canonicalizable".
    // It is wrong: JSON.parse('1e999') OVERFLOWS to Infinity. A single oversized number in an
    // uploaded document therefore reached canonicalize and threw out of the verifier.
    expect(JSON.parse('1e999'), 'JSON.parse no longer overflows — re-check the verifier').toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(() => canonicalize(JSON.parse('{"totalBytes":1e999}'))).toThrow();
  });

  it('a document carrying an overflowing number gets a VERDICT, not a crash', async () => {
    // The §C property at the real entry point, for the case above. The verifier must not throw,
    // must not certify, and must not fall through to the generic backstop — the canonicalization
    // failure is handled where it happens, so the reader gets a finding about the document.
    //
    // THE JSON IS HAND-BUILT, and that is not stylistic. My first version of this test used
    // JSON.stringify({ totalBytes: 1e999 }), which serialises Infinity to `null` — the document
    // contained no overflowing number at all and the test passed without exercising a single line
    // of the path it names. It is the §D vacuous class, written while fixing the §C one.
    const payload =
      '{"evidence":{"formatVersion":1,"capture":{"included":true,"totalBytes":1e999}},' +
      '"attestation":{"evidenceHash":"' + 'x'.repeat(64) + '","renderedHash":"' + 'y'.repeat(64) +
      '","signedAt":"2026-07-30T00:00:00Z"},"signature":"AAAA","publicKey":"AAAA"}';
    // Prove the fixture is what it claims BEFORE relying on it.
    expect(payload, 'the fixture lost its overflowing literal').toContain('1e999');
    expect(
      (JSON.parse(payload) as { evidence: { capture: { totalBytes: number } } }).evidence.capture.totalBytes,
      'the fixture does not actually overflow',
    ).toBe(Number.POSITIVE_INFINITY);

    const doc =
      '<script type="application/json" id="blackbox-attestation">' +
      payload +
      '</script><pre id="blackbox-evidence-text">anything</pre>';
    const result = await verifyReportDocument(doc);
    expect(result.verdict, 'an overflowing number must not certify').not.toBe('certified');
    expect(
      result.headline,
      'it fell through to the generic backstop instead of being handled where it happens',
    ).not.toContain('Could not complete the check');
    // It reached the real verdict logic, so the checks are present and the failure is named.
    expect(result.checks, 'no checks — the verifier bailed before evaluating anything').toBeDefined();
    expect(result.checks!.evidenceHashMatches, 'an uncomputable hash must not compare equal').toBe(false);
  });

  it('the time formatters never throw on a hostile clock or offset', () => {
    const clocks = [Number.NaN, Number.POSITIVE_INFINITY, -Number.MAX_SAFE_INTEGER, 8.64e15 + 1, 0];
    const offsets = [null, undefined, Number.NaN, 1e9, -1e9, 'x'];
    for (const t of clocks) {
      expect(() => formatDtg(t), `formatDtg(${t})`).not.toThrow();
      for (const o of offsets) {
        expect(() => formatLocal(t, o as number), `formatLocal(${t},${o})`).not.toThrow();
        expect(() => formatLocalClock(t, o as number), `formatLocalClock(${t},${o})`).not.toThrow();
        expect(() => formatEvidenceLabel(t, o as number), `formatEvidenceLabel(${t},${o})`).not.toThrow();
      }
    }
    for (const o of offsets) expect(() => formatOffsetLabel(o as number), `formatOffsetLabel(${o})`).not.toThrow();
  });
});
