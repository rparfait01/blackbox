import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CaretLeft } from '@phosphor-icons/react';

import { api } from '@/lib/api';
import { cacheEntitlement, setSession, type DisplayMode } from '@/lib/auth';
import { primePermissions } from '@/lib/permissions';
import { enrollPasskey } from '@/lib/passkey';
import { provisionSurvivorKey } from '@/lib/crypto/key-provisioning';
import { ensureCadenceMapping } from '@/lib/retention-signal';
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
  const [country, setCountry] = useState<CountryOption>(defaultCountry());
  const [phoneLocal, setPhoneLocal] = useState('');
  const [regionId, setRegionId] = useState(defaultCountry().regionId);
  const [nationality, setNationality] = useState('');
  // Brief 30 Fix A — the signed, scoped, expiring capability. The old `signupId` was the
  // account's permanent id and authorized nothing safely.
  const [capability, setCapability] = useState('');
  // §B — a nonce this client generates and keeps for the whole ceremony. The capability commits
  // to it, so a capability lifted from a log cannot be replayed from somewhere else.
  const [bindNonce] = useState(() => crypto.randomUUID());
  const [emailExists, setEmailExists] = useState(false);
  // Brief 30 §C — the access code that opens the front door. Pre-filled from ?code= so
  // the Gumroad success redirect lands the buyer on a form they only have to confirm;
  // they never have to copy a code out of an email that may not have arrived yet.
  const [accessCode, setAccessCode] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('code')?.trim() ?? '';
    } catch {
      return '';
    }
  });

  // support person captured at signup (Brief: persists to the SAME slots model
  // Settings + the cascade use — primary contact or guardian).
  const [supportRole, setSupportRole] = useState<'primary' | 'guardian'>('primary');
  // §2: "everybody has somebody" is enforced HERE — at setup, the only safe place.
  // Setup cannot complete until a contact is actually saved server-side (this flips
  // on a confirmed save, never on intent), so a new account effectively always has
  // someone to notify. It is deliberately NOT enforced at the trigger: a panic
  // button that refuses to fire is the one failure this product cannot ship.
  const [contactSaved, setContactSaved] = useState(false);

  // display mode (the closure pin is retired — §E2 gesture closure)
  const [displayMode, setMode] = useState<DisplayMode>('covert');

  // permissions priming (mic + location), requested from a user gesture here so
  // activation never triggers a permission dialog.
  const [perms, setPerms] = useState<'idle' | 'asking' | { mic: boolean; camera: boolean; location: boolean }>('idle');
  // Explicit acknowledgement that the user is proceeding with a degraded (mic-denied)
  // setup — the only non-granted way past the permission gate (Brief 15 §B).
  const [degradedAck, setDegradedAck] = useState(false);

  // §1/§2: passkey + recovery code. `passkeyState` drives the credential step;
  // `recoveryCodes` are shown ONCE and never retrievable again.
  const [passkeyState, setPasskeyState] = useState<'idle' | 'working' | 'enrolled' | 'unsupported' | 'failed'>('idle');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [codeAck, setCodeAck] = useState(false);

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
    if (!accessCode.trim()) {
      setError('An access code is required to create an account.');
      return;
    }
    setBusy(true);
    // Brief 14: create the account immediately. No email is sent and no email
    // delivery can fail here — we go straight on to display mode.
    // §1: no password is sent. The account is created with passwordHash NULL and
    // authenticates by passkey (enrolled at step 7).
    const res = await api<{ signupId?: string; capability?: string; error?: string; message?: string }>('/v1/auth/signup/start', {
      auth: false,
      body: {
        name: name.trim(),
        email: email.trim(),
        phone: phoneE164(),
        regionId,
        nationality,
        code: accessCode.trim(),
        bindNonce,
      },
    });
    setBusy(false);
    if (res.ok && res.data?.capability) {
      setCapability(res.data.capability);
      setStep(4);
    } else if (res.status === 409) {
      setEmailExists(true);
    } else if (res.status === 0) {
      setError('No connection — we couldn’t create your account. Check your signal and try again.');
    } else if (res.data?.message) {
      // The server names exactly what is wrong with the code (missing / not recognised /
      // expired / cancelled / already used). Show THAT, never a generic shrug — a buyer
      // who mistypes one character must be told so, not left guessing.
      setError(res.data.message);
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
        body: { capability, bindNonce, displayMode, claimUserHash: userHash },
      },
    );
    setBusy(false);
    if (res.ok && res.data?.sessionToken) {
      setSession(res.data.sessionToken, displayMode, { name: name.trim(), email: email.trim() });
      // Brief 28 §2 — a brand-new account is server-side 'unactivated'. Cache that
      // explicitly so the arm gate applies to new users, while a CLEARED cache (an
      // offline reinstall) stays 'unknown' and fails OPEN. New = gated; reinstall = armed.
      cacheEntitlement({ status: 'unactivated', source: null });
      // Brief 26 — provision the survivor's envelope key in the BACKGROUND. Fire-and-forget
      // and flag-gated: it never blocks reaching Armed and is a no-op unless encryption is
      // armed. If it fails or hangs, captures simply stay plaintext (same fail-open rule as
      // the send path). The recovery-wrapped copy is added when the code is shown, below.
      provisionSurvivorKey();
      // Brief 36 §D — pick THIS account's retention-cadence mapping, once. Idempotent and
      // fire-and-forget, on the same rule as key provisioning: it must never block reaching
      // Armed. Assigned at random from a small fixed set so there is no universal tell —
      // for half the mappings the cadence slows when evidence is at risk and for the other
      // half it quickens, which is what stops one account's behaviour from revealing any
      // other's. An account that somehow reaches capture without one falls back to the
      // facade's own default cadence, which looks exactly like it always has.
      void ensureCadenceMapping();
      // Step 3 (once the retired email-OTP step) is now the CREDENTIAL step: the
      // session exists from here, so the passkey and recovery code can be created
      // against it. It sits before contacts so the account is never left with no
      // way back in.
      setStep(3);
    } else {
      setError(
        res.status === 0
          ? 'No connection — we couldn’t finish setting up. Check your signal and try again.'
          : 'Could not finish setting up your account. Please try again.',
      );
    }
  }

  /**
   * §1: enroll the passkey. A cancel or an unsupported device is NOT a dead end —
   * the recovery code below still gets the survivor back in, and the magic link
   * still works for an account with no passkey. So we record the outcome and move
   * on rather than trapping anyone here.
   */
  async function createPasskey(): Promise<void> {
    setPasskeyState('working');
    const result = await enrollPasskey();
    if (result.ok) {
      setPasskeyState('enrolled');
      return;
    }
    setPasskeyState(result.reason === 'unsupported' ? 'unsupported' : result.reason === 'cancelled' ? 'idle' : 'failed');
  }

  /** §2: mint the one-time recovery code. Shown ONCE — never retrievable after. */
  async function createRecoveryCodes(): Promise<void> {
    const res = await api<{ codes: string[] }>('/v1/auth/recovery/issue', { body: {} });
    if (res.ok && res.data?.codes?.length) {
      setRecoveryCodes(res.data.codes);
      // Brief 26 decision A — add the recovery-code-wrapped private key so a new device can
      // restore it. Background + fail-open; never blocks showing the code or reaching Armed.
      provisionSurvivorKey(res.data.codes[0]);
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
      body: {
        contactName: values.name,
        channel: values.channel,
        destination: values.destination,
        // §2: optional backup channel — tried before this contact is ever reported
        // as not reached.
        fallbackChannel: values.fallbackChannel ?? null,
        fallbackDestination: values.fallbackDestination ?? null,
      },
    });
    setBusy(false);
    if (res.ok) {
      // Only a CONFIRMED server-side save satisfies §2 — never the attempt.
      setContactSaved(true);
      setStep(7);
    } else if (res.status === 0) {
      setError('No connection — we couldn’t save your contact. Check your signal and try again.');
    } else if (res.data?.message) {
      // Surface the server's SPECIFIC reason verbatim (missing country code, wrong
      // LINE id, channel unavailable) — a generic message here would hide the only
      // thing that tells the user how to fix it, at the step they cannot skip.
      setError(res.data.message);
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
        subtitle="No password — you’ll sign in with your face, fingerprint, or device PIN."
        onBack={() => {
          setError(null);
          setStep(1);
        }}
      >
        <div className="space-y-5">
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name or alias" />
          <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
          {/* Brief 30 §C — the access code. Case and separators are normalized server-side
              (Brief 28 §4), so a buyer may type it however they read it. */}
          <div>
            <Field
              label="Access code"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value)}
              placeholder="Licence key or access code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
            />
            <p className="mt-1 font-sans text-[12px] leading-relaxed text-med-text/45">
              Your licence key from the purchase receipt, or the code the organisation that
              referred you gave you. Upper or lower case and the dashes don’t matter.
            </p>
          </div>
          {/* §1: NO password field. There is nothing to remember and nothing to
              write down — so there is no credential an abuser can find. */}
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

  // Step 3 — CREDENTIALS (§1 passkey + §2 recovery code). Runs straight after
  // finalize, so a brand-new account always has a way back in before it has
  // anything worth protecting. Never a dead end: the passkey can be skipped (magic
  // link still works while no passkey exists), and the recovery code covers the
  // lost-device-with-no-keychain case that the keychain cannot.
  if (step === 3) {
    return (
      <Shell title="Secure your account" subtitle="No password to remember, and nothing to write down that someone could find.">
        {recoveryCodes ? (
          <>
            <p className="mb-4 text-[13px] leading-relaxed text-med-text/70">
              Save this recovery code somewhere only you can reach. It gets you back in if you lose your
              device. We’ll only show it once, and we can’t send it to you later.
            </p>
            <div className="mb-4 rounded-lg border border-med-text/25 bg-black/30 p-4 text-center">
              {recoveryCodes.map((c) => (
                <p key={c} className="font-mono text-xl tracking-[0.18em] text-med-text">
                  {c}
                </p>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setCodeAck(!codeAck)}
              className={`mb-5 flex w-full items-start gap-3 rounded-lg border p-3 text-left text-[12px] leading-relaxed transition-colors ${
                codeAck ? 'border-med-text/60 text-med-text' : 'border-med-text/25 text-med-text/60'
              }`}
            >
              <span aria-hidden className="font-mono">{codeAck ? '✓' : '○'}</span>
              I’ve saved my recovery code somewhere safe.
            </button>
            <PrimaryButton onClick={() => setStep(6)} disabled={!codeAck}>
              {codeAck ? 'Continue' : 'Save your code to continue'}
            </PrimaryButton>
          </>
        ) : (
          <>
            <div className="mb-6 rounded-lg border border-med-text/20 bg-black/20 p-5 text-sm leading-relaxed text-med-text/80">
              <p className="mb-2">
                A <span className="text-med-text">passkey</span> signs you in with your face, fingerprint, or
                device PIN. It stays on this device and syncs to your other devices through your
                Apple or Google account — so a new phone signs in on its own.
              </p>
              <p className="text-med-text/60">
                There’s nothing to type and nothing to write down, so there’s no password for anyone else to find.
              </p>
            </div>

            {passkeyState === 'enrolled' ? (
              <p className="mb-5 font-mono text-[12px] text-med-text/70">✓ Passkey created on this device</p>
            ) : passkeyState === 'unsupported' ? (
              <p className="mb-5 rounded-md border border-med-warn/40 bg-med-warn/5 p-3 text-[12px] leading-relaxed text-med-text/80">
                This device can’t make a passkey. You’ll sign in with a one-tap email link instead — and the
                recovery code below still works.
              </p>
            ) : passkeyState === 'failed' ? (
              <p className="mb-5 rounded-md border border-med-warn/40 bg-med-warn/5 p-3 text-[12px] leading-relaxed text-med-text/80">
                That didn’t work. You can try again, or continue — your recovery code will still get you in.
              </p>
            ) : null}

            {passkeyState !== 'enrolled' && passkeyState !== 'unsupported' ? (
              <PrimaryButton onClick={() => void createPasskey()} disabled={passkeyState === 'working'}>
                {passkeyState === 'working' ? 'Waiting…' : passkeyState === 'failed' ? 'Try again' : 'Create a passkey'}
              </PrimaryButton>
            ) : null}

            <button
              type="button"
              onClick={() => void createRecoveryCodes()}
              className={`${passkeyState !== 'enrolled' && passkeyState !== 'unsupported' ? 'mt-4' : ''} block w-full text-center text-sm text-med-text/50 underline`}
            >
              {passkeyState === 'enrolled' || passkeyState === 'unsupported' ? 'Continue' : 'Skip — set up a passkey later'}
            </button>
          </>
        )}
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
          onLineConnected={() => {
            setContactSaved(true);
            setStep(7);
          }}
        />
        {/* §2: NO skip. This step is the enforcement point for "everybody has
            somebody" — an account that finishes setup with no one to notify is an
            account whose alert reaches nobody, and the survivor would not know it.
            Setup is the only safe place to require this: the trigger itself is
            never gated, so this can never become a reason a button won't fire. */}
        <p className="mt-5 text-center text-[12px] leading-relaxed text-med-text/50">
          Add at least one person who should be notified if you trigger. You can change or add more
          in Settings at any time.
        </p>
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
  const permsResolved = micOk || degradedAck;
  // §2: setup completes only with a saved contact AND a resolved mic. Step 6 has no
  // skip, so contactSaved is normally already true here — this is the belt-and-braces
  // that keeps the guarantee if a bypass is ever reintroduced upstream. Degraded mic
  // stays acknowledgeable (Brief 15 §B); a missing CONTACT is not — that is the whole
  // point of §2. Neither gate ever touches the trigger.
  const resolved = permsResolved && contactSaved;

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

      {/* Name the ACTUAL blocker — never blame the mic for a missing contact. */}
      {!contactSaved ? (
        <button
          type="button"
          onClick={() => setStep(6)}
          className="mb-3 w-full rounded-full border border-med-warn/40 py-2.5 text-[12px] leading-relaxed text-med-warn"
        >
          Add someone to notify first
        </button>
      ) : null}
      <PrimaryButton onClick={finish} disabled={!resolved}>
        {resolved
          ? 'Continue'
          : !contactSaved
            ? 'Add a contact to continue'
            : 'Enable the microphone to continue'}
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
