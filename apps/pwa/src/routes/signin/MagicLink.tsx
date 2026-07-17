import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { api } from '@/lib/api';
import { setSession, type DisplayMode } from '@/lib/auth';
import { enrollPasskey, passkeySupported } from '@/lib/passkey';

/**
 * Landing screen for an emailed sign-in link (Accounts §1b).
 *
 * This replaces the deleted password-reset screen. It sets no password — there is
 * no password — it exchanges a single-use token for a session.
 *
 * It then offers to enroll a passkey, and that offer is the point of the whole
 * flow: it is how an account STOPS being reachable by email. The server refuses to
 * mail a link to any account holding a passkey, so accepting here closes the inbox
 * as a way in. This is the pilot's migration path, one survivor at a time.
 */

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }): JSX.Element {
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

export function MagicLink(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'working' | 'offer-passkey' | 'invalid' | 'signed-in'>('working');
  const [mode, setMode] = useState<DisplayMode>('covert');
  const [busy, setBusy] = useState(false);
  // The token is single-use: StrictMode's double-effect would spend it twice and
  // the second call would (correctly) report it invalid.
  const consumed = useRef(false);

  useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;
    void (async () => {
      if (!token) {
        setState('invalid');
        return;
      }
      const res = await api<{ sessionToken: string; displayMode: DisplayMode }>('/v1/auth/magic/consume', {
        auth: false,
        body: { token },
      });
      if (!res.ok || !res.data?.sessionToken) {
        setState('invalid');
        return;
      }
      const { sessionToken, displayMode } = res.data;
      setSession(sessionToken, displayMode, { name: '', email: '' });
      const me = await api<{ user: { name: string | null; email: string | null; displayMode: string | null } }>('/v1/me');
      const resolved = (me.data?.user.displayMode as DisplayMode | undefined) ?? displayMode;
      setSession(sessionToken, resolved, {
        name: me.data?.user.name ?? '',
        email: me.data?.user.email ?? '',
      });
      setMode(resolved);
      // Signed in. Offer the passkey — but only where it can actually be created;
      // a device with no WebAuthn support just continues, already signed in. The
      // fallback must not become a dead end merely because it can't be upgraded.
      setState(passkeySupported() ? 'offer-passkey' : 'signed-in');
    })().catch(() => setState('invalid'));
  }, [token]);

  const home = (m: DisplayMode): string => (m === 'direct' ? '/blackbox' : '/');

  useEffect(() => {
    if (state === 'signed-in') navigate(home(mode), { replace: true });
  }, [state, mode, navigate]);

  if (state === 'working' || state === 'signed-in') {
    return <Shell title="Signing you in…" subtitle="One moment." />;
  }

  if (state === 'invalid') {
    return (
      <Shell title="That link didn’t work" subtitle="Links work once and expire after 15 minutes.">
        <p className="mb-8 text-[13px] leading-relaxed text-med-text/60">
          If your account uses a passkey, sign in with that instead — we don’t send links to accounts
          protected by a passkey.
        </p>
        <PrimaryButton onClick={() => navigate('/signin', { replace: true })}>Back to sign in</PrimaryButton>
      </Shell>
    );
  }

  return (
    <Shell title="Set up a passkey" subtitle="So you never need an email link again.">
      <p className="mb-6 text-[13px] leading-relaxed text-med-text/70">
        A passkey signs you in with your face, fingerprint, or device PIN. It stays on your device, and it
        means we’ll stop sending sign-in links for your account — so your email can’t be used to get in.
      </p>
      <PrimaryButton
        onClick={() => {
          setBusy(true);
          void enrollPasskey().then((r) => {
            setBusy(false);
            // Enrolled or not, the user is already signed in — continue either way.
            if (r.ok || r.reason !== 'failed') navigate(home(mode), { replace: true });
          });
        }}
        disabled={busy}
      >
        {busy ? 'Waiting…' : 'Create a passkey'}
      </PrimaryButton>
      <button
        onClick={() => navigate(home(mode), { replace: true })}
        className="mt-4 block w-full text-center text-sm text-med-text/50 underline"
      >
        Not now
      </button>
    </Shell>
  );
}
