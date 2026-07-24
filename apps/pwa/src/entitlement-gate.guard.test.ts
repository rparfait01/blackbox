import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Brief 28 §6 — the entitlement paywall gates ARM, NEVER the trigger.
 *
 * These are the §0 tripwires. Read as source so any future edit that sneaks an
 * entitlement/paywall/price check into the trigger, capture, or dispatch path — or that
 * makes arming/firing require a network round-trip, or that renders a price to an
 * activated/org-sourced account, or that puts a price in the Hidden facade — fails here
 * instead of shipping.
 *
 * NOTE on the grep terms: the alarm domain has always called triggering "activation",
 * so we do NOT grep for "activat" (it collides). The paywall vocabulary is
 * entitle / paywall / price / purchase / checkout — none of which belong anywhere near
 * the trigger.
 */
const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');
const readWorker = (p: string): string =>
  readFileSync(join(SRC, '..', '..', '..', 'workers', 'api', 'src', p), 'utf8');

// Paywall vocabulary that must NEVER appear in the trigger/capture/dispatch path.
const PAYWALL = /\b(entitle|entitled|entitlement|paywall|price|purchase|checkout)\b/i;

describe('§0 the client trigger/capture/dispatch path has zero paywall checks', () => {
  const files = [
    './lib/activation/index.ts',
    './lib/activation/heartbeat.ts',
    './lib/activation/session-monitor.ts',
    './lib/use-double-tap.ts',
    './lib/capture/config.ts',
    './lib/capture/media-capture.ts',
    './lib/geolocation/location-tracker.ts',
  ];
  for (const f of files) {
    it(`${f} contains no entitlement/paywall/price/purchase/checkout token`, () => {
      expect(read(f)).not.toMatch(PAYWALL);
    });
  }

  it('the disc dispatches to the core unconditionally — no entitlement gate on the tap', () => {
    const vis = read('./routes/blackbox/BlackBoxHome.tsx');
    expect(vis).toContain("useDoubleTap(() => void triggerAlert('direct-tap'))");
    // The tap is never disabled or short-circuited by entitlement / the gate.
    expect(vis).not.toMatch(/disabled=\{[^}]*(entitled|gated)/);
    expect(vis).not.toMatch(/if \(gated\)\s*\{?\s*return/);
  });
});

describe('§0 the server trigger path (POST /v1/events) reads no entitlement', () => {
  const index = readWorker('index.ts');
  // Slice the event-open handler generously and assert entitlement never appears in it.
  const start = index.indexOf("app.post('/v1/events'");
  const handler = index.slice(start, start + 4500);

  it('the handler slice never references entitlement', () => {
    expect(start).toBeGreaterThan(-1);
    expect(handler).not.toMatch(/entitle/i);
    expect(handler).not.toMatch(/isEntitled/);
  });

  it('THE BUTTON ALWAYS FIRES — the deliverable check is recording-only, not a gate', () => {
    expect(handler).toContain('THE BUTTON ALWAYS FIRES');
  });
});

describe('§2 entitlement is offline-durable — no network to arm or fire', () => {
  const auth = read('./lib/auth.ts');

  it('the cache is read from localStorage, not fetched', () => {
    expect(auth).toContain('export function getCachedEntitlement');
    expect(auth).toMatch(/getCachedEntitlement[\s\S]*?localStorage|get\(ENTITLEMENT_KEY\)/);
  });

  it('the cache never re-locks: once activated it is never overwritten to unactivated', () => {
    // Monotonic mirror of the server's no-re-lock guarantee (§0).
    expect(auth).toMatch(/getCachedEntitlement\(\)\.status === 'activated' && next\.status !== 'activated'/);
  });

  it('an empty cache is UNKNOWN, not unactivated (so it can fail open)', () => {
    expect(auth).toMatch(/return \{ status: 'unknown', source: null \}/);
  });

  it('the arm gate FAILS OPEN on unknown — an offline reinstall is never locked out', () => {
    // mayArmByCache returns true unless the server CONFIRMED unactivated.
    expect(auth).toMatch(/export function mayArmByCache/);
    expect(auth).toMatch(/getCachedEntitlement\(\)\.status !== 'unactivated'/);
  });

  it('the home gate keys ONLY on a server-confirmed unactivated (unknown → armed)', () => {
    const vis = read('./routes/blackbox/BlackBoxHome.tsx');
    expect(vis).toMatch(/useState\(\(\) => getCachedEntitlement\(\)\.status === 'unactivated'\)/);
    expect(vis).toContain('const armable = !gated && hasRecipient');
  });
});

describe('§2 an activated / org-sourced account never sees a price', () => {
  const activation = read('./routes/blackbox/Activation.tsx');
  const home = read('./routes/blackbox/BlackBoxHome.tsx');

  it('the activation screen redirects an already-activated account away (no price shown)', () => {
    expect(activation).toMatch(/getCachedEntitlement\(\)\.status === 'activated'[\s\S]*?Navigate to="\/blackbox"/);
  });

  it('the home activation prompt shows ONLY when server-confirmed unactivated', () => {
    expect(home).toContain('{gated ? (');
  });
});

describe('§0a the Hidden facade carries no price/paywall/purchase — no tell', () => {
  const facades = [
    './routes/meditation/MeditationHome.tsx',
    './routes/meditation/BreathingCircles.tsx',
    './routes/meditation/HoldProgressRing.tsx',
  ];
  for (const f of facades) {
    it(`${f} shows no paywall vocabulary`, () => {
      expect(read(f)).not.toMatch(PAYWALL);
    });
  }
});
