import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gear } from '@phosphor-icons/react';

import { ACTIVATION_HOLD_MS } from '@/lib/env';
import { formatElapsed } from '@/lib/time';
import { triggerActivation } from '@/lib/activation';
import { BreathingCircles } from './BreathingCircles';
import { HoldProgressRing } from './HoldProgressRing';
import { useActivationHold } from './use-activation-hold';

/**
 * Stillpoint — the entire visible surface of the app. Nothing here references
 * BLACK BOX, safety, or emergency.
 *
 * A deliberate press-and-hold on the breathing circle is a covert activation
 * trigger. Completing the hold produces NO visible output: no navigation, no
 * screen change, no toast. The meditation view simply continues. In W1 the
 * completion only logs for development verification; W2 attaches the actual
 * recording invocation and the (network-confirmed) haptic acknowledgment.
 *
 * The gear and "End session" controls are ordinary meditation-app affordances.
 * The gear opens preferences; ending the session resets the timer. In a later
 * phase (W6) the same end-session control will branch to the closure-pin flow
 * when a session is active — but in W1 it is a plain timer reset.
 */
export function MeditationHome(): JSX.Element {
  const sessionStart = useRef<number>(performance.now());
  const [sessionMs, setSessionMs] = useState(0);

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

  const endSession = (): void => {
    // Always reset the visible timer — Stillpoint behaves exactly like a normal
    // meditation app ending a session, every time. Any underlying recording
    // continues untouched: this does NOT stop capture, geolocation, or the
    // sessions row. Closure is a separate, non-obvious gesture designed in W6.
    sessionStart.current = performance.now();
    setSessionMs(0);
  };

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
        className="relative flex h-60 w-60 touch-none items-center justify-center"
        {...handlers}
      >
        <HoldProgressRing progress={progress} />
        <BreathingCircles />
        <span className="animate-breath-label motion-reduce:animate-none relative z-10 font-serif text-lg font-light uppercase tracking-[0.3em] text-med-text">
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

      <button
        type="button"
        onClick={endSession}
        className="absolute bottom-8 left-1/2 -translate-x-1/2 font-serif text-base font-light tracking-[0.2em] text-med-text/40 transition-colors hover:text-med-text/70"
      >
        End session
      </button>
    </main>
  );
}
