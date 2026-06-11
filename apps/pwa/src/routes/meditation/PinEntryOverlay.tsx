import { useEffect, useState } from 'react';
import { Backspace } from '@phosphor-icons/react';

import { submitClosurePin } from '@/lib/closure';

/**
 * Disguised closure pin entry (W6). Presents as a meditation app's "session lock
 * code" prompt: soft serif, no BLACK BOX wordmark, no "closure" or "emergency"
 * language. Slides up from the bottom.
 *
 * On four digits entered:
 *  - active session  → close-request is sent; the panel shows "Awaiting
 *    confirmation…" (still meditation-app language). Normal and duress pins look
 *    identical here, by design.
 *  - wrong pin       → the dots clear silently; the user may try again.
 *  - no session      → the overlay closes silently (a tap already happened on
 *    the long-press start; the timer is untouched).
 */
export function PinEntryOverlay({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const [digits, setDigits] = useState('');
  const [awaiting, setAwaiting] = useState(false);

  // Mount, then transition in on the next frame so the slide-up always plays.
  useEffect(() => {
    if (open) {
      setMounted(true);
      setDigits('');
      setAwaiting(false);
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const id = window.setTimeout(() => setMounted(false), 300);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (digits.length !== 4 || awaiting) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await submitClosurePin(digits);
      if (cancelled) {
        return;
      }
      if (result === 'submitted') {
        setAwaiting(true);
      } else if (result === 'no-session') {
        onClose();
      } else {
        // wrong pin: clear silently, allow another attempt
        setDigits('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [digits, awaiting, onClose]);

  if (!mounted) {
    return null;
  }

  const press = (digit: string): void => {
    setDigits((current) => (current.length < 4 ? current + digit : current));
  };
  const backspace = (): void => setDigits((current) => current.slice(0, -1));

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
              Awaiting confirmation…
            </p>
          </div>
        ) : (
          <>
            <p className="mb-8 text-center font-serif text-lg font-light tracking-[0.08em] text-med-text/70">
              Enter your session lock code
            </p>

            <div className="mb-10 flex items-center justify-center gap-4">
              {[0, 1, 2, 3].map((i) => (
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
                  className="mx-auto flex h-14 w-14 items-center justify-center rounded-full font-serif text-2xl font-light text-med-text/80 transition-colors hover:bg-med-text/10"
                >
                  {key}
                </button>
              ))}
              <span />
              <button
                type="button"
                onClick={() => press('0')}
                className="mx-auto flex h-14 w-14 items-center justify-center rounded-full font-serif text-2xl font-light text-med-text/80 transition-colors hover:bg-med-text/10"
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
          </>
        )}
      </div>
    </div>
  );
}
