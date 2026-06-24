import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CaretLeft } from '@phosphor-icons/react';

import { api } from '@/lib/api';
import { setSession, type DisplayMode } from '@/lib/auth';
import { primePermissions } from '@/lib/permissions';
import { osFixHint } from '@/lib/readiness';
import { InstallHint } from '@/components/InstallHint';
import { ContactForm, type ContactValues } from '@/components/ContactForm';
import { getUserHash } from '@/lib/device';
import { COUNTRY_CODES, NATIONALITIES, REGIONS, defaultCountry, type CountryOption } from '@/lib/regions';

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
      className="w-full rounded-full bg-med-text/90 py-4 font-sans text-base font-medium tracking-[0.04em] text-[#071416] transition-opacity hover:opacity-90 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Shell({
  title,
  subtitle,
  onBack,
  children,
}: {
  title?: string;
  subtitle?: string;
  /** When set, a back control is shown top-left (Brief 14 P1 — no dead ends). */
  onBack?: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <main className="stillpoint-bg animate-hue-drift motion-reduce:animate-none flex min-h-full w-full flex-col items-center justify-center overflow-y-auto p-8 text-med-text">
      <div className="w-full max-w-sm">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="-ml-2 mb-4 p-2 text-med-text/50 transition-colors hover:text-med-text"
          >
            <CaretLeft size={24} weight="light" />
          </button>
        ) : null}
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
  const [password, setPassword] = useState('');
  const [country, setCountry] = useState<CountryOption>(defaultCountry());
  const [phoneLocal, setPhoneLocal] = useState('');
  const [regionId, setRegionId] = useState(defaultCountry().regionId);
  const [nationality, setNationality] = useState('');
  const [signupId, setSignupId] = useState('');
  const [emailExists, setEmailExists] = useState(false);

  // support person captured at signup (Brief: persists to the SAME slots model
  // Settings + the cascade use — primary contact or guardian).
  const [supportRole, setSupportRole] = useState<'primary' | 'guardian'>('primary');

  // display mode (the closure pin is retired — §E2 gesture closure)
  const [displayMode, setMode] = useState<DisplayMode>('covert');

  // permissions priming (mic + location), requested from a user gesture here so
  // activation never triggers a permission dialog.
  const [perms, setPerms] = useState<'idle' | 'asking' | { mic: boolean; camera: boolean; location: boolean }>('idle');
  // Explicit acknowledgement that the user is proceeding with a degraded (mic-denied)
  // setup — the only non-granted way past the permission gate (Brief 15 §B).
  const [degradedAck, setDegradedAck] = useState(false);

  const phoneE164 = (): string => `${country.code}${phoneLocal.replace(/[^0-9]/g, '')}`;

  async function startSignup(): Promise<void> {
    setError(null);
    setEmailExists(false);
    // Inline validation — surface exactly what is missing, never block silently.
    if (!name.trim()) {
      setError('Please add your name.');
      return;
    }
    if (!email.trim()) {
      setError('Please add your email.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('That email does not look right — please check it.');
      return;
    }
    if (password.length < 6) {
      setError('Please choose a password of at least 6 characters.');
      return;
    }
    setBusy(true);
    // Brief 14: create the account immediately. No email is sent and no email
    // delivery can fail here — we go straight on to display mode.
    const res = await api<{ signupId: string }>('/v1/auth/signup/start', {
      auth: false,
      body: { name: name.trim(), email: email.trim(), password, phone: phoneE164(), regionId, nationality },
    });
    setBusy(false);
    if (res.ok && res.data?.signupId) {
      setSignupId(res.data.signupId);
      setStep(4);
    } else if (res.status === 409) {
      setEmailExists(true);
    } else if (res.status === 0) {
      setError('No connection — we couldn’t create your account. Check your signal and try again.');
    } else {
      setError('Something went wrong creating your account. Please try again.');
    }
  }

  async function finalize(): Promise<void> {
    setBusy(true);
    setError(null);
    // Brief 16 §1: NO lock code. Closure is gesture-only; finalize no longer
    // takes or needs a pin of any kind.
    const userHash = await getUserHash();
    const res = await api<{ sessionToken: string; displayMode: DisplayMode }>(
      '/v1/auth/signup/finalize',
      {
        auth: false,
        body: { signupId, displayMode, claimUserHash: userHash },
      },
    );
    setBusy(false);
    if (res.ok && res.data?.sessionToken) {
      setSession(res.data.sessionToken, displayMode, { name: name.trim(), email: email.trim() });
      setStep(6);
    } else {
      setError(
        res.status === 0
          ? 'No connection — we couldn’t finish setting up. Check your signal and try again.'
          : 'Could not finish setting up your account. Please try again.',
      );
    }
  }

  async function saveSupport(values: ContactValues): Promise<void> {
    setBusy(true);
    setError(null);
    // Write to the SAME slot model Settings and the alert cascade read, so she
    // persists in the right role and is visible in Settings immediately — no
    // re-add. Not gated on email/OTP verification (Brief 14). The session exists
    // here (finalize ran at step 5), so this authenticated call succeeds.
    const slot = supportRole === 'guardian' ? 'guardian' : 'primary';
    const res = await api<{ error?: string; message?: string }>(`/v1/me/contacts/${slot}`, {
      body: { contactName: values.name, channel: values.channel, destination: values.destination },
    });
    setBusy(false);
    if (res.ok) {
      setStep(7);
    } else if (res.status === 0) {
      setError('No connection — we couldn’t save your contact. Check your signal and try again.');
    } else if (res.data?.error === 'channel_not_available') {
      setError(res.data.message ?? 'That channel is not available yet — use Email.');
    } else {
      setError('Could not save your support contact. Check the destination and try again.');
    }
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
        <button
          onClick={() => navigate('/signin')}
          className="mt-5 block w-full text-center text-sm text-med-text/60 underline"
        >
          Already have an account? Sign in
        </button>
      </Shell>
    );
  }

  if (step === 2) {
    return (
      <Shell
        title="Create account"
        subtitle="Set an email and password to sign in. Your phone is captured for later."
        onBack={() => {
          setError(null);
          setStep(1);
        }}
      >
        <div className="space-y-5">
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name or alias" />
          <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
          <Field label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" autoComplete="new-password" />
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
          <label className="block">
            <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/50">
              Nationality (optional)
            </span>
            <select
              value={nationality}
              onChange={(e) => setNationality(e.target.value)}
              className="w-full border-b border-med-text/25 bg-transparent py-2 text-lg text-med-text outline-none"
            >
              <option value="" className="text-black">
                Prefer not to say
              </option>
              {NATIONALITIES.map((n) => (
                <option key={n} value={n} className="text-black">
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        {emailExists ? (
          <div className="mt-6 rounded-lg border border-med-text/20 bg-black/20 p-4">
            <p className="mb-3 text-sm text-med-text/80">Account already exists. Tap Sign In instead.</p>
            <button
              onClick={() => navigate('/signin', { state: { email: email.trim() } })}
              className="w-full rounded-full bg-med-text/90 py-3 text-sm font-medium text-[#071416]"
            >
              Sign In
            </button>
          </div>
        ) : null}
        {error ? <p className="mt-4 text-sm text-med-warn">{error}</p> : null}
        <div className="mt-8">
          <PrimaryButton onClick={startSignup} disabled={busy}>
            {busy ? 'Creating account…' : 'Continue'}
          </PrimaryButton>
        </div>
      </Shell>
    );
  }

  if (step === 4) {
    return (
      <Shell
        title="Display mode"
        subtitle="How the app looks on your phone. You can change this later."
        onBack={() => {
          setError(null);
          setStep(2);
        }}
      >
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
    return (
      <Shell
        title="How to end an alert"
        onBack={() => {
          setError(null);
          setStep(4);
        }}
      >
        <div className="space-y-5 text-sm leading-relaxed text-med-text/75">
          <p>
            To end an alert you press and <span className="text-med-text">hold the close control</span>{' '}
            until the ring completes. Your support contact then confirms — you’re always in the loop,
            never alone.
          </p>
          <div className="rounded-lg border border-med-text/20 bg-black/20 p-4 text-med-text/70">
            <p>
              If you are ever <span className="text-med-text">forced to end an alert against your will</span>,
              let go early — before the ring completes. To anyone watching it looks exactly the same, but
              your contact is silently warned the danger is ongoing.
            </p>
          </div>
          <p className="text-xs text-med-text/45">
            There’s nothing to memorize and no code to type — the gesture is the whole thing.
          </p>
        </div>
        {error ? <p className="mt-4 text-sm text-med-warn">{error}</p> : null}
        <div className="mt-8">
          <PrimaryButton onClick={() => void finalize()} disabled={busy}>
            {busy ? 'Setting up…' : 'Got it — continue'}
          </PrimaryButton>
        </div>
      </Shell>
    );
  }

  if (step === 6) {
    return (
      <Shell
        title="Add support contact"
        subtitle="The person we reach the moment you activate."
        onBack={() => {
          setError(null);
          setStep(5);
        }}
      >
        {/* Role (Brief): land her in the right slot — a Primary contact (first in
            the cascade) or your Guardian (the failsafe). Both are the same source
            of truth Settings shows. */}
        <div className="mb-5">
          <span className="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/50">
            Their role
          </span>
          <div className="flex gap-2">
            {([
              { key: 'primary', label: 'Primary contact' },
              { key: 'guardian', label: 'Guardian' },
            ] as const).map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setSupportRole(r.key)}
                className={`flex-1 rounded-lg border py-3 font-mono text-xs uppercase tracking-[0.08em] transition-colors ${
                  supportRole === r.key
                    ? 'border-med-text/80 bg-med-text/10 text-med-text'
                    : 'border-med-text/25 text-med-text/55'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <ContactForm
          busy={busy}
          error={error}
          submitLabel="Save support contact"
          onSubmit={(v) => void saveSupport(v)}
          slot={supportRole === 'guardian' ? 'guardian' : 'primary'}
          onLineConnected={() => setStep(7)}
        />
        <button onClick={() => setStep(7)} className="mt-5 block w-full text-center text-sm text-med-text/50 underline">
          Skip — add later in settings
        </button>
      </Shell>
    );
  }

  const grantPerms = async (): Promise<void> => {
    setPerms('asking');
    setPerms(await primePermissions());
  };
  const permsGranted = typeof perms === 'object';
  // Mic is the core capability: a denied mic means the system cannot do its job.
  // Onboarding may not complete to "armed" until mic is granted OR the user
  // explicitly acknowledges the degraded state (Brief 15 §B).
  const micOk = permsGranted && perms.mic;
  const resolved = micOk || degradedAck;

  return (
    <Shell title="You're set up" onBack={() => setStep(6)}>
      <div className="mb-6 rounded-lg border border-med-text/20 bg-black/20 p-5 text-sm leading-relaxed text-med-text/80">
        Email notifications enabled. Your support contact will receive an immediate email at
        activation. Most phones show this on the lock screen and on a connected watch.
      </div>

      {/* Prime mic + camera + location now, from this tap, so activation never
          triggers a permission prompt mid-alert. Each ask has one plain line of
          why; a denial is never a dead end (Brief 15 §B). */}
      <div className="mb-8 rounded-lg border border-med-text/20 bg-black/20 p-5 text-sm leading-relaxed text-med-text/80">
        <ul className="mb-4 space-y-1.5 text-[13px] text-med-text/70">
          <li><span className="text-med-text">Microphone</span> — captures what's happening so your contact has evidence.</li>
          <li><span className="text-med-text">Location</span> — tells your contact where you are.</li>
          <li><span className="text-med-text">Camera</span> (optional) — adds a visual record when possible.</li>
        </ul>
        {permsGranted ? (
          <p className="font-mono text-[12px] text-med-text/70">
            Microphone {perms.mic ? '✓ enabled' : '✕ not granted'} · Location{' '}
            {perms.location ? '✓ enabled' : '✕ not granted'} · Camera{' '}
            {perms.camera ? '✓' : '—'}
          </p>
        ) : (
          <button
            type="button"
            onClick={() => void grantPerms()}
            disabled={perms === 'asking'}
            className="w-full rounded-full border border-med-text/40 py-3 text-sm font-medium text-med-text disabled:opacity-50"
          >
            {perms === 'asking' ? 'Requesting…' : 'Enable microphone, camera & location'}
          </button>
        )}

        {/* Denial path: say plainly what's degraded + the OS path to fix it, and
            offer both a retry and an explicit degraded-acknowledge. Never silent,
            never a dead end. */}
        {permsGranted && !micOk ? (
          <div className="mt-4 rounded-md border border-med-warn/40 bg-med-warn/5 p-3 text-[12px] leading-relaxed text-med-text/80">
            <p className="mb-2 text-med-warn">
              Without the microphone, BLACK BOX cannot record an alert — its core job. You can fix
              this and try again, or continue with limited protection.
            </p>
            <p className="mb-3 text-med-text/55">{osFixHint()}</p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void grantPerms()}
                className="w-full rounded-full border border-med-text/40 py-2.5 text-sm font-medium text-med-text"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => setDegradedAck(true)}
                className={`w-full rounded-full py-2.5 text-xs ${
                  degradedAck ? 'text-med-text/40' : 'text-med-text/55 underline'
                }`}
              >
                {degradedAck ? '✓ Continuing with limited protection' : 'Continue with limited protection'}
              </button>
            </div>
          </div>
        ) : null}

        <p className="mt-3 text-[11px] leading-relaxed text-med-text/45">
          On iPhone, Safari may still ask again at the first activation — installing to your home
          screen (below) reduces this. Note: while your phone is locked or the app is in the
          background, the web app cannot keep recording — open and unlocked is required.
        </p>
      </div>

      <div className="mb-8">
        <InstallHint />
      </div>

      <PrimaryButton onClick={finish} disabled={!resolved}>
        {resolved ? 'Continue' : 'Enable the microphone to continue'}
      </PrimaryButton>
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
