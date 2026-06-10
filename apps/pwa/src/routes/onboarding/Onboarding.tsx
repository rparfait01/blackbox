import { Link } from 'react-router-dom';

/**
 * Onboarding placeholder. The full flow (contact pairing, voice-assistant
 * verification, contact-protocol training) is built in W9.
 */
export function Onboarding(): JSX.Element {
  return (
    <div className="animate-fade-in flex h-full w-full flex-col items-center justify-center gap-4 bg-bb-bg px-8 text-center font-sans text-bb-text">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Welcome</h1>
      <p className="max-w-xs font-mono text-[11px] uppercase tracking-[0.08em] text-bb-text-tertiary">
        Onboarding is implemented in a later phase
      </p>
      <Link
        to="/"
        className="mt-2 font-mono text-[11px] uppercase tracking-[0.1em] text-status-armed transition-opacity hover:opacity-80"
      >
        Continue
      </Link>
    </div>
  );
}
