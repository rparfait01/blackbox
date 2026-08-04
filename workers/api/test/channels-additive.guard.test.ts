import { describe, expect, it } from 'vitest';

import { isChannelDeliverable } from '../src/channels/router';
import type { Env } from '../src/types';

/**
 * STANDING CONSTRAINT — channels are additive. No delivery channel is ever retired in favour of
 * another, and every channel a contact holds is used.
 *
 * ═══ WHAT THIS STOPS ═════════════════════════════════════════════════════════════════════════
 *
 * `isChannelDeliverable` carried an instruction to retire email: "Flip this to `false` once SMS
 * delivers." Had anyone followed it, two production contacts holding only an email endpoint would
 * have gone dark, and nothing in the system would have said so — the alert would simply have
 * reached nobody on the night it mattered.
 *
 * The rationale was that email is a single-vendor cap that had silently failed twice. Both facts
 * are true. Neither supports deleting the channel: that was a QUOTA failure, and quota is answered
 * by a second channel ALONGSIDE, never by removing the first. Email has no carrier, no A2P
 * registration and no delivery gate, which is exactly why it is the one most likely to survive
 * when the others do not.
 *
 * So the property asserted here is narrow and structural: a BUILT channel is deliverable whenever
 * its credentials exist. Deliverability may depend on the environment. It may never depend on a
 * decision to prefer a different channel.
 */
const BUILT: Array<[string, Partial<Env>]> = [
  ['email', { SENDGRID_API_KEY: 'k', SENDGRID_FROM_EMAIL: 'a@b.c' }],
  ['line', { LINE_CHANNEL_ACCESS_TOKEN: 't' }],
  ['sms', { TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 'tok', TWILIO_MESSAGING_SERVICE_SID: 'MG' }],
];

describe('channels are additive', () => {
  for (const [channel, credentials] of BUILT) {
    it(`${channel} is deliverable whenever its credentials are present`, () => {
      expect(
        isChannelDeliverable(credentials as Env, channel),
        `${channel} is NOT deliverable with full credentials — a channel has been retired. ` +
          'Channels are additive: a contact reachable on more channels is more likely reached, ' +
          'and no channel is ever removed in favour of another.',
      ).toBe(true);
    });

    it(`${channel} is not deliverable without them — the environment decides, and only it`, () => {
      // The other half: deliverability must track credentials, so this is a real gate rather
      // than a constant that happens to read true.
      expect(isChannelDeliverable({} as Env, channel)).toBe(false);
    });
  }

  it('no built channel is hardcoded off', () => {
    // A retirement would most naturally arrive as `case 'email': return false;`. With every
    // credential present, all three must answer true.
    const all = Object.assign({}, ...BUILT.map(([, c]) => c)) as Env;
    for (const [channel] of BUILT) {
      expect(isChannelDeliverable(all, channel), `${channel} is hardcoded off`).toBe(true);
    }
  });
});
