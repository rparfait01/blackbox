import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Gear } from '@phosphor-icons/react';

import { api } from '@/lib/api';
import { isSetupComplete } from '@/lib/auth';
import { triggerActivation } from '@/lib/activation';
import { useActiveAlert, useActiveAlertStart } from '@/lib/active-alert';
import { formatElapsed } from '@/lib/time';
import { PinEntryOverlay } from '@/routes/meditation/PinEntryOverlay';

/**
 * Direct-mode home (W8A) — the BLACK BOX interface from the reference design,
 * section 01. Wordmark explicit, no facade. The phone stays visually dormant at
 * all times (no on-device feedback during a session, by principle); tapping the
 * disc activates silently.
 */

interface SlotView {
  slot: string;
  filled: boolean;
  contactName: string | null;
  channel: string | null;
}
interface ContactsResponse {
  slots: SlotView[];
}
const CHANNEL_LABEL: Record<string, string> = { sms: 'Text', line: 'LINE', email: 'Email' };

export function BlackBoxHome(): JSX.Element {
  // Read the SAME slot model Settings + the cascade use (single source of truth),
  // so a contact added at signup shows here with no re-add.
  const [support, setSupport] = useState<{ name: string; channel: string | null; role: string } | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const alertActive = useActiveAlert();
  // Elapsed alert time (overt: the instrument shows the live recording clock).
  const alertStart = useActiveAlertStart();
  const [now, setNow] = useState(() => Date.now());
  const [checkin, setCheckin] = useState<'idle' | 'sending' | 'done'>('idle');
  const [checkinLoc, setCheckinLoc] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    void api<ContactsResponse>('/v1/me/contacts').then((res) => {
      if (res.ok && res.data) {
        // Prefer the primary contact; otherwise show the guardian.
        const order = ['primary', 'secondary', 'tertiary', 'guardian'];
        const filled = res.data.slots
          .filter((s) => s.filled && order.includes(s.slot))
          .sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot))[0];
        setSupport(
          filled ? { name: filled.contactName ?? 'Contact', channel: filled.channel, role: filled.slot } : null,
        );
      }
    });
  }, []);

  if (!isSetupComplete()) {
    return <Navigate to="/onboarding" replace />;
  }

  const activate = (): void => {
    // Covert by principle even here: produces no visible status change.
    void triggerActivation('direct-tap');
  };

  // Check-in ("I'm OK") — Brief 10. NON-emergency reassurance; no capture, no
  // event. Location only if the user opted in for THIS tap. Deliberately separate
  // from the activate disc.
  async function sendCheckin(): Promise<void> {
    // Gated during an active event (Brief 12 P1): check-in is a non-emergency
    // reassurance and must be inert while an alert is live.
    if (alertActive) {
      return;
    }
    setCheckin('sending');
    let location: { lat: number; lon: number } | null = null;
    if (checkinLoc && 'geolocation' in navigator) {
      location = await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
        );
      });
    }
    await api('/v1/me/checkin', {
      body: {
        includeLocation: checkinLoc && location != null,
        location,
        tzOffsetMinutes: new Date().getTimezoneOffset(),
      },
    });
    setCheckin('done');
    window.setTimeout(() => setCheckin('idle'), 3000);
  }

  return (
    <main
      className={`flex h-full w-full flex-col p-6 text-bb-text transition-colors duration-500 ${
        alertActive ? 'bg-[#1a0606]' : 'bg-bb-bg'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-display text-lg font-bold tracking-[0.12em]">BLACK BOX</span>
        {alertActive ? (
          <span
            aria-label="Settings locked during an active alert"
            title="Locked during an active alert"
            className="p-2 text-bb-text-tertiary opacity-40"
          >
            <Gear size={22} weight="light" />
          </span>
        ) : (
          <Link to="/settings" aria-label="Settings" className="p-2 text-bb-text-secondary hover:text-bb-text">
            <Gear size={22} weight="light" />
          </Link>
        )}
      </div>

      <div className="flex flex-1 flex-col items-center justify-center">
        <div
          className={`mb-8 flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-[0.2em] ${
            alertActive ? 'text-status-active' : 'text-status-armed'
          }`}
        >
          {alertActive ? (
            <>
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-status-active" />
              Alert active · Recording
            </>
          ) : (
            'Armed · Listening'
          )}
        </div>

        <button
          type="button"
          onClick={activate}
          aria-label="Activate"
          className="relative flex h-48 w-48 touch-manipulation select-none items-center justify-center rounded-full transition-transform active:scale-95 [-webkit-touch-callout:none] [-webkit-user-select:none]"
        >
          <span
            className={`absolute inset-0 rounded-full border ${
              alertActive ? 'animate-pulse border-status-active/70' : 'border-status-armed/40'
            }`}
          />
          <span className="absolute inset-6 rounded-full border border-bb-border-defined" />
          <span
            className={`h-16 w-16 rounded-full ${
              alertActive
                ? 'bg-status-active shadow-[0_0_50px_rgba(255,59,48,0.45)]'
                : 'bg-bb-elevated shadow-[0_0_40px_rgba(232,154,0,0.15)]'
            }`}
          />
        </button>

        {alertActive ? (
          <div className="mt-10 text-center">
            <div className="font-mono text-3xl font-semibold tracking-[0.1em] text-status-active">
              {formatElapsed(alertStart != null ? now - alertStart : 0)}
            </div>
            <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.18em] text-bb-text-secondary">
              Contacts are being notified
            </div>
          </div>
        ) : (
          <div className="mt-10 font-mono text-sm font-medium uppercase tracking-[0.18em] text-bb-text">
            Tap to activate
          </div>
        )}

        {/* Stand down: enter the lock code to end an active alert. Duress code
            escalates instead of cancelling (server-authoritative). */}
        <button
          type="button"
          onClick={() => setPinOpen(true)}
          className="mt-8 font-mono text-[11px] uppercase tracking-[0.18em] text-bb-text-secondary hover:text-bb-text"
        >
          Enter code to stand down
        </button>
      </div>

      {/* Check-in ("I'm OK") — Brief 10. Deliberately separated from the
          stand-down / close affordance above (Brief 12 P2): its own divider and
          "not an emergency" heading so it never reads as part of closing. Inert
          during an active event (Brief 12 P1). */}
      <div className="mb-4 mt-6 border-t border-bb-border-subtle pt-5">
        <div className="mb-3 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-bb-text-tertiary">
          Not an emergency
        </div>
        <div className="rounded-xl border border-status-armed/20 bg-bb-elevated/40 p-4">
          <button
            type="button"
            onClick={() => void sendCheckin()}
            disabled={alertActive || checkin !== 'idle'}
            className="w-full select-none rounded-full border border-[#34c759]/50 bg-[#13301a] py-3.5 font-mono text-sm font-medium uppercase tracking-[0.12em] text-[#34c759] disabled:opacity-40"
          >
            {alertActive
              ? 'Unavailable during an alert'
              : checkin === 'done'
                ? '✓ Checked in'
                : checkin === 'sending'
                  ? 'Sending…'
                  : "I'm OK · Check in"}
          </button>
          <label className="mt-3 flex items-center justify-center gap-2 text-[11px] text-bb-text-secondary">
            <input
              type="checkbox"
              checked={checkinLoc}
              disabled={alertActive}
              onChange={(e) => setCheckinLoc(e.target.checked)}
            />
            Include my location this time
          </label>
          <p className="mt-1 text-center font-mono text-[10px] text-bb-text-tertiary">
            Reassurance only — no recording, no tracking.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <Section label="Source">
          <div className="text-sm text-bb-text">Phone microphone &amp; camera</div>
          <div className="mt-0.5 font-mono text-[11px] text-bb-text-secondary">
            No external hardware paired
          </div>
        </Section>
        <Section label={support?.role === 'guardian' ? 'Guardian' : 'Primary Contact'}>
          {support ? (
            <>
              <div className="text-sm text-bb-text">{support.name}</div>
              <div className="mt-0.5 font-mono text-[11px] text-bb-text-secondary">
                {support.channel ? CHANNEL_LABEL[support.channel] ?? support.channel : 'Active'}
              </div>
            </>
          ) : (
            <div className="font-mono text-[11px] text-bb-text-secondary">
              No support contact yet — add one in settings
            </div>
          )}
        </Section>
      </div>

      <PinEntryOverlay open={pinOpen} onClose={() => setPinOpen(false)} />
    </main>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="border-t border-bb-border-subtle pt-3">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-bb-text-tertiary">
        {label}
      </div>
      {children}
    </div>
  );
}
