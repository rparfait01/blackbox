import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { CaretLeft } from '@phosphor-icons/react';

import { api } from '@/lib/api';
import { cacheEntitlement, getCachedEntitlement, isSetupComplete } from '@/lib/auth';

/**
 * Activation (Brief 28 §2/§4) — the ARM gate, surfaced as a screen. Activation is
 * required to ARM the device; it is NEVER required to TRIGGER (§0). Reached from the
 * Visible home's activation prompt and from Settings — never from the Hidden facade
 * (a price is a tell). An already-activated OR org-sourced account never lands here
 * with a price: the caller only routes an unactivated account here, and the price
 * block is additionally guarded on source below.
 *
 * The working path is the CODE (an org enrollment / activation code → server grants
 * entitlement on redemption). Web card purchase is server-verified via a signed
 * webhook (§3) and is not a client-driven checkout in this build — no button here
 * ever grants entitlement client-side (§0: no client-granted entitlement, ever).
 */

// A price is shown ONLY as information, and ONLY for an account with no sponsoring
// source. Org / operator-sourced accounts are activated already and never see it.
const ONE_TIME_PRICE = '$34.99';

type Status = 'idle' | 'redeeming' | 'error';

const REASON_COPY: Record<string, string> = {
  not_found: 'That code wasn’t recognised. Check it and try again.',
  revoked: 'That code has been turned off. Ask whoever gave it to you for a new one.',
  expired: 'That code has expired. Ask for a fresh one.',
  exhausted: 'That code has already been used. Ask for a fresh one.',
  seats_full: 'Your organisation has no seats left. Contact your coordinator.',
  no_license: 'Your organisation isn’t set up for enrolment yet. Contact your coordinator.',
  needs_two_admins: 'Your organisation isn’t ready to enrol yet. Contact your coordinator.',
  already_in_org: 'This account already belongs to a different organisation.',
  rate_limited: 'Too many attempts. Wait a little while, then try again.',
  code_required: 'Enter your activation code.',
};

export function Activation(): JSX.Element {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  if (!isSetupComplete()) {
    return <Navigate to="/onboarding" replace />;
  }
  // If somehow already activated, there is nothing to do here — go home.
  if (getCachedEntitlement().status === 'activated') {
    return <Navigate to="/blackbox" replace />;
  }

  async function redeem(): Promise<void> {
    const trimmed = code.trim();
    if (!trimmed) {
      setStatus('error');
      setError(REASON_COPY.code_required);
      return;
    }
    setStatus('redeeming');
    setError(null);
    const res = await api<{ ok: boolean; error?: string }>('/v1/me/org/redeem', {
      body: { code: trimmed },
    });
    if (res.ok && res.data?.ok) {
      // Redemption grants entitlement server-side (source org_code). Reflect it in the
      // offline cache immediately so the home renders armed without a round-trip.
      cacheEntitlement({ status: 'activated', source: 'org_code' });
      navigate('/blackbox', { replace: true });
      return;
    }
    setStatus('error');
    const reason = res.data?.error ?? '';
    setError(REASON_COPY[reason] ?? 'That didn’t work. Check the code and try again.');
  }

  return (
    <main className="flex h-full w-full flex-col bg-bb-bg px-6 pb-6 pt-safe-6 text-bb-text">
      <div className="flex items-center">
        <Link to="/blackbox" aria-label="Back" className="p-2 text-bb-text-secondary hover:text-bb-text">
          <CaretLeft size={22} weight="light" />
        </Link>
        <span className="ml-1 font-display text-lg font-bold tracking-[0.12em]">Activate</span>
      </div>

      <div className="mt-8 flex flex-1 flex-col">
        <p className="text-sm leading-relaxed text-bb-text-secondary">
          Activation arms this device for alerts. Your emergency trigger works either
          way — if you trigger before activating, your alert still sends and records.
          Safety is never blocked.
        </p>

        <div className="mt-8">
          <label htmlFor="activation-code" className="font-mono text-[11px] uppercase tracking-[0.16em] text-bb-text-tertiary">
            Activation code
          </label>
          <input
            id="activation-code"
            type="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              if (status === 'error') setStatus('idle');
            }}
            placeholder="e.g. K7QP-4MX9"
            className="mt-2 w-full rounded-lg border border-bb-border-defined bg-bb-elevated px-4 py-3 font-mono text-base tracking-[0.12em] text-bb-text placeholder:text-bb-text-tertiary focus:border-status-armed focus:outline-none"
          />
          {status === 'error' && error ? (
            <p className="mt-2 text-[12px] leading-relaxed text-status-armed">{error}</p>
          ) : null}
          <button
            type="button"
            onClick={() => void redeem()}
            disabled={status === 'redeeming'}
            className="mt-4 w-full rounded-full border border-status-armed/60 bg-status-armed/10 py-3.5 font-mono text-sm font-medium uppercase tracking-[0.12em] text-status-armed disabled:opacity-50"
          >
            {status === 'redeeming' ? 'Activating…' : 'Activate'}
          </button>
          <p className="mt-2 text-center font-mono text-[10px] leading-relaxed text-bb-text-tertiary">
            A code from your organisation or advocate activates you at no cost.
          </p>
        </div>

        {/* Web purchase (§3) is server-verified via a signed payment webhook — there is
            no client-driven checkout in this build, and nothing here grants entitlement
            on the client. Shown as information only, and only to an unsponsored account. */}
        <div className="mt-auto border-t border-bb-border-subtle pt-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-bb-text-tertiary">
            No code?
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-bb-text-secondary">
            BLACK BOX is a one-time purchase of {ONE_TIME_PRICE} — no subscription, no
            renewals. To buy access, follow the payment link from your provider; your
            account activates automatically once payment is confirmed.
          </p>
        </div>
      </div>
    </main>
  );
}
