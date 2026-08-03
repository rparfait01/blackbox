import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { stripComments } from '../../../test-utils/guard-source.mjs';

const CH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'channels');
/** Comment-stripped — every assertion here is about BEHAVIOUR (test-utils/guard-source.mjs). */
const code = (f: string): string => stripComments(readFileSync(join(CH, f), 'utf8'));

/**
 * Brief 35 Fix B §A — EVERY provider boundary is gated, or the control does not exist.
 *
 * One ungated `fetch` to a provider is the whole gap re-opened, and it would be invisible: the
 * other channels would suppress correctly and the delivery rows would look right. So the check is
 * mechanical — enumerate the outbound calls in the channels directory and require each to sit
 * behind the gate.
 */
describe('no provider can be reached without passing the environment gate', () => {
  const files = readdirSync(CH).filter((f) => f.endsWith('.ts'));

  it('every channel file that calls a provider consults mayDispatchExternally', () => {
    const ungated: string[] = [];
    for (const f of files) {
      const src = code(f);
      // A provider call is an outbound fetch to an absolute https endpoint.
      const callsProvider = /await fetch\(\s*(PUSH_ENDPOINT|SEND_ENDPOINT|`https:|'https:|"https:)/.test(src);
      if (callsProvider && !/mayDispatchExternally/.test(src)) ungated.push(f);
    }
    expect(ungated, `these reach a provider without the environment gate: ${ungated.join(', ')}`).toEqual([]);
  });

  it('the gate is consulted BEFORE the provider call in each channel', () => {
    for (const f of ['sendgrid-email.ts', 'twilio-sms.ts', 'line.ts']) {
      const src = code(f);
      const gate = src.indexOf('mayDispatchExternally');
      const call = src.search(/await fetch\(\s*(PUSH_ENDPOINT|SEND_ENDPOINT|`https:)/);
      expect(gate, `${f}: gate missing`).toBeGreaterThan(-1);
      expect(gate, `${f}: gate must precede the provider call`).toBeLessThan(call);
    }
  });

  it('§E1/§E2 — the two suppressions stay distinguishable in the record', () => {
    // `suppressed_test` means this identity can reach no real person. `suppressed_environment`
    // means this deployment can reach no provider at all. An acceptance has to know which to
    // expect where, so they must never collapse into one string.
    const reserved = code('reserved.ts');
    expect(reserved).toMatch(/SUPPRESSED_ENVIRONMENT_REASON = 'suppressed_environment'/);
    expect(reserved).toMatch(/SUPPRESSED_REASON/);
    expect(code('sendgrid-email.ts')).toMatch(/SUPPRESSED_ENVIRONMENT_REASON/);
  });

  it('§A — a suppressed send records the payload it WOULD have sent', () => {
    // So staging acceptance can assert on content without transmitting it.
    for (const f of ['sendgrid-email.ts', 'twilio-sms.ts', 'line.ts']) {
      expect(code(f), `${f} must record wouldHaveSent`).toMatch(/wouldHaveSent/);
    }
  });

  it('§E4 — there is no bypass', () => {
    // No flag, header, query parameter or argument re-enables external dispatch in a
    // non-production environment.
    for (const f of files) {
      const src = code(f);
      expect(src, `${f}`).not.toMatch(/FORCE_DISPATCH|ALLOW_EXTERNAL|SKIP_ENV_GATE|bypassEnvironment/i);
    }
  });
});
