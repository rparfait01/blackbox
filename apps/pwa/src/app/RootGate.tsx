import { Navigate } from 'react-router-dom';

import { MeditationHome } from '@/routes/meditation/MeditationHome';
import { Landing } from '@/routes/landing/Landing';
import { ClosurePinGate } from '@/components/ClosurePinGate';
import { getCachedConsoleLevel, getDisplayMode, isSetupComplete } from '@/lib/auth';

/**
 * Root gate. Decides what `/` renders, SYNCHRONOUSLY from localStorage — no flicker, no
 * fallback drift, and critically no network round-trip on the path to the armed screen.
 *
 * THE ORDER IS THE SAFETY PROPERTY. The covert branch is first and unconditional:
 *
 *   covert                → Stillpoint (the meditation disguise), byte-identical
 *   direct, no console role → /blackbox (straight to the app, as before)
 *   direct, console role   → the Landing, to choose App or Console
 *   not set up             → the Landing (Sign in · Create an account)
 *
 * §0a: the installed PWA is named "Stillpoint" and its start_url is `/`. If a branded
 * landing could render there for a covert install, opening the home-screen icon would
 * announce the product — the loudest possible tell, in the exact moment the disguise
 * matters most. So `covert` is checked before anything branded can be constructed, and
 * that branch returns exactly what it always returned.
 *
 * THE COVERT BRANCH DOES NOT REQUIRE A SESSION, and that is the point of it. `clearSession`
 * keeps the covert preference on purpose, so a survivor who signs out still opens into
 * Stillpoint rather than a splash naming the product. Gating this on `isSetupComplete()`
 * would throw away that preservation at the only moment it matters. A signed-out facade is
 * not a degraded state either: the double-tap still reaches triggerAlert, which falls back
 * to the tokenless event path the server already supports — so the trigger survives a
 * sign-out, where previously a signed-out covert user was sent to onboarding and had none.
 *
 * WHY THE ROLE COMES FROM A CACHE HERE, when everywhere else it comes from the server:
 * this decision must be synchronous. Waiting on /v1/console/me would put a spinner
 * between a survivor and their trigger screen, and offline it would never resolve. The
 * cache is a HINT that only picks a screen — it defaults to "no role", so the failure
 * direction is a survivor going straight into their app. Every console route still
 * derives the level server-side and refuses on its own, and the Landing itself confirms
 * against the server on mount.
 */
export function RootGate(): JSX.Element {
  // 1. COVERT FIRST, session or no session. Nothing branded may be reached from here.
  if (getDisplayMode() === 'covert') {
    return (
      <ClosurePinGate>
        <MeditationHome />
      </ClosurePinGate>
    );
  }
  // 2. A signed-in survivor with no console role goes straight into the app, exactly as
  //    before — the landing is not a toll gate on the way to the trigger.
  if (isSetupComplete() && getDisplayMode() === 'direct' && !getCachedConsoleLevel()) {
    return <Navigate to="/blackbox" replace />;
  }
  // 3. Everyone else — signed out, or signed in with a console role — gets the entry
  //    router. Onboarding is one branch off it, not the default everyone was dumped on.
  return <Landing />;
}
