import { useEffect, useState } from 'react';
import { Backspace } from '@phosphor-icons/react';

import { reportClosureLockout, submitClosure } from '@/lib/closure';

/**
 * Closure request entry (Brief 9 Phase D), disguised as a meditation "session
 * lock code" prompt. The user enters their 3-digit pin and an explicit SUBMIT —
 * NEVER auto-submitting on the Nth digit. The pin is evaluated on-device and only
 * the status leaves the device; the user can never close the alert themselves.
 *
 * On submit the user always lands on a calm "awaiting confirmation" screen
 * (identical whether the pin was correct or a duress signal), so an onlooker
 * cannot tell a duress signal was sent. A typo says "not recognized, try again";
 * 3 wrong tries trigger a brief lockout.
 */
const MAX = 3;
const MAX_ATTEMPTS = 3;
const LOCKOUT_MS = 30_000;

export function PinEntryOverlay({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const [digits, setDigits] = useState('');
  const [reason, setReason] = useState('');
  const [awaiting, setAwaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setDigits('');
      setReason('');
      setAwaiting(false);
      setError(null);
      setAttempts(0);
      setLockedUntil(0);
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const id = window.setTimeout(() => setMounted(false), 300);
    return () => window.clearTimeout(id);
  }, [open]);

  if (!mounted) {
    return null;
  }

  const locked = Date.now() < lockedUntil;

  const press = (digit: string): void => {
    // Append only; NEVER auto-submit (Brief 9). Submit is an explicit tap.
    setError(null);
    setDigits((current) => (current.length < MAX ? current + digit : current));
  };
  const backspace = (): void => setDigits((current) => current.slice(0, -1));

  const submit = async (): Promise<void> => {
    if (busy || locked || digits.length !== MAX) {
      return;
    }
    setBusy(true);
    const result = await submitClosure(digits, reason.trim());
    setBusy(false);
    if (result === 'awaiting') {
      setAwaiting(true);
    } else if (result === 'no-session') {
      onClose();
    } else if (result === 'no-pin') {
      setError('Set up your closure pin in settings first.');
      setDigits('');
    } else {
      // wrong / typo
      const next = attempts + 1;
      setAttempts(next);
      setDigits('');
      if (next >= MAX_ATTEMPTS) {
        setLockedUntil(Date.now() + LOCKOUT_MS);
        setError('Too many attempts. Please wait a moment and try again.');
        // Surface the lockout to the coordinator (Brief 19 §6) — repeated failures
        // may mean someone other than the user is trying to close. Pin never sent.
        void reportClosureLockout();
      } else {
        setError('Not recognized, try again.');
      }
    }
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-end bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="stillpoint-bg w-full max-w-md rounded-t-3xl px-8 pb-12 pt-10 text-med-text shadow-2xl transition-transform duration-300 ease-out"
        style={{ transform: shown ? 'translateY(0)' : 'translateY(100%)' }}
        onClick={(event) => event.stopPropagation()}
      >
        {awaiting ? (
          <div className="flex min-h-[20rem] flex-col items-center justify-center text-center">
            <p className="animate-breath-label motion-reduce:animate-none font-serif text-xl font-light tracking-[0.1em] text-med-text/80">
              Closure requested — awaiting confirmation…
            </p>
            <p className="mt-4 max-w-xs text-xs leading-relaxed text-med-text/45">
              Your support contact will confirm. This may take a few minutes.
            </p>
          </div>
        ) : (
          <>
            <p className="mb-6 text-center font-serif text-lg font-light tracking-[0.08em] text-med-text/70">
              Request closure
            </p>

            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (optional)"
              className="mb-6 w-full border-b border-med-text/25 bg-transparent py-2 text-center text-sm text-med-text outline-none placeholder:text-med-text/30"
            />

            <div className="mb-8 flex items-center justify-center gap-4">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className={`h-3 w-3 rounded-full border transition-colors ${
                    i < digits.length
                      ? 'border-med-text/70 bg-med-text/70'
                      : 'border-med-text/30 bg-transparent'
                  }`}
                />
              ))}
            </div>

            <div className="mx-auto grid max-w-[16rem] grid-cols-3 gap-y-5 gap-x-8">
              {keys.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => press(key)}
                  disabled={locked}
                  className="mx-auto flex h-14 w-14 items-center justify-center rounded-full font-serif text-2xl font-light text-med-text/80 transition-colors hover:bg-med-text/10 disabled:opacity-40"
                >
                  {key}
                </button>
              ))}
              <span />
              <button
                type="button"
                onClick={() => press('0')}
                disabled={locked}
                className="mx-auto flex h-14 w-14 items-center justify-center rounded-full font-serif text-2xl font-light text-med-text/80 transition-colors hover:bg-med-text/10 disabled:opacity-40"
              >
                0
              </button>
              <button
                type="button"
                onClick={backspace}
                aria-label="Delete"
                className="mx-auto flex h-14 w-14 items-center justify-center rounded-full text-med-text/50 transition-colors hover:bg-med-text/10"
              >
                <Backspace size={24} weight="light" />
              </button>
            </div>

            {error ? <p className="mt-6 text-center text-sm text-status-active">{error}</p> : null}

            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || locked || digits.length !== MAX}
              className="mt-6 w-full rounded-full bg-med-text/90 py-3.5 font-sans text-base font-medium tracking-[0.04em] text-[#1a1f3a] transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy ? 'Submitting…' : 'Submit'}
            </button>

            {/* Explicit back/cancel — never rely on a blind backdrop tap. */}
            <button
              type="button"
              onClick={onClose}
              className="mt-4 block w-full text-center text-sm text-med-text/45 underline"
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
