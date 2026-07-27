import { Navigate } from 'react-router-dom';

import { MeditationHome } from '@/routes/meditation/MeditationHome';
import { Landing } from '@/routes/landing/Landing';
import { ClosurePinGate } from '@/components/ClosurePinGate';
import { getCachedConsoleLevel, getDisplayMode, getSessionToken, isSetupComplete } from '@/lib/auth';

/**
 * Root gate. Decides what `/` renders, SYNCHRONOUSLY from localStorage — no flicker, no
 * fallback drift, and no network round-trip on the path to the armed screen.
 *
 * THE PRECEDENCE, in order, and the order is the whole thing:
 *
 *   1. NOT SIGNED IN        → the branded landing, ALWAYS. Any stored display mode is
 *                             ignored, because it belongs to an account and there is no
 *                             account here.
 *   2. signed in + Hidden   → Stillpoint (the meditation disguise), byte-identical
 *   3. signed in + Visible  → /blackbox, or the landing when the account holds a console
 *                             role and therefore has a choice to make
 *
 * WHY THE SESSION CHECK COMES FIRST. The display mode is an ACCOUNT property — server
 * truth in users.displayMode, delivered at sign-in. A signed-out device has no account,
 * so honouring a leftover mode would let one person's preference decide what the NEXT
 * person sees: a visitor arriving from the public site, or a second user of a shared
 * device, dropped into a meditation app with no visible way into the product. That was a
 * real bug, and this ordering is its fix. `clearSession` also drops the mode outright, so
 * the rule holds even if some future code path forgets to check for a session.
 *
 * ACCEPTED CONSEQUENCE: a survivor running Hidden who signs out gets the branded landing
 * on reopen, and does not have the facade's covert trigger until they sign back in. Their
 * Hidden skin returns from the account at sign-in.
 *
 * §0a still holds where it must: for a SIGNED-IN covert install — the one the disguise
 * exists to protect, and the one whose home-screen icon says "Stillpoint" — `/` renders
 * the facade and nothing branded is reachable from it.
 *
 * WHY THE ROLE COMES FROM A CACHE, when everywhere else it comes from the server: this
 * decision must be synchronous. Waiting on /v1/console/me would put a spinner between a
 * survivor and their trigger screen, and offline it would never resolve. The cache is a
 * HINT that only picks a screen — it defaults to "no role", so the failure direction is a
 * survivor going straight into their app. Every console route still derives the level
 * server-side and refuses on its own, and the Landing confirms against the server on mount.
 */
export function RootGate(): JSX.Element {
  // 1. NO SESSION → the branded landing, unconditionally. Note this deliberately does NOT
  //    consult getDisplayMode(): a signed-out device has no account whose skin to wear.
  if (getSessionToken() == null) {
    return <Landing />;
  }
  // 2. Signed in and Hidden → the disguise, exactly as it has always rendered.
  if (getDisplayMode() === 'covert') {
    return (
      <ClosurePinGate>
        <MeditationHome />
      </ClosurePinGate>
    );
  }
  // 3. Signed in and Visible: straight into the app, unless this account holds a console
  //    role and so has a genuine choice between the app and the console.
  if (isSetupComplete() && !getCachedConsoleLevel()) {
    return <Navigate to="/blackbox" replace />;
  }
  return <Landing />;
}
