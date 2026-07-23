import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '@/lib/api';
import { clearSession, getSessionToken, setSession, type DisplayMode } from '@/lib/auth';
import { loginWithPasskey, passkeySupported } from '@/lib/passkey';
import { OrgPortal, type OrgMember } from './OrgPortal';

/**
 * Org entry (Brief 23 §5) — a DISTINCT surface from the survivor sign-in, on purpose:
 * a coordinator and a survivor are different people with different threat models, and
 * conflating their doors is how a survivor ends up in a portal (or an aggressor at a
 * login form) they should never see.
 *
 * Coordinators sign in with the SAME passwordless mechanics as everyone else (passkey
 * primary, recovery code, email link) — the credential stack is account-generic. After
 * auth we DO NOT navigate into the survivor app; we stay on /org and gate on org staff
 * membership: a member gets the portal, anyone else gets an honest "no access" notice.
 *
 * NOT part of the Hidden facade (§0a): reachable only by typing /org; nothing in the
 * survivor skin links here, so no org UI ever appears in the covert app.
 */

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }): JSX.Element {
  return (
    <main className="stillpoint-bg animate-hue-drift motion-reduce:animate-none flex min-h-full w-full flex-col items-center justify-center overflow-y-auto p-8 text-med-text">
      <div className="w-full max-w-sm">
        <h1 className="mb-2 font-serif text-3xl font-light tracking-[0.04em]">{title}</h1>
        {subtitle ? <p className="mb-8 text-med-text/60">{subtitle}</p> : null}
        {children}
      </div>
    </main>
  );
}

function PrimaryButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      {...props}
      className="w-full rounded-full bg-med-text/90 py-4 font-sans text-base font-medium tracking-[0.04em] text-[#071416] transition-opacity hover:opacity-90 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

type Phase = 'loading' | 'signin' | 'portal' | 'no-access';
type Pane = 'choose' | 'email-link' | 'sent' | 'recovery';

export function OrgSignIn(): JSX.Element {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>(getSessionToken() ? 'loading' : 'signin');
  const [member, setMember] = useState<OrgMember | null>(null);
  const [pane, setPane] = useState<Pane>('choose');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = passkeySupported();

  async function checkMembership(): Promise<void> {
    const res = await api<{ member: OrgMember | null }>('/v1/org/me');
    if (res.data?.member) {
      setMember(res.data.member);
      setPhase('portal');
    } else {
      setPhase('no-access');
    }
  }

  useEffect(() => {
    if (getSessionToken()) void checkMembership();
  }, []);

  /** Land a completed sign-in WITHOUT leaving /org — persist, then gate on membership. */
  async function land(sessionToken: string, displayMode: DisplayMode): Promise<void> {
    setSession(sessionToken, displayMode, { name: '', email: email.trim() });
    setPhase('loading');
    await checkMembership();
  }

  async function signInWithPasskey(): Promise<void> {
    setError(null);
    setBusy(true);
    const result = await loginWithPasskey();
    setBusy(false);
    if (result.ok) {
      await land(result.data.sessionToken, result.data.displayMode);
      return;
    }
    if (result.reason === 'cancelled') return;
    setError(
      result.reason === 'unsupported'
        ? 'This device can’t use a passkey. Use an email link instead.'
        : 'That didn’t work. Try again, or use an email link.',
    );
  }

  async function sendLink(): Promise<void> {
    setError(null);
    setBusy(true);
    await api('/v1/auth/magic/start', { auth: false, body: { email: email.trim() } });
    setBusy(false);
    setPane('sent');
  }

  async function redeemRecoveryCode(): Promise<void> {
    setError(null);
    setBusy(true);
    const res = await api<{ sessionToken: string; displayMode: DisplayMode }>('/v1/auth/recovery/consume', {
      auth: false,
      body: { email: email.trim(), code },
    });
    setBusy(false);
    if (!res.ok || !res.data?.sessionToken) {
      setError(res.status === 0 ? 'No connection — check your signal and try again.' : 'That code didn’t work. Each code can be used once.');
      return;
    }
    await land(res.data.sessionToken, res.data.displayMode);
  }

  function signOut(): void {
    clearSession();
    setMember(null);
    setPane('choose');
    setPhase('signin');
  }

  if (phase === 'loading') {
    return <Shell title="Organisation portal"><p className="text-med-text/50">Checking access…</p></Shell>;
  }

  if (phase === 'portal' && member) {
    return <OrgPortal member={member} onSignOut={signOut} />;
  }

  if (phase === 'no-access') {
    return (
      <Shell title="No organisation access" subtitle="This account isn’t a coordinator or admin for any organisation.">
        <p className="mb-8 text-[13px] leading-relaxed text-med-text/60">
          If your organisation is part of the pilot, ask your admin for a coordinator enrollment code and redeem
          it in your own account first.
        </p>
        <PrimaryButton onClick={signOut}>Sign out</PrimaryButton>
      </Shell>
    );
  }

  // --- Not signed in: passwordless ladder (stays on /org) ---
  if (pane === 'sent') {
    return (
      <Shell title="Check your email" subtitle="If that address has an account, a sign-in link is on its way.">
        <p className="mb-8 text-[13px] leading-relaxed text-med-text/60">
          The link works once and expires in 15 minutes. After it signs you in, return to /org to open the portal.
        </p>
        <PrimaryButton onClick={() => setPane('choose')}>Back</PrimaryButton>
      </Shell>
    );
  }

  if (pane === 'email-link') {
    return (
      <Shell title="Sign in by email" subtitle="We’ll send a one-tap link. No password.">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          className="mb-4 w-full border-b border-med-text/25 bg-transparent py-2 text-lg text-med-text outline-none placeholder:text-med-text/30"
        />
        {error ? <p className="mb-3 text-sm text-med-warn">{error}</p> : null}
        <PrimaryButton onClick={() => void sendLink()} disabled={busy || !email.includes('@')}>
          {busy ? 'Sending…' : 'Send me a link'}
        </PrimaryButton>
        <button onClick={() => setPane('choose')} className="mt-4 block w-full text-center text-sm text-med-text/50 underline">
          Back
        </button>
      </Shell>
    );
  }

  if (pane === 'recovery') {
    return (
      <Shell title="Use a recovery code" subtitle="The code you saved when you set up.">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          className="mb-4 w-full border-b border-med-text/25 bg-transparent py-2 text-lg text-med-text outline-none placeholder:text-med-text/30"
        />
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="text"
          autoCapitalize="characters"
          placeholder="XXXX-XXXX-XXXX"
          className="mb-4 w-full border-b border-med-text/25 bg-transparent py-2 font-mono text-lg tracking-[0.1em] text-med-text outline-none placeholder:text-med-text/30"
        />
        {error ? <p className="mb-3 text-sm text-med-warn">{error}</p> : null}
        <PrimaryButton onClick={() => void redeemRecoveryCode()} disabled={busy || !email.includes('@') || code.trim().length < 8}>
          {busy ? 'Checking…' : 'Sign in'}
        </PrimaryButton>
        <button onClick={() => setPane('choose')} className="mt-4 block w-full text-center text-sm text-med-text/50 underline">
          Back
        </button>
      </Shell>
    );
  }

  return (
    <Shell title="Organisation sign-in" subtitle="For partner organisations and coordinators.">
      {supported ? (
        <PrimaryButton onClick={() => void signInWithPasskey()} disabled={busy}>
          {busy ? 'Waiting…' : 'Sign in with passkey'}
        </PrimaryButton>
      ) : (
        <PrimaryButton onClick={() => setPane('email-link')}>Sign in by email</PrimaryButton>
      )}
      {error ? <p className="mt-3 text-sm text-med-warn">{error}</p> : null}
      {supported ? (
        <button onClick={() => setPane('email-link')} className="mt-4 block w-full text-center text-sm text-med-text/50 underline">
          Use an email link instead
        </button>
      ) : null}
      <button onClick={() => setPane('recovery')} className="mt-3 block w-full text-center text-sm text-med-text/50 underline">
        Use a recovery code
      </button>
      <button onClick={() => navigate('/signin', { replace: true })} className="mt-3 block w-full text-center text-sm text-med-text/50 underline">
        Are you here for your own account? Sign in
      </button>
    </Shell>
  );
}
