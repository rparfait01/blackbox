import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Gear } from '@phosphor-icons/react';

import { api } from '@/lib/api';
import { isSetupComplete } from '@/lib/auth';
import { triggerActivation } from '@/lib/activation';

/**
 * Direct-mode home (W8A) — the BLACK BOX interface from the reference design,
 * section 01. Wordmark explicit, no facade. The phone stays visually dormant at
 * all times (no on-device feedback during a session, by principle); tapping the
 * disc activates silently.
 */

interface MeResponse {
  guardian: { name: string | null; status: string } | null;
}

export function BlackBoxHome(): JSX.Element {
  const [guardian, setGuardian] = useState<MeResponse['guardian']>(null);

  useEffect(() => {
    void api<MeResponse>('/v1/me').then((res) => {
      if (res.ok && res.data) {
        setGuardian(res.data.guardian);
      }
    });
  }, []);

  if (!isSetupComplete()) {
    return <Navigate to="/onboarding" replace />;
  }

  const activate = (): void => {
    // Covert by principle even here: produces no visible status change.
    void triggerActivation('direct-tap');
  };

  return (
    <main className="flex h-full w-full flex-col bg-bb-bg p-6 text-bb-text">
      <div className="flex items-center justify-between">
        <span className="font-display text-lg font-bold tracking-[0.12em]">BLACK BOX</span>
        <Link to="/settings" aria-label="Settings" className="p-2 text-bb-text-secondary hover:text-bb-text">
          <Gear size={22} weight="light" />
        </Link>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center">
        <div className="mb-8 font-mono text-xs font-medium uppercase tracking-[0.2em] text-status-armed">
          ARMED · LISTENING
        </div>

        <button
          type="button"
          onClick={activate}
          aria-label="Activate"
          className="relative flex h-48 w-48 items-center justify-center rounded-full transition-transform active:scale-95"
        >
          <span className="absolute inset-0 rounded-full border border-status-armed/40" />
          <span className="absolute inset-6 rounded-full border border-bb-border-defined" />
          <span className="h-16 w-16 rounded-full bg-bb-elevated shadow-[0_0_40px_rgba(232,154,0,0.15)]" />
        </button>

        <div className="mt-10 font-mono text-sm font-medium uppercase tracking-[0.18em] text-bb-text">
          Tap to activate
        </div>
      </div>

      <div className="space-y-4">
        <Section label="Source">
          <div className="text-sm text-bb-text">Phone microphone &amp; camera</div>
          <div className="mt-0.5 font-mono text-[11px] text-bb-text-secondary">
            No external hardware paired
          </div>
        </Section>
        <Section label="Primary Contact">
          {guardian ? (
            <>
              <div className="text-sm text-bb-text">{guardian.name}</div>
              <div className="mt-0.5 font-mono text-[11px] text-bb-text-secondary">
                {guardian.status === 'accepted' ? 'Email · Verified' : `Waiting for ${guardian.name}`}
              </div>
            </>
          ) : (
            <div className="font-mono text-[11px] text-bb-text-secondary">
              No support contact yet — add one in settings
            </div>
          )}
        </Section>
      </div>
    </main>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="border-t border-bb-border-subtle pt-3">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-bb-text-tertiary">
        {label}
      </div>
      {children}
    </div>
  );
}
