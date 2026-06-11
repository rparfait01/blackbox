import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gear } from '@phosphor-icons/react';

import { ACTIVATION_HOLD_MS } from '@/lib/env';
import { formatElapsed } from '@/lib/time';
import { triggerActivation } from '@/lib/activation';
import { BreathingCircles } from './BreathingCircles';
import { HoldProgressRing } from './HoldProgressRing';
import { useActivationHold } from './use-activation-hold';
import { useEndSessionPress } from './use-end-session-press';
import { PinEntryOverlay } from './PinEntryOverlay';

/**
 * Stillpoint — the entire visible surface of the app. Nothing here references
 * BLACK BOX, safety, or emergency.
 *
 * A deliberate press-and-hold on the breathing circle is a covert activation
 * trigger. Completing the hold produces NO visible output: no navigation, no
 * screen change, no toast. The meditation view simply continues — and there is
 * no on-device feedback at any later point in the session either. BLACK BOX
 * records and reaches; it does not reassure.
 *
 * The gear and "End session" controls are ordinary meditation-app affordances.
 * The gear opens preferences. "End session" carries the W6 covert closure
 * gesture: a quick TAP resets the timer (the W2 behavior), while a deliberate
 * long HOLD opens the disguised pin-entry overlay — the only way to request
 * closure. The hold does not reset the timer; only the tap does.
 */
export function MeditationHome(): JSX.Element {
  const sessionStart = useRef<number>(performance.now());
  const [sessionMs, setSessionMs] = useState(0);
  const [pinOpen, setPinOpen] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => {
      setSessionMs(performance.now() - sessionStart.current);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const { progress, handlers } = useActivationHold(ACTIVATION_HOLD_MS, () => {
    // Covert trigger fired. Start the recording session. No visible output by
    // design — the meditation view continues unchanged.
    void triggerActivation('stillpoint-press');
  });

  const resetTimer = (): void => {
    // Tap behavior (W2): reset the visible timer. Stillpoint behaves exactly
    // like a normal meditation app ending a session. Any underlying recording
    // continues untouched: this does NOT stop capture, geolocation, or the
    // sessions row.
    sessionStart.current = performance.now();
    setSessionMs(0);
  };

  const { progress: endHoldProgress, handlers: endHandlers } = useEndSessionPress(resetTimer, () =>
    setPinOpen(true),
  );

  return (
    <main className="stillpoint-bg animate-hue-drift motion-reduce:animate-none relative flex h-full w-full select-none flex-col items-center justify-center overflow-hidden p-8 text-med-text">
      <Link
        to="/settings"
        aria-label="Preferences"
        className="absolute right-6 top-6 p-2 text-med-text/40 transition-colors hover:text-med-text/70"
      >
        <Gear size={22} weight="light" />
      </Link>

      <h1 className="mb-12 text-center font-serif text-2xl font-light tracking-[0.1em] text-med-text/70">
        Stillpoint
      </h1>

      <div
        className="relative flex h-60 w-60 touch-none select-none items-center justify-center [-webkit-touch-callout:none] [-webkit-user-select:none]"
        {...handlers}
      >
        <HoldProgressRing progress={progress} />
        <BreathingCircles />
        <span className="animate-breath-label motion-reduce:animate-none pointer-events-none relative z-10 select-none font-serif text-lg font-light uppercase tracking-[0.3em] text-med-text">
          Breathe
        </span>
      </div>

      <div className="mt-12 text-center">
        <div className="font-serif text-[32px] font-light tracking-[0.05em] text-med-text/70">
          {formatElapsed(sessionMs)}
        </div>
        <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.15em] text-med-text/40">
          Session in progress
        </div>
      </div>

      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center">
        <button
          type="button"
          {...endHandlers}
          className="touch-none select-none font-serif text-base font-light tracking-[0.2em] text-med-text/40 transition-colors hover:text-med-text/70"
        >
          End session
        </button>
        {/* Subtle filling line: the only feedback during the closure hold. It
            reads as a press ripple, not a progress bar. */}
        <div className="mt-2 h-px w-24 overflow-hidden">
          <div
            className="h-full bg-med-text/50"
            style={{ width: `${endHoldProgress * 100}%` }}
          />
        </div>
      </div>

      <PinEntryOverlay open={pinOpen} onClose={() => setPinOpen(false)} />
    </main>
  );
}
