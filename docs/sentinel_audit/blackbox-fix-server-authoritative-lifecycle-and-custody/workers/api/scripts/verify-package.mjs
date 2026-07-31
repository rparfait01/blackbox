/**
 * Standalone package verifier (Fix Brief 2 #C2). Confirms a BLACK BOX evidence
 * package is unaltered. Dependency-free Node — a recipient or court can run it
 * with nothing but Node installed. Changing a single byte fails verification.
 *
 *   node verify-package.mjs <manifest.json> [media-dir] [--pubkey <SPKI-base64>]
 *
 * It checks three independent things:
 *   1. SIGNATURE — the manifest is Ed25519-signed by the operator's key. Any
 *      edit to the manifest (timestamps, hashes, recipient, chain) breaks it.
 *   2. CHAIN — the append-only hash chain is internally consistent: every
 *      chainHash[n] === sha256(prevHash[n] + recordHash[n]) and links to [n-1],
 *      ending at the signed head.
 *   3. FILES — if media files are present (media-dir), each file's SHA-256
 *      matches the manifest. A flipped byte in any chunk fails here.
 *
 * Pass --pubkey to PIN the public key out-of-band (recommended for court use)
 * instead of trusting the key embedded in the manifest.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { join, dirname } from 'node:path';

function fail(msg) {
  console.error('✗ ' + msg);
}
function ok(msg) {
  console.log('✓ ' + msg);
}
function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const args = process.argv.slice(2);
const pinIdx = args.indexOf('--pubkey');
const pinnedPubKey = pinIdx >= 0 ? args[pinIdx + 1] : null;
const positional = args.filter((a, i) => a !== '--pubkey' && (pinIdx < 0 || i !== pinIdx + 1));
const manifestPath = positional[0];
const mediaDir = positional[1] || dirname(manifestPath || '.');

if (!manifestPath || !existsSync(manifestPath)) {
  console.error('Usage: node verify-package.mjs <manifest.json> [media-dir] [--pubkey <SPKI-base64>]');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
let pass = true;

// --- 1. signature ---
const sig = manifest.signature;
const pubB64 = pinnedPubKey || manifest.publicKey;
if (!sig || !pubB64) {
  fail('No signature or public key present — package is NOT signed.');
  pass = false;
} else {
  // Recompute the exact canonical string the server signed: the manifest minus
  // the `signature` field, re-serialized compactly in the same key order.
  const unsigned = { ...manifest };
  delete unsigned.signature;
  const canonical = JSON.stringify(unsigned);
  try {
    const keyObj = createPublicKey({
      key: Buffer.from(pubB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const valid = edVerify(null, Buffer.from(canonical), keyObj, Buffer.from(sig, 'base64'));
    if (valid) {
      ok('Signature valid' + (pinnedPubKey ? ' (against pinned public key)' : ' (key from manifest)'));
    } else {
      fail('Signature INVALID — the manifest has been altered or signed by a different key.');
      pass = false;
    }
  } catch (e) {
    fail('Signature check error: ' + e.message);
    pass = false;
  }
}

// --- 2. chain ---
const GENESIS = '0'.repeat(64);
const records = (manifest.chain && manifest.chain.records) || [];
let prev = GENESIS;
let chainOk = true;
for (let i = 0; i < records.length; i++) {
  const r = records[i];
  if (r.seq !== i) {
    fail(`Chain seq gap at index ${i} (got ${r.seq}).`);
    chainOk = false;
    break;
  }
  if (r.prevHash !== prev) {
    fail(`Chain break at seq ${r.seq}: prevHash does not match prior chainHash.`);
    chainOk = false;
    break;
  }
  const expected = sha256Hex(Buffer.from(prev + r.recordHash));
  if (expected !== r.chainHash) {
    fail(`Chain hash mismatch at seq ${r.seq}.`);
    chainOk = false;
    break;
  }
  prev = r.chainHash;
}
if (chainOk) {
  if (manifest.chain && manifest.chain.head && manifest.chain.head !== prev) {
    fail('Chain head does not match the last record — record(s) added or removed.');
    pass = false;
  } else {
    ok(`Hash chain consistent (${records.length} records).`);
  }
} else {
  pass = false;
}

// --- 3. files (best-effort: only if present locally) ---
const files = manifest.files || [];
let checked = 0;
let missing = 0;
for (const f of files) {
  const candidates = [join(mediaDir, f.name), join(mediaDir, String(f.name).replace('chunks/', ''))];
  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    missing++;
    continue;
  }
  const actual = sha256Hex(readFileSync(path));
  checked++;
  if (f.sha256 && actual !== f.sha256) {
    fail(`File hash mismatch: ${f.name} (expected ${f.sha256}, got ${actual}).`);
    pass = false;
  }
}
if (checked > 0) {
  ok(`Verified ${checked} media file hash(es)${missing ? `, ${missing} not present locally` : ''}.`);
} else if (files.length > 0) {
  console.log(`• ${files.length} media file(s) referenced; none present in ${mediaDir} (manifest still verified).`);
}

console.log('');
if (pass) {
  console.log('RESULT: PACKAGE VERIFIED — unaltered.');
  process.exit(0);
} else {
  console.log('RESULT: VERIFICATION FAILED — package is altered or unsigned.');
  process.exit(1);
}
