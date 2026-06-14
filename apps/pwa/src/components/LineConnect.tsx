import { useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';

/**
 * QR-connect LINE pairing (Brief 18). The user NEVER types or looks up a LINE id.
 * They generate a connect code for a contact slot; we show the StillPoint Official
 * Account QR + deep link (carrying a one-tap prefilled token). The contact scans /
 * taps it in LINE and sends the prefilled message — the webhook then binds their
 * captured userId to the slot. This component starts the pairing, shows the QR, and
 * polls until the contact connects.
 */

interface StartResponse {
  nonce: string;
  deepLink: string;
  qrSvg: string;
  expiresAt: number;
}

type Phase = 'idle' | 'starting' | 'waiting' | 'connected' | 'expired' | 'error';

export function LineConnect({
  slot,
  contactName,
  onConnected,
}: {
  slot: string;
  contactName: string;
  onConnected: () => void;
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [pairing, setPairing] = useState<StartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const stopPolling = (): void => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
  useEffect(() => stopPolling, []);

  async function start(): Promise<void> {
    if (!contactName.trim()) {
      return;
    }
    setError(null);
    setPhase('starting');
    const res = await api<StartResponse & { error?: string; message?: string }>('/v1/me/line-pairing/start', {
      body: { slot, contactName: contactName.trim() },
    });
    if (!res.ok || !res.data?.nonce) {
      setPhase('error');
      setError(res.data?.message ?? 'Could not start LINE connect. Try again.');
      return;
    }
    setPairing(res.data);
    setPhase('waiting');
    const nonce = res.data.nonce;
    stopPolling();
    pollRef.current = window.setInterval(() => void poll(nonce), 2500);
  }

  async function poll(nonce: string): Promise<void> {
    const res = await api<{ status: Phase }>(`/v1/me/line-pairing/status?nonce=${encodeURIComponent(nonce)}`);
    if (!res.ok || !res.data) {
      return; // transient; keep polling
    }
    if (res.data.status === 'connected') {
      stopPolling();
      setPhase('connected');
      onConnected();
    } else if (res.data.status === 'expired') {
      stopPolling();
      setPhase('expired');
    }
  }

  if (phase === 'idle' || phase === 'starting' || phase === 'error') {
    return (
      <div className="rounded-lg border border-med-text/20 bg-black/20 p-4">
        <p className="text-[12px] leading-relaxed text-med-text/60">
          LINE connects by scanning — no IDs to type or look up. Add a name above, then generate a
          connect code for them to scan in LINE.
        </p>
        {error ? <p className="mt-2 text-sm text-status-active">{error}</p> : null}
        <button
          type="button"
          disabled={!contactName.trim() || phase === 'starting'}
          onClick={() => void start()}
          className="mt-3 w-full rounded-full bg-med-text/90 py-3 font-sans text-sm font-medium tracking-[0.04em] text-[#1a1f3a] transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {phase === 'starting' ? 'Generating…' : !contactName.trim() ? 'Add a name first' : 'Generate LINE connect code'}
        </button>
      </div>
    );
  }

  if (phase === 'connected') {
    return (
      <div className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-4 text-center">
        <p className="font-sans text-sm text-emerald-200">✓ LINE connected for {contactName || 'this contact'}.</p>
      </div>
    );
  }

  // waiting / expired
  return (
    <div className="rounded-lg border border-med-text/20 bg-black/20 p-4">
      {pairing ? (
        <div className="mx-auto mb-3 w-44 rounded-lg bg-white p-3" dangerouslySetInnerHTML={{ __html: pairing.qrSvg }} />
      ) : null}
      <p className="text-center text-[12px] leading-relaxed text-med-text/60">
        Have {contactName || 'them'} scan this with their LINE app, or tap below to open it on this
        phone. They just send the message that opens up — that&apos;s it.
      </p>
      {pairing ? (
        <a
          href={pairing.deepLink}
          className="mt-3 block w-full rounded-full border border-med-text/40 py-3 text-center font-sans text-sm text-med-text"
        >
          Open in LINE
        </a>
      ) : null}
      {phase === 'expired' ? (
        <>
          <p className="mt-3 text-center text-sm text-status-active">This code expired.</p>
          <button
            type="button"
            onClick={() => void start()}
            className="mt-2 w-full rounded-full bg-med-text/90 py-3 font-sans text-sm font-medium text-[#1a1f3a]"
          >
            New connect code
          </button>
        </>
      ) : (
        <p className="mt-3 flex items-center justify-center gap-2 text-center text-[12px] text-med-text/45">
          <span className="h-2 w-2 animate-pulse rounded-full bg-med-text/50" />
          Waiting for them to connect…
        </p>
      )}
    </div>
  );
}
