import { Link, useNavigate } from 'react-router-dom';
import { GearSix } from '@phosphor-icons/react';

import { DASHBOARD_INACTIVITY_MS } from '@/lib/env';
import { useInactivityTimer } from '@/hooks/use-inactivity-timer';
import { StatusDisc } from './StatusDisc';

/**
 * The BLACK BOX dashboard — revealed from the facade for inspection only.
 *
 * There is NO activation control anywhere on this screen. Activation is covert
 * (voice phrase / hardware-button sequence) and lands in W8. The dashboard is
 * for inspection, configuration, and (in later phases) closure requests.
 */
export function Dashboard(): JSX.Element {
  const navigate = useNavigate();

  // Auto-return to the meditation facade after 60s of inactivity.
  useInactivityTimer(DASHBOARD_INACTIVITY_MS, () => navigate('/'));

  return (
    <div className="animate-fade-in flex h-full w-full flex-col overflow-y-auto bg-bb-bg px-5 pb-5 pt-6 font-sans text-bb-text">
      <header className="flex items-center justify-between border-b border-bb-border-subtle pb-4 pt-2">
        <span className="font-display text-sm font-bold tracking-[0.06em]">BLACK BOX</span>
        <Link
          to="/settings"
          aria-label="Settings"
          className="p-2 text-bb-text-tertiary transition-colors hover:text-bb-text"
        >
          <GearSix size={18} weight="regular" />
        </Link>
      </header>

      <section className="flex flex-col items-center gap-6 py-8">
        <div className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-status-armed">
          ARMED · LISTENING
        </div>
        <StatusDisc />
      </section>

      <div className="mt-1 flex-1">
        <section className="border-t border-bb-border-subtle py-3">
          <div className="mb-1.5 font-mono text-[9px] font-medium uppercase tracking-[0.12em] text-bb-text-tertiary">
            Designated Contact
          </div>
          <div className="text-[13px] leading-snug text-bb-text">Not configured</div>
          <div className="mt-0.5 font-mono text-[11px] text-bb-text-secondary">
            Add a contact in settings
          </div>
        </section>

        <section className="border-t border-bb-border-subtle py-3">
          <div className="mb-1.5 font-mono text-[9px] font-medium uppercase tracking-[0.12em] text-bb-text-tertiary">
            Voice Phrase
          </div>
          <div className="text-[13px] leading-snug text-bb-text">Not configured</div>
          <div className="mt-0.5 font-mono text-[11px] text-bb-text-secondary">
            Set in settings · activates via Siri
          </div>
        </section>

        <section className="border-t border-bb-border-subtle py-3">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="font-mono text-[9px] font-medium uppercase tracking-[0.12em] text-bb-text-tertiary">
              Recent Activity
            </span>
            <Link
              to="/history"
              className="font-mono text-[9px] uppercase tracking-[0.1em] text-bb-text-secondary transition-colors hover:text-bb-text"
            >
              View all
            </Link>
          </div>
          <div className="py-6 text-center font-mono text-[11px] uppercase tracking-[0.08em] text-bb-text-tertiary">
            No activations yet
          </div>
        </section>
      </div>
    </div>
  );
}
