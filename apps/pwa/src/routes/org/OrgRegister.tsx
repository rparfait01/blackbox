import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '@/lib/api';
import { setSession, type DisplayMode } from '@/lib/auth';
import { enrollPasskey, passkeySupported } from '@/lib/passkey';

/**
 * Org admin registration (Brief 24) — the vetted, invite-only front door, reached only
 * by the issued link. NOTHING here is survivor-facing: no covert facade, no trigger.
 *
 * THE PASSIVE-GET HAZARD (§3): opening this link renders a form and consumes nothing.
 * The registration code is entered MANUALLY (never pre-filled from the URL — a forwarded
 * approval email alone must not complete registration), and the code is spent only on
 * the final explicit Submit — a POST after the human has enrolled a passkey. A scanner
 * hitting the page changes no state.
 *
 * The org's name, lane, seats, and term are READ-ONLY, pre-filled from the vetted
 * record after the code is looked up. The registrant confirms; they cannot edit.
 */

const LICENSE_VERSION = 'v1';

interface OrgView {
  orgId: string;
  name: string;
  lane: 'zero_fee' | 'paid';
  seatsTotal: number;
  termStart: number | null;
  termEnd: number | null;
}

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }): JSX.Element {
  return (
    <main className="stillpoint-bg animate-hue-drift motion-reduce:animate-none flex min-h-full w-full flex-col items-center justify-center overflow-y-auto p-8 text-med-text">
      <div className="w-full max-w-sm">
        <h1 className="mb-2 font-serif text-3xl font-light tracking-[0.04em]">{title}</h1>
        {subtitle ? <p className="mb-6 text-med-text/60">{subtitle}</p> : null}
        {children}
      </div>
    </main>
  );
}

const inputCls =
  'w-full border-b border-med-text/25 bg-transparent py-2 text-lg text-med-text outline-none placeholder:text-med-text/30 focus:border-med-text/60';

export function OrgRegister(): JSX.Element {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [org, setOrg] = useState<OrgView | null>(null);
  const [licenseAlreadyAccepted, setLicenseAlreadyAccepted] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [attested, setAttested] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Read-only lookup of the org this code is bound to. This GET consumes nothing.
  async function lookUp(): Promise<void> {
    setError(null);
    setBusy(true);
    const res = await api<{ valid: boolean; licenseAlreadyAccepted?: boolean; org?: OrgView }>(
      `/v1/org-register/${encodeURIComponent(code.trim())}`,
      { auth: false },
    );
    setBusy(false);
    if (!res.data?.valid || !res.data.org) {
      setOrg(null);
      setError('That code is not valid, has expired, or has already been used.');
      return;
    }
    setOrg(res.data.org);
    setLicenseAlreadyAccepted(!!res.data.licenseAlreadyAccepted);
  }

  // The explicit Submit — the only thing that consumes the code. Runs the passwordless
  // account ceremony (start → passkey → recovery → finalize) against a signup CAPABILITY, then
  // POSTs the completion which claims admin #1 and burns the code.
  async function register(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const bindNonce = crypto.randomUUID();
      const start = await api<{ signupId: string; capability: string }>('/v1/auth/signup/start', {
        auth: false,
        body: { name: name.trim(), email: email.trim(), regionId: 'jp' },
      });
      if (!start.data?.capability) {
        throw new Error('We could not start registration. Check your details and try again.');
      }
      const capability = start.data.capability;

      // Passkey is the intended authentication (§4). Non-blocking on a device that
      // cannot enroll one — the recovery code below still secures the account.
      if (passkeySupported()) {
        await enrollPasskey(capability, bindNonce);
      }

      const rec = await api<{ codes: string[] }>('/v1/auth/recovery/issue', { auth: false, body: { capability, bindNonce } });
      const codes = rec.data?.codes ?? [];

      const fin = await api<{ sessionToken: string; displayMode: DisplayMode; userId: string }>(
        '/v1/auth/signup/finalize',
        { auth: false, body: { capability, bindNonce, displayMode: 'direct' } },
      );
      if (!fin.data?.sessionToken) {
        throw new Error('We could not finish creating your account. Please try again.');
      }
      setSession(fin.data.sessionToken, 'direct', { name: name.trim(), email: email.trim() });

      // THE explicit consumption — claims admin #1 on the pre-created org, records the
      // license acceptance, and burns the code.
      const complete = await api<{ ok?: boolean; error?: string }>('/v1/org-register/complete', {
        body: { code: code.trim(), licenseVersion: LICENSE_VERSION, acceptancePath: 'click_through' },
      });
      if (!complete.data?.ok) {
        throw new Error(
          complete.data?.error === 'redeemed'
            ? 'This code has already been used. Ask your operator to re-issue one.'
            : 'That code could not be completed. It may have expired — ask your operator to re-issue.',
        );
      }
      setRecoveryCodes(codes);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Registration failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Shell title="You're registered" subtitle="You are now an admin for your organisation.">
        {recoveryCodes && recoveryCodes.length > 0 ? (
          <div className="mb-6 rounded-lg border border-med-text/20 bg-black/25 p-4">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-med-text/45">
              Save your recovery codes — shown once
            </p>
            <div className="grid grid-cols-1 gap-1 font-mono text-[13px] tracking-[0.08em] text-med-text">
              {recoveryCodes.map((rc) => (
                <span key={rc} className="select-all">{rc}</span>
              ))}
            </div>
          </div>
        ) : null}
        <p className="mb-6 text-[13px] leading-relaxed text-med-text/60">
          Next: invite a <span className="text-med-text">second admin</span>. Your organisation must have two
          admins before you can enrol anyone.
        </p>
        <button
          onClick={() => navigate('/org', { replace: true })}
          className="w-full rounded-full bg-med-text/90 py-4 font-sans text-base font-medium text-[#071416]"
        >
          Go to the portal
        </button>
      </Shell>
    );
  }

  const canRegister = !!org && name.trim().length > 0 && email.includes('@') && attested && !busy;

  return (
    <Shell title="Register your organisation" subtitle="For the named administrator only. Reached by your approval link.">
      {/* §3: the code is entered manually here — never pre-filled from the URL. */}
      <label className="mb-4 block">
        <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/50">Admin code</span>
        <div className="flex gap-2">
          <input
            value={code}
            onChange={(e) => { setCode(e.target.value); setOrg(null); }}
            inputMode="text"
            autoCapitalize="none"
            placeholder="Enter the code you were sent"
            className={inputCls}
          />
          <button
            type="button"
            onClick={() => void lookUp()}
            disabled={busy || code.trim().length < 4}
            className="shrink-0 rounded-full border border-med-text/40 px-4 text-sm text-med-text disabled:opacity-40"
          >
            Look up
          </button>
        </div>
      </label>

      {org ? (
        <>
          {/* Read-only org details — pre-filled from the vetted record, not editable. */}
          <div className="mb-5 rounded-lg border border-med-text/20 bg-black/20 p-4">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-med-text/45">Organisation (confirm)</p>
            <Row k="Name" v={org.name} />
            <Row k="License" v={org.lane === 'zero_fee' ? 'Zero-fee' : 'Paid'} />
            <Row k="Seats" v={String(org.seatsTotal)} />
          </div>

          <label className="mb-4 block">
            <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/50">Your name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className={inputCls} />
          </label>
          <label className="mb-4 block">
            <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/50">Work email</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" placeholder="you@org.org" className={inputCls} />
          </label>

          <p className="mb-4 text-[12px] leading-relaxed text-med-text/55">
            You’ll sign in with a passkey — your face, fingerprint, or device PIN. No password.
          </p>

          {/* §4 license attestation (click-through). Skipped if admin #1 already accepted. */}
          {licenseAlreadyAccepted ? (
            <p className="mb-5 text-[12px] leading-relaxed text-med-text/45">
              Your organisation’s license has already been accepted. You’re joining as an additional admin.
            </p>
          ) : (
            <label className="mb-5 flex items-start gap-3">
              <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-1" />
              <span className="text-[12px] leading-relaxed text-med-text/70">
                I am authorized to accept this on behalf of this organization.
              </span>
            </label>
          )}

          {error ? <p className="mb-3 text-sm text-med-warn">{error}</p> : null}

          <button
            onClick={() => void register()}
            disabled={licenseAlreadyAccepted ? !org || !name.trim() || !email.includes('@') || busy : !canRegister}
            className="w-full rounded-full bg-med-text/90 py-4 font-sans text-base font-medium text-[#071416] disabled:opacity-40"
          >
            {busy ? 'Registering…' : 'Register as admin'}
          </button>
        </>
      ) : (
        error ? <p className="text-sm text-med-warn">{error}</p> : null
      )}
    </Shell>
  );
}

function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="flex justify-between border-b border-med-text/10 py-1.5 last:border-0">
      <span className="text-[12px] text-med-text/55">{k}</span>
      <span className="text-[12px] text-med-text">{v}</span>
    </div>
  );
}
