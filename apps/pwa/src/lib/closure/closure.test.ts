import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Brief 19 §6 tripwire: the closure pin is an ON-DEVICE intent tool and is NEVER
 * transmitted — only the resulting status (sat/unsat) leaves the device. These
 * tests assert the entered digits never appear in any request body.
 */
vi.mock('@/lib/env', () => ({ API_BASE_URL: 'http://test', uploadsEnabled: true }));
vi.mock('@/lib/log', () => ({ log: { error: vi.fn() } }));
vi.mock('@/lib/storage', () => ({ getActiveSession: vi.fn(), getStoredClosurePin: vi.fn() }));
vi.mock('@/lib/crypto/pin', () => ({ evalClosurePin: vi.fn() }));
vi.mock('@blackbox/shared', () => ({
  signRequest: vi.fn(async () => ({ 'X-Event-Id': 'e1', 'X-Timestamp': '1', 'X-Signature': 'sig' })),
}));

import { submitClosure } from './index';
import { getActiveSession, getStoredClosurePin } from '@/lib/storage';
import { evalClosurePin } from '@/lib/crypto/pin';

describe('closure pin is never transmitted (only status leaves the device)', () => {
  let bodies: string[];
  beforeEach(() => {
    bodies = [];
    vi.mocked(getActiveSession).mockResolvedValue({ status: 'active', eventId: 'e1', hmacSecret: 'x'.repeat(64) } as never);
    vi.mocked(getStoredClosurePin).mockResolvedValue('531' as never);
    global.fetch = vi.fn(async (_url: unknown, opts: { body?: BodyInit }) => {
      bodies.push(new TextDecoder().decode(opts.body as Uint8Array));
      return { ok: true } as Response;
    }) as typeof fetch;
  });

  it('correct pin (sat): posts only {status, reasonSecured} — entered digits absent', async () => {
    vi.mocked(evalClosurePin).mockResolvedValue('sat');
    const r = await submitClosure('531', 'heading home');
    expect(r).toBe('awaiting');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('531'); // the pin value must never appear
    const parsed = JSON.parse(bodies[0]);
    expect(Object.keys(parsed).sort()).toEqual(['reasonSecured', 'status']);
    expect(parsed.status).toBe('sat');
  });

  it('duress (unsat): also posts no pin, only status', async () => {
    vi.mocked(evalClosurePin).mockResolvedValue('duress');
    await submitClosure('538', '');
    expect(bodies[0]).not.toContain('538');
    expect(JSON.parse(bodies[0]).status).toBe('unsat');
  });

  it('typo (wrong): sends NOTHING to the network', async () => {
    vi.mocked(evalClosurePin).mockResolvedValue('wrong');
    const r = await submitClosure('999', '');
    expect(r).toBe('wrong');
    expect(bodies).toHaveLength(0);
  });
});
