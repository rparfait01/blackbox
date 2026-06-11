import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { api } from '@/lib/api';
import { setSession, type DisplayMode } from '@/lib/auth';

/**
 * Sign in (W8A, BUG 2). For existing users on a new device. Email → OTP →
 * session. On success it populates ALL localStorage keys (session, user,
 * displayMode, setupComplete) so the new device renders the same display mode as
 * the original. Reachable only from the onboarding Welcome screen.
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
      className="w-full rounded-full bg-med-text/90 py-4 font-sans text-base font-medium tracking-[0.04em] text-[#1a1f3a] transition-opacity hover:opacity-90 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function SignIn(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const prefill = (location.state as { email?: string } | null)?.email ?? '';

  const [phase, setPhase] = useState<'email' | 'otp'>('email');
  const [email, setEmail] = useState(prefill);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [resend, setResend] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function sendCode(): Promise<void> {
    setError(null);
    setNotFound(false);
    setBusy(true);
    const res = await api('/v1/auth/signin/start', { auth: false, body: { email: email.trim() } });
    setBusy(false);
    if (res.ok) {
      setPhase('otp');
    } else if (res.status === 404) {
      setNotFound(true);
    } else {
      setError('Could not send a code. Try again.');
    }
  }

  async function resendCode(): Promise<void> {
    setResend('sending');
    const res = await api('/v1/auth/signin/start', { auth: false, body: { email: email.trim() } });
    setResend(res.ok ? 'sent' : 'error');
    window.setTimeout(() => setResend('idle'), 2000);
  }

  async function verify(): Promise<void> {
    setError(null);
    setBusy(true);
    const res = await api<{ sessionToken: string; displayMode: DisplayMode }>(
      '/v1/auth/signin/verify',
      { auth: false, body: { email: email.trim(), code } },
    );
    if (!res.ok || !res.data?.sessionToken) {
      setBusy(false);
      setError('Invalid code. Try again.');
      return;
    }
    const { sessionToken, displayMode } = res.data;
    // Persist the token first so /v1/me can authenticate, then fill the rest.
    setSession(sessionToken, displayMode, { name: '', email: email.trim() });
    const me = await api<{ user: { name: string | null; email: string | null; displayMode: string | null } }>(
      '/v1/me',
    );
    const mode = (me.data?.user.displayMode as DisplayMode | undefined) ?? displayMode;
    setSession(sessionToken, mode, {
      name: me.data?.user.name ?? '',
      email: me.data?.user.email ?? email.trim(),
    });
    setBusy(false);
    navigate(mode === 'direct' ? '/blackbox' : '/', { replace: true });
  }

  if (notFound) {
    return (
      <Shell title="No account found" subtitle="We couldn't find an account for that email.">
        <p className="mb-8 text-med-text/70">No account found. Tap Sign Up instead.</p>
        <PrimaryButton onClick={() => navigate('/onboarding')}>Sign Up</PrimaryButton>
        <button
          onClick={() => {
            setNotFound(false);
            setEmail('');
          }}
          className="mt-4 block w-full text-center text-sm text-med-text/50 underline"
        >
          Try a different email
        </button>
      </Shell>
    );
  }

  if (phase === 'email') {
    return (
      <Shell title="Sign in" subtitle="Enter your email and we'll send a 6-digit code.">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          placeholder="you@example.com"
          className="mb-4 w-full border-b border-med-text/25 bg-transparent py-2 text-lg text-med-text outline-none placeholder:text-med-text/30"
        />
        {error ? <p className="mb-3 text-sm text-status-active">{error}</p> : null}
        <PrimaryButton onClick={sendCode} disabled={busy || !email.includes('@')}>
          {busy ? 'Sending…' : 'Send code'}
        </PrimaryButton>
      </Shell>
    );
  }

  return (
    <Shell title="Verify your email" subtitle={`We sent a 6-digit code to ${email}.`}>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
        inputMode="numeric"
        placeholder="------"
        className="mb-2 w-full border-b border-med-text/25 bg-transparent py-3 text-center font-mono text-3xl tracking-[0.4em] text-med-text outline-none placeholder:text-med-text/20"
      />
      {error ? <p className="mb-2 text-sm text-status-active">{error}</p> : null}
      <button
        onClick={resendCode}
        disabled={resend === 'sending'}
        className="mb-8 text-sm text-med-text/50 underline disabled:no-underline disabled:opacity-60"
      >
        {resend === 'sending'
          ? 'Sending…'
          : resend === 'sent'
            ? 'Code sent'
            : resend === 'error'
              ? 'Could not send — try again'
              : 'Resend code'}
      </button>
      <PrimaryButton onClick={verify} disabled={busy || code.length !== 6}>
        {busy ? 'Verifying…' : 'Verify'}
      </PrimaryButton>
    </Shell>
  );
}
