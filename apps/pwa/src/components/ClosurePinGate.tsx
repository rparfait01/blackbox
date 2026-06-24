import { useEffect, useState } from 'react';

import { hashClosurePin } from '@/lib/crypto/pin';
import { getStoredClosurePin, setStoredClosurePin } from '@/lib/storage';
import { isSetupComplete } from '@/lib/auth';
import { useActiveAlert } from '@/lib/active-alert';
import { PinPad } from '@/components/PinPad';

/**
 * Closure-pin gate (Brief 12 P1). The closure pin is the ONLY way to end an
 * alert, so a user must never reach the armed state without one set. This wraps
 * the armed surfaces (Stillpoint covert + BLACK BOX direct) and, when setup is
 * complete but no on-device closure pin exists, forces a one-time "set your
 * lock code" step before arming.
 *
 * Covers two cases the live test exposed:
 *  - a brand-new account that somehow reached the home without a pin, and
 *  - existing 4-digit accounts that have no 3-digit closure pin yet (forced on
 *    their next open).
 *
 * It deliberately does NOT trigger during an active alert: swapping the covert
 * meditation surface for a pin-setup screen mid-event would break cover and
 * strand the user from the closure flow. Arming is blocked up-front, so a fresh
 * user can't reach an active alert without a pin in the first place.
 */
export function ClosurePinGate({ children }: { children: JSX.Element }): JSX.Element {
  const alertActive = useActiveAlert();
  const [status, setStatus] = useState<'loading' | 'set' | 'missing'>('loading');

  useEffect(() => {
    let cancelled = false;
    void getStoredClosurePin().then((pin) => {
      if (!cancelled) {
        setStatus(pin ? 'set' : 'missing');
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Not-yet-set-up users fall through so the home can redirect to onboarding;
  // an active alert or a still-loading check renders the armed surface as-is.
  if (!isSetupComplete() || status !== 'missing' || alertActive) {
    return children;
  }
  return <SetClosurePinScreen onDone={() => setStatus('set')} />;
}

/**
 * One-time forced closure-pin setup, in the Stillpoint design language so it
 * reads as an ordinary "session lock code" step (covert-safe). Two deliberate
 * phases: choose, then confirm. Stored ON-DEVICE only — never transmitted.
 */
function SetClosurePinScreen({ onDone }: { onDone: () => void }): JSX.Element {
  const [phase, setPhase] = useState<'choose' | 'confirm'>('choose');
  const [first, setFirst] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onCode(code: string): Promise<void> {
    setError(null);
    if (phase === 'choose') {
      setFirst(code);
      setPhase('confirm');
    } else if (code === first) {
      await setStoredClosurePin(await hashClosurePin(code));
      onDone();
    } else {
      setError('Codes did not match. Start again.');
      setPhase('choose');
    }
  }

  return (
    <main className="stillpoint-bg animate-hue-drift motion-reduce:animate-none flex min-h-full w-full flex-col items-center justify-center overflow-y-auto p-8 text-med-text">
      <div className="w-full max-w-sm">
        <h1 className="mb-2 text-center font-serif text-2xl font-light tracking-[0.06em]">
          Set your session lock code
        </h1>
        <p className="mb-8 text-center font-serif text-lg font-light text-med-text/80">
          {phase === 'choose' ? 'Choose a 3-digit code' : 'Re-enter your 3-digit code'}
        </p>
        <PinPad onComplete={(code) => void onCode(code)} resetKey={phase} length={3} />
        {error ? <p className="mt-4 text-center text-sm text-med-warn">{error}</p> : null}
        <div className="mt-8 space-y-3 text-center text-xs leading-relaxed text-med-text/55">
          <p>
            This is the only way to end a session. You enter it to request closure; your support
            contact reviews and secures it.
          </p>
          <p className="text-med-text/45">
            If you are ever forced to end a session against your will, enter it with the
            <span className="text-med-text/70"> last digit wrong</span> — it looks normal, but your
            contact is silently warned the danger is ongoing.
          </p>
        </div>
      </div>
    </main>
  );
}
