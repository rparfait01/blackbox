import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gear } from '@phosphor-icons/react';

import { ACTIVATION_HOLD_MS } from '@/lib/env';
import { formatElapsed } from '@/lib/time';
import { triggerActivation } from '@/lib/activation';
import { useActiveAlert, useActiveAlertStart } from '@/lib/active-alert';
import { BreathingCircles } from './BreathingCircles';
import { HoldProgressRing } from './HoldProgressRing';
import { useActivationHold } from './use-activation-hold';
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
  const [pinOpen, setPinOpen] = useState(false);
  // Settings is locked during an active alert (Fix Brief 8 P0). Covert: the gear
  // simply does nothing (no message that would reveal the lockdown to an aggressor).
  const alertActive = useActiveAlert();
  // The big readout is an ordinary clock when dormant and an elapsed timer
  // (counting from activation) when an alert is live — the covert facade never
  // changes shape, only what the number means. Reverts to the clock on close.
  const alertStart = useActiveAlertStart();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const clockText = new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const { progress, handlers } = useActivationHold(ACTIVATION_HOLD_MS, () => {
    // Covert trigger fired. Start the recording session. No visible output by
    // design — the meditation view continues unchanged.
    void triggerActivation('stillpoint-press');
  });

  return (
    <main className="stillpoint-bg animate-hue-drift motion-reduce:animate-none relative flex h-full w-full select-none flex-col items-center justify-center overflow-hidden p-8 text-med-text">
      {alertActive ? (
        <span
          aria-hidden="true"
          className="absolute right-6 top-6 p-2 text-med-text/40"
        >
          <Gear size={22} weight="light" />
        </span>
      ) : (
        <Link
          to="/settings"
          aria-label="Preferences"
          className="absolute right-6 top-6 p-2 text-med-text/40 transition-colors hover:text-med-text/70"
        >
          <Gear size={22} weight="light" />
        </Link>
      )}

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
          {alertStart != null ? formatElapsed(now - alertStart) : clockText}
        </div>
        <div className="mt-2 h-4 font-mono text-[11px] uppercase tracking-[0.15em] text-med-text/40">
          {alertStart != null ? 'Session in progress' : ''}
        </div>
      </div>

      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center">
        {/* End session opens the disguised "session lock code" entry — the same
            verified stand-down code path as overt (Fix Brief 4 S4). It never
            silently ends the session. */}
        <button
          type="button"
          onClick={() => setPinOpen(true)}
          className="select-none font-serif text-base font-light tracking-[0.2em] text-med-text/40 transition-colors hover:text-med-text/70"
        >
          End session
        </button>
      </div>

      <PinEntryOverlay open={pinOpen} onClose={() => setPinOpen(false)} />
    </main>
  );
}
