import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Gear } from '@phosphor-icons/react';

import { api } from '@/lib/api';
import { isSetupComplete } from '@/lib/auth';
import { triggerActivation } from '@/lib/activation';
import { useActiveAlert, useActiveAlertStart, useCoordinatorPathFailed } from '@/lib/active-alert';
import { formatElapsed } from '@/lib/time';
import { checkReadiness, osFixHint, type Readiness } from '@/lib/readiness';
import { primePermissions } from '@/lib/permissions';
import { ClosureControl } from '@/routes/meditation/ClosureControl';

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
  /** True only when a recipient could actually be reached on activation. */
  armable: boolean;
}
const CHANNEL_LABEL: Record<string, string> = { sms: 'Text', line: 'LINE', email: 'Email' };

export function BlackBoxHome(): JSX.Element {
  // Read the SAME slot model Settings + the cascade use (single source of truth),
  // so a contact added at signup shows here with no re-add.
  const [support, setSupport] = useState<{ name: string; channel: string | null; role: string } | null>(null);
  // Armable: an alert must be able to reach someone. Until /v1/me/contacts loads
  // we assume armable (true) so a transient fetch failure never blocks a real
  // activation; the server still enforces the guarantee at POST /v1/events.
  const [armable, setArmable] = useState(true);
  const [pinOpen, setPinOpen] = useState(false);
  const alertActive = useActiveAlert();
  // §3: coordinator closure path failed → prompt a second (guardian-tier) request.
  const coordinatorFailed = useCoordinatorPathFailed();
  // Elapsed alert time (overt: the instrument shows the live recording clock).
  const alertStart = useActiveAlertStart();
  const [now, setNow] = useState(() => Date.now());
  // §17: check-in confirmation reflects ACTUAL delivery — never a silent success.
  const [checkin, setCheckin] = useState<'idle' | 'sending' | 'delivered' | 'undelivered' | 'error'>('idle');
  // Readiness (Brief 15 §C): re-verified (not re-prompted) on every mount/refresh.
  // A permission revoked in OS settings surfaces here as NOT READY within one launch.
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [retesting, setRetesting] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    void checkReadiness().then(setReadiness);
  }, []);

  // One-tap fix / self-test: re-request (re-verifies; only prompts where the OS
  // allows) then re-check end to end. For an OS-revoked grant the browser won't
  // re-show a dialog, so the osFixHint below points the user to OS settings.
  async function retestReadiness(): Promise<void> {
    setRetesting(true);
    try {
      await primePermissions();
    } catch {
      /* priming is best-effort; the re-check below is the source of truth */
    }
    setReadiness(await checkReadiness());
    setRetesting(false);
  }

  // NOT READY only matters while dormant — during an active alert the instrument
  // shows the live recording state, never a readiness nag.
  const notReady = !alertActive && armable && readiness != null && !readiness.ready;

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
        setArmable(res.data.armable);
      }
    });
  }, []);

  if (!isSetupComplete()) {
    return <Navigate to="/onboarding" replace />;
  }

  const activate = (): void => {
    // Never arm into the notify-no-one deadlock: with no reachable recipient the
    // activate disc is inert and the UI directs the user to add a contact. (The
    // server also rejects POST /v1/events with no deliverable recipient.)
    if (!armable) {
      return;
    }
    // Covert by principle even here: produces no visible status change.
    void triggerActivation('direct-tap');
  };

  // Check-in ("I'm OK") — Brief 10 + Brief 17 §1. NON-emergency reassurance; no
  // capture, no event. A single button: location is captured and sent
  // AUTOMATICALLY on tap (no opt-in), and the confirmation reflects whether the
  // recipient was ACTUALLY reached — never a silent success.
  async function sendCheckin(): Promise<void> {
    // Dormant-only (Brief 12 P1): inert while an alert is live.
    if (alertActive) {
      return;
    }
    setCheckin('sending');
    // Capture the current fix automatically. Best-effort: if location is
    // unavailable/denied the check-in still goes — it just won't carry a fix.
    let location: { lat: number; lon: number } | null = null;
    if ('geolocation' in navigator) {
      location = await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
        );
      });
    }
    const res = await api<{ ok: boolean; recipients: number }>('/v1/me/checkin', {
      body: {
        includeLocation: location != null,
        location,
        tzOffsetMinutes: new Date().getTimezoneOffset(),
      },
    });
    // No silent success: confirm ONLY on real delivery (recipients > 0).
    if (!res.ok) {
      setCheckin('error');
    } else if ((res.data?.recipients ?? 0) > 0) {
      setCheckin('delivered');
    } else {
      setCheckin('undelivered');
    }
    window.setTimeout(() => setCheckin('idle'), 6000);
  }

  return (
    <main
      className={`flex h-full w-full flex-col px-6 pb-6 pt-safe-6 text-bb-text transition-colors duration-500 ${
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
          ) : !armable ? (
            'Not armed · No contact to reach'
          ) : notReady ? (
            <>
              <span aria-hidden className="font-bold">!</span>
              Not ready · {readiness!.missing.join(' + ')} off
            </>
          ) : (
            'Armed · Listening'
          )}
        </div>

        {/* NOT READY fix path (Brief 15 §C): name the missing grant, give the OS
            path, and a one-tap re-test. Never silent. */}
        {notReady ? (
          <div className="mb-6 w-full max-w-xs rounded-lg border border-status-armed/40 bg-status-armed/5 p-4 text-center">
            <p className="text-[12px] leading-relaxed text-bb-text-secondary">
              {readiness!.missing.join(' and ')} permission is off, so an alert can’t fully record.
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-bb-text-tertiary">{osFixHint()}</p>
            <button
              type="button"
              onClick={() => void retestReadiness()}
              disabled={retesting}
              className="mt-3 w-full rounded-full border border-status-armed/50 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-status-armed disabled:opacity-50"
            >
              {retesting ? 'Re-testing…' : 'Re-test readiness'}
            </button>
          </div>
        ) : null}

        <button
          type="button"
          onClick={activate}
          disabled={!armable && !alertActive}
          aria-label={armable || alertActive ? 'Activate' : 'Add a contact to arm'}
          className={`relative flex h-48 w-48 touch-manipulation select-none items-center justify-center rounded-full transition-transform active:scale-95 [-webkit-touch-callout:none] [-webkit-user-select:none] ${
            !armable && !alertActive ? 'opacity-40' : ''
          }`}
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
        ) : armable ? (
          <div className="mt-10 font-mono text-sm font-medium uppercase tracking-[0.18em] text-bb-text">
            Tap to activate
          </div>
        ) : (
          <Link
            to="/settings"
            className="mt-10 text-center font-mono text-sm font-medium uppercase tracking-[0.18em] text-status-armed"
          >
            Add a contact to arm
            <span className="mt-1 block font-sans text-[11px] normal-case tracking-normal text-bb-text-secondary">
              An alert must be able to reach someone. Add a contact or guardian in settings.
            </span>
          </Link>
        )}

        {/* §3: the coordinator path failed to confirm — prompt a SECOND request,
            which routes to the guardian. Overt only; the covert facade stays
            silent (the user simply re-does the gesture). */}
        {alertActive && coordinatorFailed ? (
          <div className="mt-8 max-w-xs rounded-lg border border-status-armed/40 bg-status-armed/5 p-3 text-center">
            <p className="text-[12px] leading-relaxed text-status-armed">
              Your support contact didn’t confirm. Your guardian has been alerted.
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-bb-text-secondary">
              Request closure again below to reach them.
            </p>
          </div>
        ) : null}

        {/* End an alert: the press-and-hold gesture (hold = clean, release early =
            duress). No code is entered (Brief 16 §1). */}
        <button
          type="button"
          onClick={() => setPinOpen(true)}
          className="mt-8 font-mono text-[11px] uppercase tracking-[0.18em] text-bb-text-secondary hover:text-bb-text"
        >
          {coordinatorFailed ? 'Request closure again' : 'End alert'}
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
          {/* §17: a SINGLE button. Location is captured + sent automatically on
              tap — no checkbox, no opt-in. */}
          <button
            type="button"
            onClick={() => void sendCheckin()}
            disabled={alertActive || checkin === 'sending'}
            className={`w-full select-none rounded-full border py-3.5 font-mono text-sm font-medium uppercase tracking-[0.12em] disabled:opacity-40 ${
              checkin === 'undelivered' || checkin === 'error'
                ? 'border-status-armed/60 bg-status-armed/10 text-status-armed'
                : 'border-[#34c759]/50 bg-[#13301a] text-[#34c759]'
            }`}
          >
            {alertActive
              ? 'Unavailable during an alert'
              : checkin === 'sending'
                ? 'Checking in…'
                : checkin === 'delivered'
                  ? '✓ Guardian notified'
                  : checkin === 'undelivered'
                    ? '⚠ Not delivered — tap to retry'
                    : checkin === 'error'
                      ? 'Couldn’t check in — tap to retry'
                      : "I'm OK · Check in"}
          </button>
          <p className="mt-2 text-center font-mono text-[10px] leading-relaxed text-bb-text-tertiary">
            {checkin === 'delivered'
              ? 'Your guardian received your status, time, and location.'
              : checkin === 'undelivered'
                ? 'No guardian could be reached — add or verify your guardian in settings.'
                : checkin === 'error'
                  ? 'No connection — please try again.'
                  : 'Sends your status, time & location to your guardian. No recording, no tracking.'}
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

      <ClosureControl open={pinOpen} onClose={() => setPinOpen(false)} />
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
