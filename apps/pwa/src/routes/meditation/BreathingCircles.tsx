/**
 * Three concentric circles with an offset breathing animation. Purely
 * decorative — the meditation facade's visual centerpiece.
 */
export function BreathingCircles(): JSX.Element {
  return (
    <>
      <div className="absolute inset-0 rounded-full border border-med-text/30 bg-[radial-gradient(circle,rgba(143,214,204,0.06),transparent_70%)] animate-breathe motion-reduce:animate-none" />
      <div className="absolute inset-10 rounded-full border border-med-text/40 bg-[radial-gradient(circle,rgba(143,214,204,0.06),transparent_70%)] animate-breathe [animation-delay:500ms] motion-reduce:animate-none" />
      <div className="absolute inset-20 rounded-full border border-med-accent/30 bg-[radial-gradient(circle,rgba(143,214,204,0.12),transparent_70%)] animate-breathe [animation-delay:1000ms] motion-reduce:animate-none" />
    </>
  );
}
