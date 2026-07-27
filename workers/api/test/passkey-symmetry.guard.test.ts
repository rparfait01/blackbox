import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ENROL AND AUTHENTICATE MUST BE SYMMETRIC.
 *
 * The login ceremony is deliberately USERNAMELESS: authenticationOptions() sends no
 * allowCredentials, so the survivor never types an email to sign in. The consequence is
 * absolute — the browser can only offer a DISCOVERABLE (resident) credential.
 *
 * So enrolment must not be allowed to create anything else. With
 * `residentKey: 'preferred'` an authenticator may create a NON-discoverable credential:
 * enrolment reports success, the row is stored, and every subsequent sign-in fails
 * because there is nothing the browser can offer. Enrol succeeds, authenticate fails,
 * forever, on the same device — with no error that explains why.
 *
 * These pin both halves of the symmetry so one cannot drift from the other.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const passkey = readFileSync(join(HERE, '..', 'src', 'lib', 'passkey.ts'), 'utf8');
const registration = passkey.slice(passkey.indexOf('export async function registrationOptions'), passkey.indexOf('export async function verifyRegistration'));
const authentication = passkey.slice(passkey.indexOf('export async function authenticationOptions'), passkey.indexOf('export async function verifyAuthentication'));

describe('enrolment can only create a credential the login flow can find', () => {
  it('registration REQUIRES a resident (discoverable) key', () => {
    expect(registration).toMatch(/residentKey: 'required'/);
    // 'preferred' is the exact setting that let a non-discoverable credential through.
    expect(registration).not.toMatch(/residentKey: 'preferred'/);
  });

  it('the legacy CTAP2.0 boolean is set too, so older authenticators agree', () => {
    expect(registration).toMatch(/requireResidentKey: true/);
  });
});

describe('login stays usernameless — which is WHY the above is required', () => {
  it('authentication sends no allowCredentials', () => {
    // If this ever gains allowCredentials the symmetry argument changes; until then a
    // non-discoverable credential is unusable and must not be enrollable.
    expect(authentication).not.toMatch(/allowCredentials/);
  });

  it('both ceremonies derive the RP ID from ONE source', () => {
    // A registration/authentication RP-ID split fails every ceremony, silently.
    expect(registration).toMatch(/rpID: id/);
    expect(authentication).toMatch(/rpID: id/);
    expect(passkey).toMatch(/export function rpId\(env: Env\)[\s\S]{0,220}new URL\(env\.PWA_ORIGIN\)\.hostname/);
  });
});

describe('the credential is stored and looked up under the same key', () => {
  it('registration stores credential.id; authentication looks up response.id', () => {
    // Both are base64url strings from @simplewebauthn — an encoding split here would
    // make every lookup miss and read as "wrong passkey".
    expect(passkey).toMatch(/INSERT OR REPLACE INTO webauthn_credentials[\s\S]{0,400}credential\.id/);
    expect(passkey).toMatch(/WHERE credentialId = \?'[\s\S]{0,120}\.bind\(response\.id\)/);
  });

  it('a successful verification is what stamps lastUsedAt', () => {
    // This is the field that proves, in production data, whether a credential has EVER
    // authenticated — the evidence that separated a broken credential from a broken flow.
    const verify = passkey.slice(passkey.indexOf('export async function verifyAuthentication'));
    expect(verify).toMatch(/if \(!verification\.verified\) return null;[\s\S]{0,400}lastUsedAt/);
  });
});
