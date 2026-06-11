import { useState } from 'react';
import { Backspace } from '@phosphor-icons/react';

/**
 * A 4-digit numeric pad with a dot display. Calls `onComplete` once four digits
 * are entered, then clears for the next entry. Used for setting / confirming the
 * session lock code and the backup (duress) code. Styled in the Stillpoint
 * language so it reads identically in covert and direct contexts.
 */
export function PinPad({
  onComplete,
  resetKey,
}: {
  onComplete: (code: string) => void;
  /** Change this to force the pad to clear (e.g. between enter and confirm). */
  resetKey?: string | number;
}): JSX.Element {
  const [digits, setDigits] = useState('');

  const press = (d: string): void => {
    setDigits((cur) => {
      if (cur.length >= 4) {
        return cur;
      }
      const next = cur + d;
      if (next.length === 4) {
        // Defer so the fourth dot paints before we hand the code up.
        window.setTimeout(() => {
          onComplete(next);
          setDigits('');
        }, 120);
      }
      return next;
    });
  };

  // Clearing when resetKey changes, via a keyed render in the parent, keeps this
  // simple; we also clear locally after completion above.
  void resetKey;

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  return (
    <div>
      <div className="mb-8 flex items-center justify-center gap-4">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`h-3.5 w-3.5 rounded-full border transition-colors ${
              i < digits.length ? 'border-med-text/80 bg-med-text/80' : 'border-med-text/30'
            }`}
          />
        ))}
      </div>
      <div className="mx-auto grid max-w-[16rem] grid-cols-3 gap-x-8 gap-y-4">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => press(k)}
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-full font-serif text-2xl font-light text-med-text/80 transition-colors hover:bg-med-text/10"
          >
            {k}
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
          aria-label="Delete"
          onClick={() => setDigits((c) => c.slice(0, -1))}
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-full text-med-text/50 transition-colors hover:bg-med-text/10"
        >
          <Backspace size={24} weight="light" />
        </button>
      </div>
    </div>
  );
}
