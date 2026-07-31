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

/**
 * §4 APP-LESS DELIVERY tripwire (notification brief amendment).
 *
 * The contact installs NOTHING. In the seconds that matter, a person who has just
 * been told someone is in danger must be one tap from the live dashboard — not
 * facing an app store, an account setup, or a permissions prompt. So the alert
 * itself must always carry a plain https link that opens in whatever browser they
 * already have.
 *
 * The dashboard is served by the WORKER as HTML (index.ts /c/:id → c.html), so the
 * link needs no client app of ours either. An optional installable coordinator app
 * is an org convenience for high-volume institutions ONLY — it may never become a
 * requirement for delivery. If a future change makes the link app-conditional
 * (a deep link, a custom scheme, an install wall), this fails.
 */
describe('§4 app-less delivery — the alert always carries a browser link', () => {
  const activationPayload = {
    userDisplayName: 'Survivor',
    dashboardUrl: 'https://worker.example/c/evt-1?t=tok',
    summaryUrl: 'https://worker.example/s/evt-1',
    audioUrl: 'https://worker.example/a/evt-1',
    location: LOC,
    threatSummary: null,
    emergency: { police: '110' },
  };

  it('LINE: a tappable https URI action opens the dashboard — no app, no scheme', async () => {
    const { activationAlert } = await import('../src/channels/messages');
    const built = activationAlert('evt-1', activationPayload);
    const json = JSON.stringify(built);
    expect(json).toContain(activationPayload.dashboardUrl);
    // A uri action on a plain https link — not a custom scheme or an app deep link.
    expect(json).toContain('"type":"uri"');
    expect(json).not.toMatch(/blackbox:\/\/|market:\/\/|itms-apps:/);
    // The text fallback (older clients, notifications) must carry the link too.
    expect(built.fallback).toContain(activationPayload.dashboardUrl);
  });

  it('the fallback text is self-sufficient — a bare SMS-style body still reaches the dashboard', async () => {
    const { activationAlert } = await import('../src/channels/messages');
    const built = activationAlert('evt-1', activationPayload);
    // This is what an SMS body will be built from: it must stand alone.
    expect(built.fallback).toMatch(/https:\/\//);
    expect(built.fallback).not.toMatch(/install|download|app store/i);
  });

  it('email activation links to the dashboard in a browser, not an app', () => {
    const built = emailActivation(activationPayload);
    expect(built.html).toContain(activationPayload.dashboardUrl);
    expect(built.text).toContain(activationPayload.dashboardUrl);
    expect(built.html).not.toMatch(/install the app|download the app/i);
  });
});
