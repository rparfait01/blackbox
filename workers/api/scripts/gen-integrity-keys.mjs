/**
 * Integrity keypair generator (Fix Brief 2 #C2). Generates an Ed25519 keypair
 * for signing the integrity chain head + export manifests.
 *
 *   node scripts/gen-integrity-keys.mjs
 *
 * - Set the PRIVATE key as a Worker secret (never commit it):
 *     wrangler secret put INTEGRITY_SIGNING_KEY      # paste the printed private value
 * - Set the PUBLIC key as a var in wrangler.toml (non-secret) AND publish it
 *   out-of-band so recipients/courts can pin it:
 *     INTEGRITY_PUBLIC_KEY = "<printed public value>"
 *
 * Both values are base64-encoded DER (PKCS8 private / SPKI public).
 */
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

console.log('INTEGRITY_SIGNING_KEY (private, PKCS8 base64 — set as a Worker secret):\n');
console.log(priv, '\n');
console.log('INTEGRITY_PUBLIC_KEY (public, SPKI base64 — set as a var + publish):\n');
console.log(pub, '\n');
