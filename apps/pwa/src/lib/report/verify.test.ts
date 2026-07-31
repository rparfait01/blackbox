import { describe, expect, it } from 'vitest';

import { renderReportHtml } from './document';
import { fingerprintSpki, type TrustedSigner } from '@blackbox/shared';
import { verifyReportDocument } from './verify';
import { freshSigningFixture, sampleEvidence, sampleReport } from './test-fixtures';
import { canonicalize } from './canonical';

/**
 * Brief 29 §3 — the acceptance heart of the brief.
 *
 *   unaltered file            → CERTIFIED
 *   one byte in the evidence  → TAMPERED
 *   an edited statement       → still CERTIFIED, and reported separately
 *
 * If these do not hold, the certification is decoration.
 */

async function docWithStatement(statement: string): Promise<string> {
  return renderReportHtml({ ...(await sampleReport()), statement });
}

/**
 * Brief 39 — the fixtures sign with a THROWAWAY keypair, so under the pinned trust set they
 * are correctly SIGNER_UNKNOWN. That is the defect working as intended: before this brief
 * these very tests obtained `certified` from a self-signed document, which is precisely what
 * a forger could do.
 *
 * The document-integrity tests below still need to exercise hashing and tampering, so they
 * pass an EXPLICIT trust set containing the fixture key. Explicit is the point: the default
 * is the pinned production set, so forgetting this parameter tightens the check rather than
 * disabling it — the inverse of the optional pin it replaces.
 */
async function trustingFixture(report: { publicKey: string }): Promise<{ trustedSigners: TrustedSigner[] }> {
  return {
    trustedSigners: [
      {
        fingerprint: await fingerprintSpki(report.publicKey),
        spki: report.publicKey,
        algorithm: 'ECDSA-P256-SHA256',
        role: 'report',
        label: 'test fixture key',
        environment: 'staging',
        validFrom: 0,
        validUntil: null,
        revokedAt: null,
        revokedReason: null,
      },
    ],
  };
}

describe('an unaltered document verifies as CERTIFIED', () => {
  it('reports certified, with every check passing', async () => {
    const report = await sampleReport();
    const result = await verifyReportDocument(await docWithStatement('My words.'), await trustingFixture(report));
    expect(result.verdict).toBe('certified');
    expect(result.headline).toContain('BLACK BOX CERTIFIED');
    expect(result.headline).toContain('unaltered since generation');
    expect(result.checks).toEqual({
      signatureValid: true,
      evidenceHashMatches: true,
      renderedTextMatches: true,
      renderingConsistent: true,
    });
  });

  it('THE DEFECT: a document carrying its OWN key is SIGNER_UNKNOWN, never certified', async () => {
    const report = await sampleReport();
    const html = renderReportHtml({ ...report, statement: '' });

    // No trust-set override: the pinned production set is in force, and this document was
    // signed by a freshly generated keypair whose public half it bundles. Before Brief 39
    // this returned `certified` — anyone who could produce a package could produce this.
    const result = await verifyReportDocument(html);
    expect(result.verdict).not.toBe('certified');
    expect(result.signer?.outcome).toBe('SIGNER_UNKNOWN');
    expect(result.headline).toContain('unrecognised key');
    // The signature IS internally valid — that is exactly why naming the signer matters.
    expect(result.checks?.signatureValid).toBe(true);
    expect(result.signer?.statement).toContain('does not publish');

    // …and with the key explicitly trusted, the same bytes certify. The document did not
    // change; what changed is whether anyone vouches for the key that signed it.
    const trusted = await verifyReportDocument(html, await trustingFixture(report));
    expect(trusted.verdict).toBe('certified');
    expect(trusted.signer?.outcome).toBe('SIGNER_TRUSTED');
    expect(trusted.signer?.fingerprint).toBe(await fingerprintSpki(report.publicKey));
  });
});

describe('ANY change to the evidence zone is detected as TAMPERED', () => {
  it('catches an edit to the VISIBLE evidence text — one character', async () => {
    const html = await docWithStatement('');
    // Change a single digit of the recorded byte count a reader would actually see.
    const tampered = html.replace('Total bytes: 2048', 'Total bytes: 2049');
    expect(tampered).not.toBe(html);
    const result = await verifyReportDocument(tampered, await trustingFixture(await sampleReport()));
    expect(result.verdict).toBe('tampered');
    expect(result.headline).toContain('TAMPERED');
    expect(result.checks!.renderedTextMatches).toBe(false);
  });

  it('catches an edit to the embedded machine-readable evidence', async () => {
    const html = await docWithStatement('');
    // Alter the signed JSON only — the visible text is untouched.
    const tampered = html.replace('"totalBytes":2048', '"totalBytes":9999');
    expect(tampered).not.toBe(html);
    const result = await verifyReportDocument(tampered, await trustingFixture(await sampleReport()));
    expect(result.verdict).toBe('tampered');
    expect(result.checks!.evidenceHashMatches).toBe(false);
  });

  it('catches a document that shows one thing and carries another', async () => {
    // Forge a coherent-looking document: real signature, real JSON, but the visible text
    // is a different rendering. Both the text hash and the rendering check must fail.
    const report = await sampleReport();
    const html = renderReportHtml({ ...report, statement: '' });
    const tampered = html.replace('Status: closed', 'Status: escalated');
    const result = await verifyReportDocument(tampered, await trustingFixture(await sampleReport()));
    expect(result.verdict).toBe('tampered');
    expect(result.checks!.renderedTextMatches).toBe(false);
  });

  it('catches a swapped signature', async () => {
    const html = await docWithStatement('');
    // A signature from a DIFFERENT key. The fixture keypair is cached per run (Brief 39), so
    // this must ask for a fresh one explicitly or it would swap in a signature made by the
    // same key and prove nothing.
    const otherSigner = await freshSigningFixture();
    const otherSig = await otherSigner.sign('anything at all');
    const tampered = html.replace(/"signature":"[^"]+"/, `"signature":"${otherSig}"`);
    const result = await verifyReportDocument(tampered, await trustingFixture(await sampleReport()));
    expect(result.verdict).toBe('tampered');
    expect(result.checks!.signatureValid).toBe(false);
  });

  it('catches an attestation re-pointed at a different event', async () => {
    const html = await docWithStatement('');
    const tampered = html.replace('"eventId":"evt-1"', '"eventId":"evt-999"');
    const result = await verifyReportDocument(tampered, await trustingFixture(await sampleReport()));
    expect(result.verdict).toBe('tampered');
  });

  it('cannot be repaired by re-signing with an attacker key — pinning is no longer optional', async () => {
    // The strongest realistic forgery: alter the evidence, re-render, re-sign with a key the
    // attacker controls, and publish their own public key in the document.
    const evidence = sampleEvidence();
    evidence.event.status = 'escalated';
    const forged = await sampleReport(evidence);
    const html = renderReportHtml({ ...forged, statement: '' });

    // Before Brief 39 this was `certified` unless a caller REMEMBERED to pass a pin. The
    // pin is gone as a parameter: the pinned trust set is the default, so a forgery is
    // exposed by doing nothing rather than by remembering something.
    const result = await verifyReportDocument(html);
    expect(result.verdict).not.toBe('certified');
    expect(result.signer?.outcome).toBe('SIGNER_UNKNOWN');
  });
});

describe('the statement zone is hers — editing it never flags the document', () => {
  it('stays CERTIFIED after the statement is rewritten', async () => {
    const report = await sampleReport();
    const original = renderReportHtml({ ...report, statement: 'First draft of my account.' });
    expect((await verifyReportDocument(original, await trustingFixture(await sampleReport()))).verdict).toBe('certified');

    // She revises her account later — a completely different statement, same evidence.
    const revised = renderReportHtml({ ...report, statement: 'A fuller account, written a month later.' });
    const result = await verifyReportDocument(revised, await trustingFixture(await sampleReport()));
    expect(result.verdict).toBe('certified');
    expect(result.statement!.present).toBe(true);
    expect(result.statement!.note).toBe('Survivor statement — her account, not machine-verified');
  });

  it('stays CERTIFIED when the statement is edited IN the downloaded file', async () => {
    const html = await docWithStatement('Original words.');
    const edited = html.replace('Original words.', 'Words I changed afterwards, at length.');
    expect(edited).not.toBe(html);
    expect((await verifyReportDocument(edited, await trustingFixture(await sampleReport()))).verdict).toBe('certified');
  });

  it('stays CERTIFIED when the statement is emptied entirely', async () => {
    const report = await sampleReport();
    expect(
      (await verifyReportDocument(renderReportHtml({ ...report, statement: '' }), await trustingFixture(report)))
        .verdict,
    ).toBe('certified');
  });

  it('reports the statement separately, never as evidence', async () => {
    const result = await verifyReportDocument(await docWithStatement('mine'), await trustingFixture(await sampleReport()));
    expect(result.statement!.note).toContain('not machine-verified');
  });
});

describe('honest outcomes for everything else', () => {
  it('says "not a report" for an unrelated file rather than TAMPERED', async () => {
    const result = await verifyReportDocument('<html><body>a shopping list</body></html>');
    expect(result.verdict).toBe('not_a_report');
  });

  it('says "not a report" for a truncated document', async () => {
    const html = await docWithStatement('');
    const result = await verifyReportDocument(html.slice(0, html.length / 2));
    expect(result.verdict).toBe('not_a_report');
  });

  it('never claims CERTIFIED when the signature could not be checked', async () => {
    // Simulate a runtime that cannot check: an unusable key makes the verify helper
    // return null, which must surface as 'unverifiable' — never as certified.
    const report = await sampleReport();
    const html = renderReportHtml({ ...report, statement: '' }).replace(
      /"publicKey":"[^"]+"/,
      '"publicKey":"not-a-key"',
    );
    const result = await verifyReportDocument(html, await trustingFixture(await sampleReport()));
    expect(result.verdict).toBe('unverifiable');
    expect(result.verdict).not.toBe('certified');
    expect(result.detail).toContain('published BLACK BOX public key');
  });
});

describe('the signature covers the attestation, and the attestation binds the custody facts', () => {
  it('is computed over the canonical attestation — not over the document bytes', async () => {
    const report = await sampleReport();
    const canonical = canonicalize(report.attestation);
    // Key order in the canonical form is fixed, so an implementation in any language can
    // reproduce exactly this string and check the signature.
    expect(canonical.indexOf('"alg"')).toBeLessThan(canonical.indexOf('"chainHead"'));
    expect(canonical).toContain('"commitmentsHash"');
    expect(canonical).toContain('"evidenceHash"');
    expect(canonical).toContain('"renderedHash"');
  });
});
