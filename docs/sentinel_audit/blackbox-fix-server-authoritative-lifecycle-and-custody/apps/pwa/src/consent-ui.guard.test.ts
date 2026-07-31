import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contact Consent §0a + §6 tripwire.
 *
 * §0a is a NEW failure class for this brief: consent/armed state leaking into the
 * Hidden facade. The covert screen must stay byte-identical whether the account is
 * Armed, Not Ready, or has a pending contact — an "Armed"/"Not Ready" badge or a
 * "contact pending" line on the covert screen is a tell in front of an aggressor,
 * which is the one thing the facade exists to prevent. Consent status lives in
 * Settings/Visible only.
 *
 * §6 pins the A2P Call-to-Action copy: the add screen must state, in the UI, that
 * the contact is texted to confirm before they can be notified — that screen is the
 * evidence attached to the Twilio campaign resubmission.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

describe('§0a the Hidden facade shows no consent or armed state', () => {
  const facades = [
    './routes/meditation/MeditationHome.tsx',
    './routes/meditation/BreathingCircles.tsx',
    './routes/meditation/HoldProgressRing.tsx',
  ];

  it('no facade surface renders consent status, Armed/Not-Ready, or contact wording', () => {
    for (const f of facades) {
      const src = read(f);
      expect(src, `${f} must not show armed state`).not.toMatch(/Not ready|Armed|pending|confirmed/i);
      expect(src, `${f} must not read contact status`).not.toMatch(/\.status|deliverableChannels|\.armable/);
      expect(src, `${f} must not mention notifying/consent`).not.toMatch(/notified|safety contact|confirm/i);
    }
  });
});

describe('§6 the add screen carries the A2P Call-to-Action', () => {
  const form = read('./components/ContactForm.tsx');

  it('states that the contact is texted to confirm before being notified', () => {
    expect(form).toMatch(/receive a text asking them to confirm before they can be notified/i);
  });

  it('discloses STOP-to-opt-out and message rates', () => {
    expect(form).toMatch(/STOP/);
    expect(form).toMatch(/rates may apply/i);
  });
});

describe('§5 the add screen carries the A2P opt-in consent line at the point of entry', () => {
  const form = read('./components/ContactForm.tsx');

  // Carriers rejected the A2P campaign on opt-in information. The consent line must
  // be the exact wording, adjacent to the phone-number field, screenshot-able. Each
  // clause is a distinct carrier requirement, so each is pinned independently.
  it('states the consent affirmation tied to adding the contact', () => {
    expect(form).toMatch(/you confirm they consent to receive BLACK BOX safety text messages/i);
  });

  it('discloses message frequency (the clause the rejection cited)', () => {
    expect(form).toMatch(/Message frequency varies/i);
  });

  it('discloses message & data rates and STOP-to-opt-out', () => {
    expect(form).toMatch(/Message and data rates may apply/i);
    expect(form).toMatch(/Reply STOP to opt out/i);
  });

  it('renders the consent line only for the SMS channel', () => {
    // The clause lives inside a channel === 'sms' guard, not unconditionally.
    expect(form).toMatch(/channel === 'sms'[\s\S]*consent to receive BLACK BOX safety text messages/i);
  });
});

describe('§0/§1 consent status is surfaced in Settings, not invented client-side', () => {
  const tabs = read('./routes/settings/ContactTabs.tsx');

  it('reads status from the server slot, and shows Pending/Confirmed', () => {
    expect(tabs).toMatch(/status/);
    expect(tabs).toMatch(/Pending/);
    expect(tabs).toMatch(/Armed|Not ready/);
  });

  it('the retired secondary/tertiary slots are gone from the contact set', () => {
    // The addable contact set is exactly [primary]; the grid adds guardian+emergency.
    expect(tabs).toContain("const CONTACT_SLOTS: SlotKey[] = ['primary']");
    expect(tabs).not.toMatch(/CONTACT_SLOTS: SlotKey\[\] = \['primary', 'secondary', 'tertiary'\]/);
  });
});
