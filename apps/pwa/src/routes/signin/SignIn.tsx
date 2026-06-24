import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { api } from '@/lib/api';
import { setSession, type DisplayMode } from '@/lib/auth';

/**
 * Sign in (Brief 14: email removed from the critical path). Existing users on a
 * new device authenticate with their email + password — no emailed code, no
 * verification gate, no outbound email required. On success it populates ALL
 * localStorage keys (session, user, displayMode, setupComplete) so the new device
 * renders the same display mode as the original. Reachable from the onboarding
 * Welcome screen.
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

export function SignIn(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const prefill = (location.state as { email?: string } | null)?.email ?? '';

  const [email, setEmail] = useState(prefill);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  async function signIn(): Promise<void> {
    setError(null);
    setNotFound(false);
    setBusy(true);
    const res = await api<{ sessionToken: string; displayMode: DisplayMode }>('/v1/auth/signin', {
      auth: false,
      body: { email: email.trim(), password },
    });
    if (res.status === 404) {
      setBusy(false);
      setNotFound(true);
      return;
    }
    if (res.status === 401) {
      setBusy(false);
      setError('Email or password is incorrect.');
      return;
    }
    if (!res.ok || !res.data?.sessionToken) {
      setBusy(false);
      setError(res.status === 0 ? 'No connection — check your signal and try again.' : 'Could not sign in. Try again.');
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

  return (
    <Shell title="Sign in" subtitle="Enter your email and password.">
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        className="mb-4 w-full border-b border-med-text/25 bg-transparent py-2 text-lg text-med-text outline-none placeholder:text-med-text/30"
      />
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        autoComplete="current-password"
        placeholder="Password"
        className="mb-4 w-full border-b border-med-text/25 bg-transparent py-2 text-lg text-med-text outline-none placeholder:text-med-text/30"
      />
      {error ? <p className="mb-3 text-sm text-med-warn">{error}</p> : null}
      <PrimaryButton onClick={signIn} disabled={busy || !email.includes('@') || password.length < 1}>
        {busy ? 'Signing in…' : 'Sign in'}
      </PrimaryButton>
      <button
        onClick={() => navigate('/onboarding')}
        className="mt-5 block w-full text-center text-sm text-med-text/50 underline"
      >
        New here? Create an account
      </button>
    </Shell>
  );
}
