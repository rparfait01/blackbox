import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import { api } from '@/lib/api';

/**
 * Guardian accept page (W8A). The guardian opens this from the invite email. It
 * is on THEIR device (not covert): a clear consent screen, then an email OTP to
 * verify a reach channel. On success their email becomes a priority-1 endpoint
 * on the user's contact. No login, no account — the invite token is the auth.
 */

interface InviteInfo {
  userName: string;
  relationship: string | null;
  status: string;
}

type Phase = 'loading' | 'invalid' | 'expired' | 'consent' | 'enter-email' | 'enter-otp' | 'done';

export function GuardianAccept(): JSX.Element {
  const { inviteId } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';
  const q = `?t=${encodeURIComponent(token)}`;

  const [phase, setPhase] = useState<Phase>('loading');
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<InviteInfo>(`/v1/guardians/accept/${inviteId}${q}`, { auth: false }).then((res) => {
      if (res.ok && res.data) {
        setInfo(res.data);
        setPhase(res.data.status === 'accepted' ? 'done' : 'consent');
      } else {
        setPhase(res.status === 401 ? 'expired' : 'invalid');
      }
    });
  }, [inviteId, q]);

  async function sendOtp(): Promise<void> {
    setError(null);
    setBusy(true);
    const res = await api(`/v1/guardians/accept/${inviteId}/otp${q}`, {
      auth: false,
      body: { channel: 'email', identifier: email.trim() },
    });
    setBusy(false);
    if (res.ok) {
      setPhase('enter-otp');
    } else {
      setError('Could not send a code to that email.');
    }
  }

  async function verify(): Promise<void> {
    setError(null);
    setBusy(true);
    const res = await api<{ ok: boolean }>(`/v1/guardians/accept/${inviteId}/verify${q}`, {
      auth: false,
      body: { channel: 'email', identifier: email.trim(), code },
    });
    setBusy(false);
    if (res.ok && res.data?.ok) {
      setPhase('done');
    } else {
      setError('That code is not valid. Try again.');
    }
  }

  return (
    <main className="stillpoint-bg flex min-h-full w-full flex-col items-center justify-center p-8 text-med-text">
      <div className="w-full max-w-sm text-center">
        <div className="mb-6 font-mono text-[11px] uppercase tracking-[0.2em] text-med-text/50">
          BLACK BOX
        </div>

        {phase === 'loading' ? <p className="text-med-text/60">Loading…</p> : null}

        {phase === 'invalid' ? (
          <p className="text-med-text/70">This invitation link is not valid.</p>
        ) : null}
        {phase === 'expired' ? (
          <p className="text-med-text/70">This invitation has expired. Ask them to send a new one.</p>
        ) : null}

        {phase === 'consent' && info ? (
          <>
            <h1 className="mb-4 font-serif text-2xl font-light leading-snug">
              {info.userName} added you as their support contact
              {info.relationship ? ` (${info.relationship})` : ''}.
            </h1>
            <p className="mb-10 text-med-text/65">
              If they ever activate BLACK BOX, you'll be the one we reach — with their live location
              and audio. Confirm to accept.
            </p>
            <PrimaryButton onClick={() => setPhase('enter-email')}>I accept</PrimaryButton>
          </>
        ) : null}

        {phase === 'enter-email' ? (
          <>
            <h1 className="mb-6 font-serif text-2xl font-light">Verify your email</h1>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              placeholder="you@example.com"
              className="mb-4 w-full border-b border-med-text/25 bg-transparent py-2 text-center text-lg text-med-text outline-none placeholder:text-med-text/30"
            />
            {error ? <p className="mb-3 text-sm text-status-active">{error}</p> : null}
            <PrimaryButton onClick={sendOtp} disabled={busy || !email.includes('@')}>
              {busy ? 'Sending…' : 'Send code'}
            </PrimaryButton>
          </>
        ) : null}

        {phase === 'enter-otp' ? (
          <>
            <h1 className="mb-6 font-serif text-2xl font-light">Enter the code</h1>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
              inputMode="numeric"
              placeholder="------"
              className="mb-4 w-full border-b border-med-text/25 bg-transparent py-3 text-center font-mono text-3xl tracking-[0.4em] text-med-text outline-none placeholder:text-med-text/20"
            />
            {error ? <p className="mb-3 text-sm text-status-active">{error}</p> : null}
            <PrimaryButton onClick={verify} disabled={busy || code.length !== 6}>
              {busy ? 'Verifying…' : 'Confirm'}
            </PrimaryButton>
          </>
        ) : null}

        {phase === 'done' ? (
          <>
            <h1 className="mb-4 font-serif text-2xl font-light">You're confirmed</h1>
            <p className="text-med-text/65">
              {info ? `${info.userName} ` : ''}now reaches you here. You can close this page.
            </p>
          </>
        ) : null}
      </div>
    </main>
  );
}

function PrimaryButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      {...props}
      className="w-full rounded-full bg-med-text/90 py-4 font-sans text-base font-medium text-[#1a1f3a] transition-opacity hover:opacity-90 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
