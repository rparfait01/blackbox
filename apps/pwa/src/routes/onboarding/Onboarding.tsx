import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '@/lib/api';
import { setSession, type DisplayMode } from '@/lib/auth';
import { hashPin } from '@/lib/crypto/pin';
import { setStoredPin, setStoredDuressPin } from '@/lib/storage';
import { getUserHash } from '@/lib/device';
import { PinPad } from '@/components/PinPad';
import { COUNTRY_CODES, REGIONS, defaultCountry, type CountryOption } from '@/lib/regions';

/**
 * Onboarding wizard (W8A). Seven deliberate steps in the Stillpoint design
 * language. Creates the account (email-OTP verified), captures the phone
 * unverified, sets the display mode and lock/backup codes, and invites a single
 * support contact. On finish it routes to /blackbox (direct) or / (covert).
 */

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;

function Field({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/50">
        {label}
      </span>
      <input
        {...props}
        className="w-full border-b border-med-text/25 bg-transparent py-2 font-sans text-lg text-med-text outline-none transition-colors placeholder:text-med-text/30 focus:border-med-text/60"
      />
    </label>
  );
}

function PrimaryButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      {...props}
      className="w-full rounded-full bg-med-text/90 py-4 font-sans text-base font-medium tracking-[0.04em] text-[#1a1f3a] transition-opacity hover:opacity-90 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Shell({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <main className="stillpoint-bg animate-hue-drift motion-reduce:animate-none flex min-h-full w-full flex-col items-center justify-center overflow-y-auto p-8 text-med-text">
      <div className="w-full max-w-sm">
        {title ? (
          <h1 className="mb-2 font-serif text-3xl font-light tracking-[0.04em]">{title}</h1>
        ) : null}
        {subtitle ? <p className="mb-8 text-med-text/60">{subtitle}</p> : null}
        {children}
      </div>
    </main>
  );
}

export function Onboarding(): JSX.Element {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // account fields
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState<CountryOption>(defaultCountry());
  const [phoneLocal, setPhoneLocal] = useState('');
  const [regionId, setRegionId] = useState(defaultCountry().regionId);
  const [signupId, setSignupId] = useState('');
  const [otp, setOtp] = useState('');

  // display + codes
  const [displayMode, setMode] = useState<DisplayMode>('covert');
  const [codePhase, setCodePhase] = useState<'lock' | 'lock-confirm' | 'duress' | 'duress-confirm'>(
    'lock',
  );
  const [firstCode, setFirstCode] = useState('');
  const [lockCode, setLockCode] = useState('');

  // guardian
  const [gName, setGName] = useState('');
  const [gEmail, setGEmail] = useState('');
  const [gPhone, setGPhone] = useState('');
  const [gRel, setGRel] = useState('');

  const phoneE164 = (): string => `${country.code}${phoneLocal.replace(/[^0-9]/g, '')}`;

  async function startSignup(): Promise<void> {
    setError(null);
    if (!name.trim() || !email.trim()) {
      setError('Name and email are required.');
      return;
    }
    setBusy(true);
    const res = await api<{ signupId: string }>('/v1/auth/signup/start', {
      auth: false,
      body: { name: name.trim(), email: email.trim(), phone: phoneE164(), regionId },
    });
    setBusy(false);
    if (res.ok && res.data?.signupId) {
      setSignupId(res.data.signupId);
      setStep(3);
    } else {
      setError(res.status === 409 ? 'That email already has an account.' : 'Could not start sign-up.');
    }
  }

  async function resendOtp(): Promise<void> {
    setError(null);
    await api('/v1/auth/signup/start', {
      auth: false,
      body: { name: name.trim(), email: email.trim(), phone: phoneE164(), regionId },
    });
  }

  async function verifyEmail(): Promise<void> {
    setError(null);
    setBusy(true);
    const res = await api('/v1/auth/signup/verify-email', {
      auth: false,
      body: { signupId, code: otp },
    });
    setBusy(false);
    if (res.ok) {
      setStep(4);
    } else {
      setError('That code is not valid. Check the latest email and try again.');
    }
  }

  async function finalize(duressCode: string | undefined): Promise<void> {
    setBusy(true);
    setError(null);
    // Store the codes locally (hashed) so the covert closure flow can decide
    // normal/duress/wrong without a network round-trip.
    await setStoredPin(await hashPin(lockCode));
    if (duressCode) {
      await setStoredDuressPin(await hashPin(duressCode));
    }
    const userHash = await getUserHash();
    const res = await api<{ sessionToken: string; displayMode: DisplayMode }>(
      '/v1/auth/signup/finalize',
      {
        auth: false,
        body: { signupId, displayMode, lockCode, duressCode, claimUserHash: userHash },
      },
    );
    setBusy(false);
    if (res.ok && res.data?.sessionToken) {
      setSession(res.data.sessionToken, displayMode, { name: name.trim(), email: email.trim() });
      setStep(6);
    } else {
      setError('Could not finish setting up your account.');
    }
  }

  function onCode(code: string): void {
    if (codePhase === 'lock') {
      setFirstCode(code);
      setCodePhase('lock-confirm');
      setError(null);
    } else if (codePhase === 'lock-confirm') {
      if (code === firstCode) {
        setLockCode(code);
        setCodePhase('duress');
        setError(null);
      } else {
        setError('Codes did not match. Start again.');
        setCodePhase('lock');
      }
    } else if (codePhase === 'duress') {
      if (code === lockCode) {
        setError('Backup code must differ from your lock code.');
        return;
      }
      setFirstCode(code);
      setCodePhase('duress-confirm');
      setError(null);
    } else {
      if (code === firstCode) {
        void finalize(code);
      } else {
        setError('Backup codes did not match. Start again.');
        setCodePhase('duress');
      }
    }
  }

  async function sendInvite(): Promise<void> {
    setBusy(true);
    setError(null);
    if (gName.trim() && gEmail.trim()) {
      await api('/v1/guardians/invite', {
        body: {
          name: gName.trim(),
          email: gEmail.trim(),
          phone: gPhone.trim(),
          relationship: gRel.trim(),
        },
      });
    }
    setBusy(false);
    setStep(7);
  }

  function finish(): void {
    navigate(displayMode === 'direct' ? '/blackbox' : '/', { replace: true });
  }

  // ---- step render ----
  if (step === 1) {
    return (
      <Shell title="BLACK BOX" subtitle="A personal safety system. Set up takes a couple of minutes.">
        <p className="mb-10 leading-relaxed text-med-text/70">
          When you activate, your support contact is reached immediately. You stay in control of who
          that is and how the app looks on your phone.
        </p>
        <PrimaryButton onClick={() => setStep(2)}>Get started</PrimaryButton>
      </Shell>
    );
  }

  if (step === 2) {
    return (
      <Shell title="Create account" subtitle="Your email is verified; your phone is captured for later.">
        <div className="space-y-5">
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name or alias" />
          <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          <div className="flex gap-3">
            <label className="block w-28">
              <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/50">Code</span>
              <select
                value={country.code}
                onChange={(e) => {
                  const c = COUNTRY_CODES.find((x) => x.code === e.target.value)!;
                  setCountry(c);
                  setRegionId(c.regionId);
                }}
                className="w-full border-b border-med-text/25 bg-transparent py-2 text-lg text-med-text outline-none"
              >
                {COUNTRY_CODES.map((c) => (
                  <option key={c.code} value={c.code} className="text-black">
                    {c.code}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex-1">
              <Field label="Phone" value={phoneLocal} onChange={(e) => setPhoneLocal(e.target.value)} placeholder="90 1234 5678" inputMode="tel" />
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/50">Region</span>
            <select
              value={regionId}
              onChange={(e) => setRegionId(e.target.value)}
              className="w-full border-b border-med-text/25 bg-transparent py-2 text-lg text-med-text outline-none"
            >
              {REGIONS.map((r) => (
                <option key={r.id} value={r.id} className="text-black">
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error ? <p className="mt-4 text-sm text-status-active">{error}</p> : null}
        <div className="mt-8">
          <PrimaryButton onClick={startSignup} disabled={busy}>
            {busy ? 'Sending code…' : 'Continue'}
          </PrimaryButton>
        </div>
      </Shell>
    );
  }

  if (step === 3) {
    return (
      <Shell title="Verify your email" subtitle={`We sent a 6-digit code to ${email}.`}>
        <input
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
          inputMode="numeric"
          placeholder="------"
          className="mb-2 w-full border-b border-med-text/25 bg-transparent py-3 text-center font-mono text-3xl tracking-[0.4em] text-med-text outline-none placeholder:text-med-text/20"
        />
        {error ? <p className="mb-2 text-sm text-status-active">{error}</p> : null}
        <button onClick={resendOtp} className="mb-8 text-sm text-med-text/50 underline">
          Resend code
        </button>
        <PrimaryButton onClick={verifyEmail} disabled={busy || otp.length !== 6}>
          {busy ? 'Verifying…' : 'Verify'}
        </PrimaryButton>
      </Shell>
    );
  }

  if (step === 4) {
    return (
      <Shell title="Display mode" subtitle="How the app looks on your phone. You can change this later.">
        <div className="space-y-4">
          <ModeCard
            active={displayMode === 'direct'}
            title="DIRECT"
            body="BLACK BOX interface visible. Tap to activate, see status, full clarity."
            onClick={() => setMode('direct')}
          />
          <ModeCard
            active={displayMode === 'covert'}
            title="COVERT"
            body="Meditation app disguise. The app looks like Stillpoint. Activation hidden in the meditation interaction."
            onClick={() => setMode('covert')}
          />
        </div>
        <div className="mt-8">
          <PrimaryButton onClick={() => setStep(5)}>Continue</PrimaryButton>
        </div>
      </Shell>
    );
  }

  if (step === 5) {
    const prompts = {
      lock: 'Set your session lock code',
      'lock-confirm': 'Re-enter your session lock code',
      duress: 'Set your backup code',
      'duress-confirm': 'Re-enter your backup code',
    } as const;
    const onLockStep = codePhase === 'lock' || codePhase === 'lock-confirm';
    return (
      <Shell title="Set your codes">
        <p className="mb-8 text-center font-serif text-lg font-light text-med-text/80">
          {prompts[codePhase]}
        </p>
        <PinPad onComplete={onCode} resetKey={codePhase} />
        {error ? <p className="mt-4 text-center text-sm text-status-active">{error}</p> : null}
        <p className="mt-8 text-center text-xs leading-relaxed text-med-text/50">
          {onLockStep
            ? 'Your session lock code ends the alert through your support contact’s approval.'
            : 'The backup code signals to your support contact that something is wrong without making it visible to anyone watching.'}
        </p>
        {codePhase === 'duress' ? (
          <button onClick={() => void finalize(undefined)} className="mt-4 block w-full text-center text-sm text-med-text/40 underline">
            Skip backup code for now
          </button>
        ) : null}
      </Shell>
    );
  }

  if (step === 6) {
    return (
      <Shell title="Add support contact" subtitle="The person we reach the moment you activate.">
        <div className="space-y-5">
          <Field label="Name" value={gName} onChange={(e) => setGName(e.target.value)} placeholder="Their name" />
          <Field label="Email" type="email" value={gEmail} onChange={(e) => setGEmail(e.target.value)} placeholder="their@email.com" />
          <Field label="Phone (optional)" value={gPhone} onChange={(e) => setGPhone(e.target.value)} placeholder="+81 90 …" inputMode="tel" />
          <Field label="Relationship" value={gRel} onChange={(e) => setGRel(e.target.value)} placeholder="e.g. spouse, friend" />
        </div>
        <div className="mt-8 space-y-3">
          <PrimaryButton onClick={sendInvite} disabled={busy}>
            {busy ? 'Sending invite…' : 'Send invite'}
          </PrimaryButton>
          <button onClick={() => setStep(7)} className="block w-full text-center text-sm text-med-text/50 underline">
            Skip — add later in settings
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="You're set up">
      <div className="mb-8 rounded-lg border border-med-text/20 bg-black/20 p-5 text-sm leading-relaxed text-med-text/80">
        Email notifications enabled. Your support contact will receive an immediate email at
        activation. Most phones show this on the lock screen and on a connected watch.
      </div>
      <PrimaryButton onClick={finish}>Continue</PrimaryButton>
    </Shell>
  );
}

function ModeCard({
  active,
  title,
  body,
  onClick,
}: {
  active: boolean;
  title: string;
  body: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-xl border p-5 text-left transition-colors ${
        active ? 'border-med-text/80 bg-med-text/10' : 'border-med-text/20 hover:border-med-text/40'
      }`}
    >
      <div className="mb-1 font-mono text-sm font-bold tracking-[0.12em] text-med-text">{title}</div>
      <div className="text-sm leading-relaxed text-med-text/65">{body}</div>
    </button>
  );
}
