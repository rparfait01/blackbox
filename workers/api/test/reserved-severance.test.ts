/**
 * Brief 31 — the test path must not be able to spend production delivery quota.
 *
 * The fault: the acceptance suite runs against the live Worker and addresses every
 * recipient at `@example.com`. Those were handed to SendGrid for real, against the
 * SAME finite free-tier quota the alert path depends on — so running the tests could
 * exhaust the quota a survivor's alert needed. It repeatedly did.
 *
 * The severance is a property of the ADDRESS (RFC 2606), not a mode flag, because a
 * flag that could ever be set wrongly would silently swallow a REAL alert. These
 * tests pin both halves of that claim: reserved addresses never reach the provider,
 * and real addresses always do.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

import { isReservedEmail, isReservedPhone, isReservedDestination } from '../src/channels/reserved';
import { sendEmail } from '../src/channels/sendgrid-email';
import type { Env } from '../src/types';

const env = {
  SENDGRID_API_KEY: 'SG.fake-key-for-tests',
  SENDGRID_FROM_EMAIL: 'alerts@blackbox.test',
  SENDGRID_FROM_NAME: 'BLACK BOX',
} as Env;

const MESSAGE = { subject: 's', html: '<p>h</p>', text: 't' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the reserved-address rule is a property of the address, not a switch', () => {
  it('recognises every RFC 2606 reserved space the suite could use', () => {
    for (const address of [
      'smoke+acc-1@example.com',
      'a@example.net',
      'b@example.org',
      'c@anything.test',
      'd@anything.invalid',
      'e@anything.example',
      'f@localhost',
      'SMOKE+ACC-2@EXAMPLE.COM', // case-insensitive
    ]) {
      expect(isReservedEmail(address), `${address} must be reserved`).toBe(true);
    }
  });

  it('NEVER matches a real address — no configuration can suppress a real alert', () => {
    for (const address of [
      'dominick.parfait@icloud.com',
      'terekei@icloud.com',
      'royce.ikumi.parfait@gmail.com',
      'someone@example.company.com', // a REAL domain that merely starts with "example"
      'someone@notexample.com',
      'someone@example.com.ph', // real ccTLD, not the reserved domain
      'someone@testing.co.jp',
      'a@b.co',
    ]) {
      expect(isReservedEmail(address), `${address} must NOT be suppressed`).toBe(false);
    }
  });

  it('handles malformed input without throwing or over-matching', () => {
    for (const address of ['', 'no-at-sign', '@', 'trailing@']) {
      expect(() => isReservedEmail(address)).not.toThrow();
      expect(isReservedEmail(address)).toBe(false);
    }
  });

  it('recognises the reserved fictional phone range, and only it', () => {
    expect(isReservedPhone('+1 555 0100')).toBe(false); // too short to be NANP
    expect(isReservedPhone('+15555550100')).toBe(true);
    expect(isReservedPhone('+1 (555) 555-0142')).toBe(true);
    expect(isReservedPhone('+818012345678')).toBe(false);
    expect(isReservedPhone('+15555551234')).toBe(false); // 555 but not the 01XX block
  });

  it('never suppresses a channel with no reserved space (LINE)', () => {
    expect(isReservedDestination('line', 'U8f53386494d2880f3c59008f2f1f64ee')).toBe(false);
  });
});

describe('the provider is never called for a reserved address', () => {
  it('spends NO quota — fetch is not invoked at all', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await sendEmail(env, { ...MESSAGE, to: 'smoke+acc-9@example.com' }, 'activation');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.suppressed).toBe(true);
    // Honest status: suppression is NOT a delivery.
    expect(result.ok).toBe(false);
    expect(result.body).toBe('reserved_address_not_deliverable');
  });

  it('suppresses EVERY email path, not just alerts — magic links and OTP too', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // The acceptance suite creates ~70 accounts per run; each signup sends a magic
    // link. That path bypasses the dispatcher entirely, which is why the severance
    // lives at sendEmail — the one boundary every email crosses.
    for (const kind of ['magic_link', 'otp', 'guardian_invite', 'integrity_alert']) {
      const r = await sendEmail(env, { ...MESSAGE, to: `smoke+${kind}@example.com` }, kind);
      expect(r.suppressed, `${kind} must be suppressed`).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a REAL address still reaches the provider — production delivery is unchanged', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 202, headers: { 'x-message-id': 'mid-real' } }),
    );
    const result = await sendEmail(env, { ...MESSAGE, to: 'dominick.parfait@icloud.com' }, 'activation');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(result.ok).toBe(true);
    expect(result.suppressed).toBeUndefined();
    expect(result.messageId).toBe('mid-real');
  });

  it('suppression does not depend on SendGrid being configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const bare = {} as Env; // no API key at all
    const r = await sendEmail(bare, { ...MESSAGE, to: 'x@example.com' }, 'activation');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.suppressed).toBe(true);
  });
});
