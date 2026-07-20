import { describe, expect, it } from 'vitest';

import {
  confirmationAsk,
  confirmedReply,
  declinedReply,
  helpReply,
  consentGateEnforced,
} from '../src/lib/consent';
import { parseIntent } from '../src/routes/twilio-webhook';
import type { Env } from '../src/types';

/**
 * Contact Consent tripwires.
 *
 * Two things are pinned here and they protect different people:
 *  1. The exact A2P copy. These strings were filed with Twilio for campaign
 *     registration; the live behaviour and the filing must stay byte-identical or
 *     the campaign is rejected again (it already has been, twice). A silent reword
 *     breaks the paperwork, not just the prose.
 *  2. The gate default. The consent gate must ship OFF, so the infrastructure can be
 *     verified live before a single real contact is cut off from delivery. A flipped
 *     default would arm the gate on deploy and silence unconfirmed contacts with no
 *     warning — the exact zero-protection window the rollout plan avoids.
 */

describe('A2P message copy is verbatim — do not reword', () => {
  it('the confirmation ask matches the filed Call-to-Action exactly', () => {
    expect(confirmationAsk('Alex')).toBe(
      'BLACK BOX: Alex added you as a safety contact. You may receive an alert if they activate the app. Reply YES to confirm, NO to decline. Msg&data rates may apply.',
    );
  });

  it('the YES reply names the survivor and discloses HELP + STOP', () => {
    const r = confirmedReply('Alex');
    expect(r).toBe("BLACK BOX: You're confirmed as Alex's safety contact. Reply HELP for info, STOP to opt out anytime.");
  });

  it('the NO reply promises no further messages', () => {
    expect(declinedReply('Alex')).toBe(
      'BLACK BOX: Understood — you will not receive alerts from Alex. No further messages will be sent.',
    );
  });

  it('HELP reply discloses purpose, YES/STOP, and rates', () => {
    const r = helpReply();
    expect(r).toMatch(/BLACK BOX/);
    expect(r).toMatch(/STOP/);
    expect(r).toMatch(/Msg&data rates may apply/);
  });
});

describe('the consent gate ships OFF (infra first, gate last)', () => {
  const env = (v?: string): Env => ({ CONSENT_GATE_ENFORCED: v }) as unknown as Env;

  it('is disabled when the flag is unset', () => {
    expect(consentGateEnforced(env(undefined))).toBe(false);
  });

  it('is disabled for anything other than the exact string "true"', () => {
    for (const v of ['', 'false', 'TRUE', '1', 'yes', 'on']) {
      expect(consentGateEnforced(env(v)), `"${v}" must not arm the gate`).toBe(false);
    }
  });

  it('arms ONLY on the exact string "true"', () => {
    expect(consentGateEnforced(env('true'))).toBe(true);
  });
});

/**
 * Inbound reply parsing. The danger is BOTH directions: reading consent from a
 * reply that wasn't a yes (silence-is-not-consent, and neither is "maybe"), and
 * failing to read a clear yes/no/stop. First-token only, so trailing words are fine.
 */
describe('inbound reply intent', () => {
  it('confirms on YES / Y, case-insensitive, with trailing words', () => {
    for (const b of ['YES', 'yes', 'Yes', 'y', 'Y', 'yes please', 'YES!', 'yeah', 'confirm']) {
      expect(parseIntent(b), `"${b}" should confirm`).toBe('confirm');
    }
  });

  it('declines on NO / N', () => {
    for (const b of ['NO', 'no', 'n', 'N', 'no thanks', 'nope', 'decline']) {
      expect(parseIntent(b), `"${b}" should decline`).toBe('decline');
    }
  });

  it('treats STOP and carrier synonyms as opt-out', () => {
    for (const b of ['STOP', 'stop', 'Stop', 'UNSUBSCRIBE', 'CANCEL', 'QUIT', 'END']) {
      expect(parseIntent(b), `"${b}" should be stop`).toBe('stop');
    }
  });

  it('routes HELP / INFO to help', () => {
    expect(parseIntent('HELP')).toBe('help');
    expect(parseIntent('info')).toBe('help');
  });

  it('does NOT infer consent from an ambiguous reply — silence/maybe is not yes', () => {
    for (const b of ['', 'maybe', 'ok', 'sure', 'who is this', 'what', '?', 'later', 'k']) {
      expect(parseIntent(b), `"${b}" must NOT confirm`).not.toBe('confirm');
      expect(parseIntent(b)).toBe('unknown');
    }
  });
});
