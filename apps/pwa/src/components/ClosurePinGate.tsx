/**
 * Closure-pin gate — RETIRED (Fix Brief 15 §E2).
 *
 * The 3-digit closure pin no longer exists: closure is a press-and-hold gesture
 * (hold ≥3s = clean, release <3s = duress) that needs nothing pre-set on the
 * device. There is therefore nothing to gate before arming, so this is now a
 * transparent pass-through. It is kept (rather than deleted) only so the two
 * mount points (RootGate, router) need no change; it can be unwrapped later.
 */
export function ClosurePinGate({ children }: { children: JSX.Element }): JSX.Element {
  return children;
}
