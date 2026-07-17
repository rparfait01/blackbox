import { describe, expect, it } from 'vitest';

import { destinationProblem, normalizeDestination } from '../src/lib/guardians';

/**
 * SMS destination tripwire.
 *
 * The failure being prevented: a survivor adds their contact's phone number, the
 * app says "saved", and the first anyone learns it was malformed is Twilio
 * rejecting the alert — mid-emergency, when there is no chance to fix it. The save
 * is the only moment a bad number can be caught while it still costs nothing.
 *
 * Twilio delivers reliably to E.164 only. A local-format number is genuinely
 * ambiguous (the same digits are a different person in another country), so it is
 * refused rather than guessed at — guessing would mean an alert going to a
 * stranger, or nowhere.
 */
describe('SMS numbers must be E.164 before they are stored', () => {
  it('accepts real international numbers, however the user punctuates them', () => {
    // All of these normalize to the same deliverable E.164 value.
    for (const input of [
      '+819012345678',
      '+81 90 1234 5678',
      '+81-90-1234-5678',
      '+81 (90) 1234-5678',
      '  +819012345678  ',
    ]) {
      expect(destinationProblem('sms', input), `rejected a valid number: ${input}`).toBeNull();
      expect(normalizeDestination('sms', input)).toBe('+819012345678');
    }
    expect(destinationProblem('sms', '+15551234567')).toBeNull();
  });

  it('refuses a number with no country code — and says exactly what to do', () => {
    // The JP pilot's most likely mistake: typing the local mobile format.
    const problem = destinationProblem('sms', '090-1234-5678');
    expect(problem).toBeTruthy();
    expect(problem).toMatch(/country code/i);
    // The message must show the fix, not just name the error.
    expect(problem).toMatch(/\+81/);
  });

  it('refuses text that is not a phone number at all', () => {
    // normalizePhone strips every non-digit, so this used to be stored as "".
    expect(destinationProblem('sms', 'hello')).toBeTruthy();
    expect(destinationProblem('sms', '')).toBeTruthy();
    expect(destinationProblem('sms', '+')).toBeTruthy();
  });

  it('refuses numbers that are too short or too long to be real (E.164 bounds)', () => {
    expect(destinationProblem('sms', '+1234')).toBeTruthy(); // too short
    expect(destinationProblem('sms', '+1234567890123456')).toBeTruthy(); // 16 digits, over the max
    expect(destinationProblem('sms', '+0123456789')).toBeTruthy(); // country code cannot start with 0
  });

  it('does NOT touch the other channels — LINE-only contacts still need no phone', () => {
    // A LINE contact's destination is a userId, never a number. Nothing here may
    // start demanding a phone from it.
    expect(destinationProblem('line', 'U0123456789abcdef0123456789abcdef')).toBeNull();
    expect(destinationProblem('email', 'someone@example.com')).toBeNull();
  });
});
