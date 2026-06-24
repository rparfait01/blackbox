import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Brief 15 §E2 tripwire: closure is a gesture, evaluated ON-DEVICE; only the
 * resulting status (sat | unsat) is transmitted — never the gesture timing,
 * never a pin. And the §E2 invariant: a clean hold and a duress release are
 * indistinguishable to the device (both return 'awaiting').
 */
vi.mock('@/lib/env', () => ({ API_BASE_URL: 'http://test', uploadsEnabled: true }));
vi.mock('@/lib/log', () => ({ log: { error: vi.fn() } }));
vi.mock('@/lib/storage', () => ({ getActiveSession: vi.fn() }));
vi.mock('@blackbox/shared', () => ({
  signRequest: vi.fn(async () => ({ 'X-Event-Id': 'e1', 'X-Timestamp': '1', 'X-Signature': 'sig' })),
}));

import { submitClosureGesture } from './index';
import { getActiveSession } from '@/lib/storage';

describe('closure gesture sends status only (never a pin)', () => {
  let bodies: string[];
  beforeEach(() => {
    bodies = [];
    vi.mocked(getActiveSession).mockResolvedValue({
      status: 'active',
      eventId: 'e1',
      hmacSecret: 'x'.repeat(64),
    } as never);
    global.fetch = vi.fn(async (_url: unknown, opts: { body?: BodyInit }) => {
      bodies.push(new TextDecoder().decode(opts.body as Uint8Array));
      return { ok: true } as Response;
    }) as typeof fetch;
  });

  it('clean hold sends status "sat" and returns awaiting', async () => {
    const result = await submitClosureGesture(true, 'home now');
    expect(result).toBe('awaiting');
    expect(bodies).toHaveLength(1);
    const sent = JSON.parse(bodies[0]);
    expect(sent.status).toBe('sat');
    expect(sent.reasonSecured).toBe('home now');
    // Nothing resembling a pin or gesture timing leaves the device.
    expect(bodies[0]).not.toMatch(/pin|digit|hold|elapsed|duration/i);
  });

  it('duress release sends status "unsat" and returns awaiting (identical verdict)', async () => {
    const result = await submitClosureGesture(false, '');
    expect(result).toBe('awaiting');
    const sent = JSON.parse(bodies[0]);
    expect(sent.status).toBe('unsat');
  });

  it('§E2 invariant: clean and duress both return the same device verdict', async () => {
    const clean = await submitClosureGesture(true, '');
    const duress = await submitClosureGesture(false, '');
    expect(clean).toBe(duress); // both 'awaiting' — device cannot reveal which
  });

  it('no active session → no request sent', async () => {
    vi.mocked(getActiveSession).mockResolvedValue(null as never);
    const result = await submitClosureGesture(true, '');
    expect(result).toBe('no-session');
    expect(bodies).toHaveLength(0);
  });
});
