import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { stripComments } from '../../../test-utils/guard-source.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)));
/** Comment-stripped: every assertion below is about BEHAVIOUR (test-utils/guard-source.mjs). */
const code = (p: string): string => stripComments(readFileSync(join(SRC, p), 'utf8'));

/**
 * Brief 2 Fix A §0/§A/§E2, client half.
 *
 * The properties that matter here are all about what does NOT happen: the credential never blocks
 * a capture, never blocks a trigger, and never becomes a prompt. On the signup path
 * refuse-everyone is an outage; on the alert path it is a survivor who cannot call for help.
 */
describe('the private key cannot leave the device', () => {
  it('the keypair is generated NON-EXPORTABLE', () => {
    // `extractable: false` means the browser will not hand the bytes to JavaScript at all —
    // not to this code, not to an XSS payload, not to devtools on an unlocked phone. That is
    // the property userHash never had.
    expect(code('lib/device-credential.ts')).toMatch(
      /generateKey\(\{ name: 'ECDSA', namedCurve: 'P-256' \}, false, \['sign', 'verify'\]\)/,
    );
  });

  it('the private half is never exported, only the public half', () => {
    const src = code('lib/device-credential.ts');
    expect(src).toMatch(/exportKey\('spki', pair\.publicKey\)/);
    expect(src).not.toMatch(/exportKey\([^)]*privateKey/);
  });
});

describe('§0 nothing here can stop a capture', () => {
  it('signature headers resolve to {} on every failure rather than throwing', () => {
    const src = code('lib/device-credential.ts');
    // Two returns of `{}`: no credential, and any thrown error.
    expect((src.match(/return \{\};/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/catch \{\s*return \{\};\s*\}/);
  });

  it('the upload attaches the headers with NO branch for failure', () => {
    // A branch here would be the beginning of a precondition. The upload must be byte-identical
    // in shape whether or not a signature was produced.
    const up = code('lib/upload/upload-manager.ts');
    expect(up).toMatch(/\.\.\.headers, \.\.\.signed, \.\.\.deviceHeaders/);
    expect(up).not.toMatch(/if \(!deviceHeaders|deviceHeaders\s*&&|Object\.keys\(deviceHeaders\)/);
  });

  it('provisioning is fire-and-forget at launch, never awaited', () => {
    const main = code('main.tsx');
    expect(main).toMatch(/void ensureDeviceCredential\(\);/);
    expect(main).not.toMatch(/await ensureDeviceCredential/);
  });

  it('provisioning is NOT on the trigger path', () => {
    // §0 — a credential check must never stand between a survivor and an alert, and that
    // includes the provisioning that would make one possible.
    for (const f of ['lib/upload/upload-manager.ts']) {
      const src = code(f);
      const openEvent = src.slice(src.indexOf('/v1/events'), src.indexOf('/v1/events') + 600);
      expect(openEvent).not.toMatch(/ensureDeviceCredential/);
    }
  });
});

describe('§E2 cleared storage is not an error state', () => {
  it('a missing key provisions a new one silently — no prompt, no dead end', () => {
    const src = code('lib/device-credential.ts');
    expect(src).toMatch(/generateKey/);
    // Nothing user-facing: no alert, no confirm, no thrown error the UI must catch.
    expect(src).not.toMatch(/alert\(|confirm\(|throw new Error/);
  });

  it('the key is stored only AFTER the server accepted it', () => {
    // A key on disk with no row behind it would be presented on every write and rejected forever.
    const src = code('lib/device-credential.ts');
    expect(src.indexOf("api<{ credentialId?: string }>")).toBeLessThan(src.indexOf('idbPut(db, RECORD, pair)'));
  });

  it('concurrent callers share one registration rather than racing to create two rows', () => {
    expect(code('lib/device-credential.ts')).toMatch(/if \(inFlight\) return inFlight;/);
  });
});

describe('§B there is ONE canonical form, not two that agree', () => {
  it('both sides import it from @blackbox/shared', () => {
    // A test asserting that two implementations produce the same string is a test that can pass
    // the day before one of them is edited. There is one function instead, so drift is not
    // expressible — the ratified rule: make the unsafe state unrepresentable, not merely wrong.
    expect(code('lib/device-credential.ts')).toMatch(/import \{ deviceCanonical \} from '@blackbox\/shared'/);
    expect(code('lib/device-credential.ts')).toMatch(/deviceCanonical\(\{ \.\.\.input, timestamp \}\)/);
  });

  it('the client no longer builds the string itself', () => {
    // Specifically the newline join that WAS the canonical form. `toHex` legitimately joins on
    // '' and is not what this is about — a guard that forbids a whole method rather than the
    // construct it means is the same over-broad matching this sweep is retiring.
    const src = code('lib/device-credential.ts');
    expect(src).not.toMatch(/\.join\('\n'\)/);
    expect(src).not.toMatch(/input\.method\.toUpperCase\(\)/);
  });
});
