const RADIUS = 118;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface HoldProgressRingProps {
  /** Hold progress, 0 → 1. */
  progress: number;
}

/**
 * Progress ring that fills as the user holds the breathing circle. Drawn with
 * SVG presentation attributes (no inline styles); rotated so it fills from the
 * top.
 */
export function HoldProgressRing({ progress }: HoldProgressRingProps): JSX.Element {
  const dashOffset = CIRCUMFERENCE * (1 - progress);

  return (
    <div className="pointer-events-none absolute -inset-2.5">
      <svg viewBox="0 0 240 240" className="h-full w-full -rotate-90">
        <circle
          cx="120"
          cy="120"
          r={RADIUS}
          fill="none"
          stroke="#d4a373"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          opacity={progress > 0 ? 1 : 0}
        />
      </svg>
    </div>
  );
}
