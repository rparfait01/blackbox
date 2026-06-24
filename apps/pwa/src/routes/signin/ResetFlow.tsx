import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { api } from '@/lib/api';

/**
 * Forgot-password flow (Fix Brief 15 §D). Two screens in the Stillpoint design
 * language: request a reset link (by email), and set a new password from the
 * single-use link. The request screen never reveals whether an account exists.
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

export function ForgotPassword(): JSX.Element {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    await api('/v1/auth/forgot', { auth: false, body: { email: email.trim() } });
    setBusy(false);
    setSent(true); // always — never reveal whether the account exists
  }

  if (sent) {
    return (
      <Shell title="Check your email" subtitle="If an account exists for that address, a reset link is on its way.">
        <p className="mb-8 text-med-text/70">The link is valid for one hour and can be used once.</p>
        <PrimaryButton onClick={() => navigate('/signin')}>Back to sign in</PrimaryButton>
      </Shell>
    );
  }

  return (
    <Shell title="Reset password" subtitle="Enter your account email and we’ll send a reset link.">
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        className="mb-6 w-full border-b border-med-text/25 bg-transparent py-2 text-lg text-med-text outline-none placeholder:text-med-text/30"
      />
      <PrimaryButton onClick={submit} disabled={busy || !email.includes('@')}>
        {busy ? 'Sending…' : 'Send reset link'}
      </PrimaryButton>
      <button onClick={() => navigate('/signin')} className="mt-5 block w-full text-center text-sm text-med-text/50 underline">
        Back to sign in
      </button>
    </Shell>
  );
}

export function ResetPassword(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setError(null);
    setBusy(true);
    const res = await api('/v1/auth/reset', { auth: false, body: { token, password } });
    setBusy(false);
    if (res.ok) {
      navigate('/signin', { replace: true });
      return;
    }
    setError(
      res.status === 400
        ? 'This reset link is invalid or has expired. Request a new one.'
        : res.status === 0
          ? 'No connection — check your signal and try again.'
          : 'Could not reset your password. Try again.',
    );
  }

  if (!token) {
    return (
      <Shell title="Reset link needed" subtitle="Open the reset link from your email to set a new password.">
        <PrimaryButton onClick={() => navigate('/forgot')}>Request a reset link</PrimaryButton>
      </Shell>
    );
  }

  return (
    <Shell title="Set a new password" subtitle="Choose a new password. All other devices will be signed out.">
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        autoComplete="new-password"
        placeholder="At least 6 characters"
        className="mb-4 w-full border-b border-med-text/25 bg-transparent py-2 text-lg text-med-text outline-none placeholder:text-med-text/30"
      />
      {error ? <p className="mb-3 text-sm text-med-warn">{error}</p> : null}
      <PrimaryButton onClick={submit} disabled={busy || password.length < 6}>
        {busy ? 'Saving…' : 'Set new password'}
      </PrimaryButton>
      <button onClick={() => navigate('/signin')} className="mt-5 block w-full text-center text-sm text-med-text/50 underline">
        Back to sign in
      </button>
    </Shell>
  );
}
