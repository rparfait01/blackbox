/**
 * Message-builder unit checks (Brief 19). These are part of the standing
 * regression suite — pure-function tripwires that run on every commit. The first
 * entry locks the "I'M OK" location as a real, tappable map link (it regressed to
 * bare, unclickable coordinates). Every future content bug adds a check here.
 */
import { describe, expect, it } from 'vitest';

import { checkinMessage } from '../src/channels/messages';
import { emailActivation, emailCheckin, mapLink } from '../src/channels/email-messages';

const LOC = { lat: 35.681236, lon: 139.767125 };

// The href's `&` is HTML-escaped to `&amp;` (correct HTML — the browser decodes it
// back to `&`), so match the link with the `&` optionally escaped.
const hrefRe = (lat: number, lon: number): RegExp =>
  new RegExp(`href="https://www\\.google\\.com/maps/search/\\?api=1&(amp;)?query=${lat.toFixed(5)},${lon.toFixed(5)}"`);

describe('"I\'M OK" check-in location is a working map link, not bare coordinates', () => {
  it('email check-in renders a clickable Google Maps link', () => {
    const email = emailCheckin({ userDisplayName: 'Royce', time: '18:30', location: LOC });
    const url = mapLink(LOC.lat, LOC.lon);
    expect(url).toMatch(/^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
    expect(email.html).toMatch(hrefRe(LOC.lat, LOC.lon)); // an actual <a> link in the HTML
    expect(email.text).toContain(url); // and a real (unescaped) URL in the plain-text part
  });

  it('LINE check-in includes a tappable maps URL (auto-linked by LINE)', () => {
    const msg = checkinMessage({ userDisplayName: 'Royce', time: '18:30', location: LOC });
    const text = (msg.messages[0] as { text: string }).text;
    expect(text).toContain('https://www.google.com/maps/search/?api=1&query=');
    expect(msg.fallback).toContain('maps/search');
  });

  it('check-in with no location does NOT emit a link', () => {
    const email = emailCheckin({ userDisplayName: 'Royce', time: '18:30', location: null });
    expect(email.html).not.toContain('maps/search');
  });
});

describe('emergency alert location is also a map link', () => {
  it('activation email Where is a clickable map link when a fix exists', () => {
    const email = emailActivation({
      userDisplayName: 'Royce',
      dashboardUrl: 'https://x/c/1?t=2',
      audioUrl: 'https://x/a',
      location: LOC,
      threatSummary: null,
      emergency: null,
    });
    expect(email.html).toMatch(hrefRe(LOC.lat, LOC.lon));
  });
});
