/**
 * Generate the BLACK BOX REPORT-SIGNING keypair (Brief 30 §1).
 *
 *   ECDSA P-256, SHA-256.
 *
 * WHY P-256 AND NOT Ed25519. This key's whole job is to be checkable by strangers — a
 * court's expert, an advocate, an opposing party, on whatever browser and tooling they
 * happen to have. ECDSA P-256 has been universal in WebCrypto for a decade; Ed25519 only
 * arrived in Chrome 137 (May 2025), Safari 17, Firefox 129. A verifier that answers "this
 * browser can't check it" is a trust cost we do not need to pay. Same reasoning the Brief 26
 * crypto review used to pick P-256 over X25519: for a safety tool, universal beats elegant.
 *
 * WHY A DEDICATED KEY, not the existing INTEGRITY_SIGNING_KEY. Different artifact, different
 * audience, different blast radius: the integrity key signs custody export manifests for
 * recipients; this one signs survivor-generated reports for the public. Compromise of one
 * must not forge the other, and they should rotate independently.
 *
 *   node scripts/gen-report-keys.mjs
 *
 * Then, ONCE:
 *   wrangler secret put REPORT_SIGNING_KEY     # paste the printed PRIVATE value
 *   # and set REPORT_PUBLIC_KEY in wrangler.toml [vars] to the printed PUBLIC value
 *
 * THE PRIVATE VALUE IS A SECRET. It never enters the repo, the verifier bundle, or any
 * client. A leaked report-signing key means forgeable certifications — treat it that way.
 */
import { writeFileSync } from 'node:fs';

function b64(buf) {
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pkcs8 = b64(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
const spki = b64(await crypto.subtle.exportKey('spki', pair.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);

const pem = (label, body) => `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

console.log('\n=== REPORT_SIGNING_KEY (PRIVATE, PKCS8 base64) — set as a Worker secret, never commit ===\n');
console.log(pkcs8);
console.log('\n=== REPORT_PUBLIC_KEY (PUBLIC, SPKI base64) — publish; goes in wrangler.toml [vars] ===\n');
console.log(spki);

const out = process.argv[2];
if (out) {
  // Public material only — the private key is printed to the console and never written.
  writeFileSync(`${out}/blackbox-report-public-key.pem`, pem('PUBLIC KEY', spki));
  writeFileSync(`${out}/blackbox-report-public-key.jwk.json`, `${JSON.stringify(jwk, null, 2)}\n`);
  console.log(`\npublic key written (PEM + JWK) to ${out}`);
}
