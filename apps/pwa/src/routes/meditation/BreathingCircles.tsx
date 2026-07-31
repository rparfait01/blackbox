/**
 * Three concentric circles with an offset breathing animation. Purely
 * decorative — the meditation facade's visual centerpiece.
 *
 * pointer-events-none on every layer (Brief 15 amendment): the press must land
 * on the gesture container that carries the hold handlers + pointer capture, not
 * on one of these animated layers. Otherwise the orb "takes a press like a static
 * image" and the covert trigger never fires. Purely a hit-testing change — no
 * visual difference, so the §0a byte-identical invariant holds.
 */
export function BreathingCircles({ cycleMs }: { cycleMs?: number }): JSX.Element {
  // The cycle length, when the caller supplies one. It is the ONLY thing that varies here:
  // no element is ever added, removed, recoloured or badged, because an element that only
  // appears under some condition is itself the thing this screen must not have. `undefined`
  // keeps the CSS default, so a caller that passes nothing renders exactly as before.
  const style = cycleMs ? { animationDuration: `${cycleMs}ms` } : undefined;
  return (
    <>
      <div className="pointer-events-none absolute inset-0 rounded-full border border-med-text/30 bg-[radial-gradient(circle,rgba(143,214,204,0.06),transparent_70%)] animate-breathe motion-reduce:animate-none" style={style} />
      <div className="pointer-events-none absolute inset-10 rounded-full border border-med-text/40 bg-[radial-gradient(circle,rgba(143,214,204,0.06),transparent_70%)] animate-breathe [animation-delay:500ms] motion-reduce:animate-none" style={style} />
      <div className="pointer-events-none absolute inset-20 rounded-full border border-med-accent/30 bg-[radial-gradient(circle,rgba(143,214,204,0.12),transparent_70%)] animate-breathe [animation-delay:1000ms] motion-reduce:animate-none" style={style} />
    </>
  );
}
