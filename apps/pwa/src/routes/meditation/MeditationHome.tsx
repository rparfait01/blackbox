import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { REVEAL_HOLD_MS } from '@/lib/env';
import { formatElapsed } from '@/lib/time';
import { BreathingCircles } from './BreathingCircles';
import { RevealRing } from './RevealRing';
import { useRevealGesture } from './use-reveal-gesture';

/**
 * Stillpoint — the meditation facade and default view. Nothing here references
 * BLACK BOX, safety, or emergency. A deliberate press-and-hold on the breathing
 * circle reveals the dashboard for inspection (never for activation).
 */
export function MeditationHome(): JSX.Element {
  const navigate = useNavigate();

  const sessionStart = useRef<number>(performance.now());
  const [sessionMs, setSessionMs] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setSessionMs(performance.now() - sessionStart.current);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const { progress, isHolding, handlers } = useRevealGesture(REVEAL_HOLD_MS, () => {
    navigate('/dashboard');
  });

  return (
    <main className="stillpoint-bg animate-hue-drift motion-reduce:animate-none relative flex h-full w-full select-none flex-col items-center justify-center overflow-hidden p-8 text-med-text">
      <h1 className="mb-12 text-center font-serif text-2xl font-light tracking-[0.1em] text-med-text/70">
        Stillpoint
      </h1>

      <div
        className="relative flex h-60 w-60 touch-none items-center justify-center"
        {...handlers}
      >
        <RevealRing progress={progress} />
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

      <p
        className={`absolute bottom-8 left-1/2 -translate-x-1/2 font-mono text-[9px] uppercase tracking-[0.2em] text-med-text/40 transition-opacity duration-500 ${
          isHolding ? 'opacity-100' : 'opacity-0'
        }`}
      >
        Keep holding
      </p>
    </main>
  );
}
