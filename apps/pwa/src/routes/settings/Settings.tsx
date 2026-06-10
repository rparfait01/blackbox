import { Link } from 'react-router-dom';
import { CaretLeft } from '@phosphor-icons/react';

/**
 * Settings placeholder. Fields (name, contact, pin, voice phrase, covert button
 * sequence, recording mode, AI provider) are filled in across later phases.
 */
export function Settings(): JSX.Element {
  return (
    <div className="animate-fade-in flex h-full w-full flex-col overflow-y-auto bg-bb-bg px-5 pb-5 pt-6 font-sans text-bb-text">
      <Link
        to="/dashboard"
        className="mb-6 inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.1em] text-bb-text-secondary transition-colors hover:text-bb-text"
      >
        <CaretLeft size={12} weight="bold" />
        Back
      </Link>

      <h1 className="font-display text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.08em] text-bb-text-tertiary">
        Configuration arrives in later phases
      </p>
    </div>
  );
}
