import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '@/lib/api';
import { setSession, type DisplayMode } from '@/lib/auth';
import { loginWithPasskey, passkeySupported } from '@/lib/passkey';

/**
 * Sign in — PASSWORDLESS (Accounts §1). There is no password field here, and there
 * is no way to make one appear.
 *
 * The ladder, in the order it is offered:
 *   1. PASSKEY — one tap, Face ID / Touch ID / device PIN. Nothing typed, nothing
 *      remembered, nothing an abuser could have found written down.
 *   2. EMAIL LINK — only for a device that cannot do passkeys, or an account that
 *      does not have one yet (the pilot's migration path). The server REFUSES this
 *      for any account that holds a passkey, so email is never a standing way in.
 *   3. RECOVERY CODE — the discreet backup, for a lost device with no keychain.
 *
 * Nothing here is a dead end: every failure leaves another rung visible.
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

type Pane = 'choose' | 'email-link' | 'sent' | 'recovery';

export function SignIn(): JSX.Element {
  const navigate = useNavigate();
  const [pane, setPane] = useState<Pane>('choose');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = passkeySupported();

  /** Land a completed sign-in: persist, then correct displayMode from server truth. */
  async function land(sessionToken: string, displayMode: DisplayMode, fallbackEmail: string): Promise<void> {
    setSession(sessionToken, displayMode, { name: '', email: fallbackEmail });
    const me = await api<{ user: { name: string | null; email: string | null; displayMode: string | null } }>('/v1/me');
    const mode = (me.data?.user.displayMode as DisplayMode | undefined) ?? displayMode;
    setSession(sessionToken, mode, {
      name: me.data?.user.name ?? '',
      email: me.data?.user.email ?? fallbackEmail,
    });
    navigate(mode === 'direct' ? '/blackbox' : '/', { replace: true });
  }

  async function signInWithPasskey(): Promise<void> {
    setError(null);
    setBusy(true);
    const result = await loginWithPasskey();
    setBusy(false);
    if (result.ok) {
      await land(result.data.sessionToken, result.data.displayMode, '');
      return;
    }
    // A dismissed sheet is a choice, not an error — say nothing and leave the
    // other rungs visible.
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
    // Always 200 — the server never reveals whether the account exists or already
    // holds a passkey, so the UI cannot reveal it either.
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
      setError(
        res.status === 0
          ? 'No connection — check your signal and try again.'
          : 'That code didn’t work. Each code can be used once.',
      );
      return;
    }
    await land(res.data.sessionToken, res.data.displayMode, email.trim());
  }

  if (pane === 'sent') {
    return (
      <Shell title="Check your email" subtitle="If that address has an account, a sign-in link is on its way.">
        <p className="mb-8 text-[13px] leading-relaxed text-med-text/60">
          The link works once and expires in 15 minutes. If your account already uses a passkey, sign in with
          that instead — we don’t send links to accounts protected by a passkey.
        </p>
        <PrimaryButton onClick={() => setPane('choose')}>Back to sign in</PrimaryButton>
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
    <Shell title="Sign in" subtitle={supported ? 'Use your face, fingerprint, or device PIN.' : 'We’ll send a one-tap link to your email.'}>
      {supported ? (
        <PrimaryButton onClick={() => void signInWithPasskey()} disabled={busy}>
          {busy ? 'Waiting…' : 'Sign in with passkey'}
        </PrimaryButton>
      ) : (
        <PrimaryButton onClick={() => setPane('email-link')}>Sign in by email</PrimaryButton>
      )}
      {error ? <p className="mt-3 text-sm text-med-warn">{error}</p> : null}

      {/* Fallbacks stay reachable no matter what fails above — never a dead end. */}
      {supported ? (
        <button onClick={() => setPane('email-link')} className="mt-4 block w-full text-center text-sm text-med-text/50 underline">
          Use an email link instead
        </button>
      ) : null}
      <button onClick={() => setPane('recovery')} className="mt-3 block w-full text-center text-sm text-med-text/50 underline">
        Use a recovery code
      </button>
      <button onClick={() => navigate('/onboarding')} className="mt-3 block w-full text-center text-sm text-med-text/50 underline">
        New here? Create an account
      </button>
    </Shell>
  );
}
