import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { CaretLeft } from '@phosphor-icons/react';

import { api } from '@/lib/api';
import {
  cacheConsoleLevel,
  cacheEntitlement,
  clearSession,
  getDisplayMode,
  isSetupComplete,
  setDisplayMode,
  type DisplayMode,
} from '@/lib/auth';
import { REGIONS } from '@/lib/regions';
import { envelopeEncryptionEnabled } from '@/lib/env';
import { useActiveAlert } from '@/lib/active-alert';
import { enrollPasskey, passkeySupported } from '@/lib/passkey';
import { ContactTabs } from './ContactTabs';
import { AnonymousTally } from './AnonymousTally';
import { CertifiedReport } from './CertifiedReport';
import { EvidenceReview } from './EvidenceReview';
import { DeleteRecordings } from './DeleteRecordings';

interface MeData {
  user: { name: string | null; email: string | null; phone: string | null; displayMode: string | null; regionId: string | null; nationality: string | null; hasDuressCode: boolean; entitlement?: string; entitlementSource?: string | null };
  /** Server-truth live-alert flag (Brief 20 §1): true while an event is open for
   *  the account, even if this device lost its local session. */
  activeEvent?: boolean;
  /** §3 "Track": this account's own state. Self-view only — never anyone else's. */
  account?: {
    passkeys: number;
    hasRecoveryCode: boolean;
    contactsConfigured: number;
    lastCheckinAt: number | null;
  };
}

/** Plain-language "when", for the self-view. Never a raw timestamp. */
function whenText(ts: number | null | undefined): string {
  if (!ts) return 'Never';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Yesterday' : `${days} days ago`;
}

/**
 * Settings (W8A). Profile (read-only for now), display-mode toggle (with a
 * confirm), lock/backup code changes, region, support contact, and sign out.
 * Same Stillpoint design language as onboarding.
 */
export function Settings(): JSX.Element {
  const navigate = useNavigate();
  const alertActive = useActiveAlert();
  const [me, setMe] = useState<MeData | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // §0: an in-app 2-step confirm for switching toward VISIBLE (the native confirm
  // dialog is unreliable in the installed PWA — that is what left the toggle dead).
  const [confirmVisible, setConfirmVisible] = useState(false);
  // Brief 31 §3: the display mode is a PREFERENCE. Selecting it here updates this
  // selection + persists (local + server) but does NOT navigate — the user stays in
  // Settings. The chosen skin renders when they LEAVE Settings (goBack reads this).
  const [selectedMode, setSelectedMode] = useState<DisplayMode | null>(getDisplayMode());
  // §1: enrolling a passkey from Settings — the upgrade path off the email link.
  const [enrolling, setEnrolling] = useState(false);
  // Brief 25: the anonymous incident tally overlay. Reachable only here (Settings is
  // Visible + unreachable during an active alert), so it is never surfaced under duress.
  const [tallyOpen, setTallyOpen] = useState(false);
  // Brief 29: the survivor-generated OFFICIAL report. Settings-only, and gated on
  // zero-knowledge custody — with the flag off the entry states that honestly and cannot
  // be opened, rather than disappearing or failing on tap.
  const [reportOpen, setReportOpen] = useState(false);
  // Evidence review: her own captures, decrypted and played on this device. Same gate as
  // the official report (both need sealed custody), same honest state when it is off.
  const [reviewOpen, setReviewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Brief 33b — THE DOOR to the console. `null` until the server answers, and null is
  // rendered as "no door": this fails CLOSED, so a slow or failed request shows nothing
  // rather than a link that would only 403.
  //
  // Deliberately a SEPARATE call to /v1/console/me rather than a new field on /v1/me.
  // /v1/me is on the alert-reconcile hot path (foreground, close), and adding two role
  // lookups to every one of those calls would tax the safety path to render a nav link.
  const [consoleLevel, setConsoleLevel] = useState<string | null>(null);

  const load = (): void => {
    // The console level is decided SERVER-SIDE from the session. The client never infers
    // it, and never reads a role out of the token — it renders whatever the server says.
    void api<{ level: string; levelLabel: string }>('/v1/console/me').then((r) => {
      const next = r.ok && r.data && r.data.level !== 'unmarked' ? r.data.levelLabel : null;
      setConsoleLevel(next);
      // Refresh the hint the ROOT route reads synchronously (see RootGate). Settings is
      // the surface a roled user passes through most, so this keeps it warm — and a
      // demoted account clears it here too, on the next visit.
      cacheConsoleLevel(next);
    });
    void api<MeData>('/v1/me').then((r) => {
      if (r.ok && r.data) {
        setMe(r.data);
        // Brief 28 §2 — keep the offline entitlement cache fresh from account truth.
        if (r.data.user.entitlement) {
          cacheEntitlement({
            status: r.data.user.entitlement === 'activated' ? 'activated' : 'unactivated',
            source: r.data.user.entitlementSource ?? null,
          });
        }
      }
    });
  };
  useEffect(load, []);

  if (!isSetupComplete()) {
    return <Navigate to="/onboarding" replace />;
  }
  // Active-alert lockdown (Fix Brief 8 P0 + Brief 20 §1): never render Settings
  // during an alert, even via deep-link or back-navigation. Gate on BOTH the local
  // session (fast) and server truth (me.activeEvent) — so a device that lost its
  // local session still cannot open settings while an event is open on the server.
  if (alertActive || me?.activeEvent) {
    // Brief 0B §5: say WHY, don't silently load-then-bounce. But only in VISIBLE —
    // §0a: in the Hidden facade an "active alert" notice would be a tell in front of
    // an aggressor, so covert still bounces silently back to the breathing screen.
    if (getDisplayMode() === 'direct') {
      return <ActiveAlertLock />;
    }
    return <Navigate to="/" replace />;
  }

  const flash = (msg: string): void => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  };

  // PINNED mapping (load-bearing — never infer): Hidden = covert facade,
  // Visible = overt instrument. applyMode persists server-side + locally, then
  // HARD-navigates so the rendered mode is guaranteed to match the stored mode
  // (a soft navigate can leave the old screen mounted; the native confirm dialog
  // could not even be relied on to fire). §0a holds: Hidden re-enters the facade.
  async function applyMode(mode: DisplayMode): Promise<void> {
    setConfirmVisible(false);
    if (mode === selectedMode) {
      return;
    }
    const res = await api('/v1/me/display-mode', { body: { displayMode: mode } });
    if (!res.ok) {
      flash('Couldn’t change visibility — please try again.');
      return;
    }
    // Brief 31 §3: set the PREFERENCE only — persist (local + server) and update the
    // selection. Do NOT navigate: the user stays in Settings and keeps working. The
    // chosen skin renders when they leave Settings (goBack). Mode touches no trigger
    // state (the one trigger core holds it), so there is nothing to reconcile.
    setDisplayMode(mode);
    setSelectedMode(mode);
    flash(mode === 'direct' ? 'Visible — applies when you leave Settings' : 'Hidden — applies when you leave Settings');
  }

  // Hidden (covert) is the SAFE direction — frictionless. Visible (overt) is
  // deliberate — a 2-step in-app confirmation first.
  function selectVisibility(target: 'hidden' | 'visible'): void {
    if (target === 'hidden') {
      void applyMode('covert');
    } else {
      setConfirmVisible(true);
    }
  }

  async function setRegion(regionId: string): Promise<void> {
    const res = await api('/v1/me/region', { body: { regionId } });
    if (res.ok) {
      flash('Region updated');
      load();
    }
  }

  async function signOut(): Promise<void> {
    // Server-truth guard (Brief 20 §1): the ONLY way out of a live alert is closing
    // it — never by signing out and detaching the device from an event still open
    // on the server. Re-check fresh (not the cached load) right before clearing.
    const r = await api<MeData>('/v1/me');
    if (r.data?.activeEvent) {
      flash('Close the active alert first — you can’t sign out during a live alert.');
      return;
    }
    clearSession();
    navigate('/onboarding', { replace: true });
  }

  async function deleteAccount(): Promise<void> {
    if (!window.confirm('Delete your account? This erases your identity, contacts, and guardian. This cannot be undone.')) {
      return;
    }
    if (!window.confirm('Are you absolutely sure? Tap OK to permanently delete.')) {
      return;
    }
    const res = await api('/v1/me/account', { method: 'DELETE' });
    if (res.ok) {
      clearSession();
      navigate('/onboarding', { replace: true });
    } else if (res.status === 423) {
      flash('Cannot delete during an active alert.');
    } else {
      flash('Could not delete your account. Try again.');
    }
  }

  const present = selectedMode === 'direct';

  // Back returns to the armed screen in the SELECTED mode — Brief 31 §3: leaving
  // Settings is where the chosen skin renders (getDisplayMode() was already persisted
  // to selectedMode by applyMode, so RootGate/the target route render it directly, no
  // reload). Stillpoint in covert, BLACK BOX in direct.
  const goBack = (): void => navigate(selectedMode === 'direct' ? '/blackbox' : '/', { replace: true });

  return (
    <main className="stillpoint-bg min-h-full w-full overflow-y-auto px-6 pb-6 pt-safe-6 text-med-text">
      <div className="mx-auto max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <button
            type="button"
            onClick={goBack}
            aria-label="Back"
            className="-ml-2 p-2 text-med-text/60 transition-colors hover:text-med-text"
          >
            <CaretLeft size={24} weight="light" />
          </button>
          <h1 className="font-serif text-3xl font-light tracking-[0.04em]">Settings</h1>
        </div>

        <Group label="Profile">
          <Row k="Name" v={me?.user.name ?? '—'} />
          <Row k="Email" v={me?.user.email ?? '—'} />
          <Row k="Phone" v={me?.user.phone ?? '—'} />
          <Row k="Nationality" v={me?.user.nationality ?? '—'} />
        </Group>

        {/* §3 "Track" — the account's own state, in plain language: how you get in,
            how many people an alert reaches, when you last checked in. Self-view
            only; nothing here is visible to any other account. */}
        <Group label="Your account">
          <Row
            k="Sign-in"
            v={
              me?.account
                ? me.account.passkeys > 0
                  ? `Passkey · ${me.account.passkeys} device${me.account.passkeys === 1 ? '' : 's'}`
                  : 'Email link'
                : '—'
            }
          />
          <Row k="Recovery code" v={me?.account ? (me.account.hasRecoveryCode ? 'Saved' : 'None') : '—'} />
          <Row
            k="People notified"
            v={me?.account ? (me.account.contactsConfigured === 0 ? 'No one yet' : String(me.account.contactsConfigured)) : '—'}
          />
          <Row k="Last check-in" v={me?.account ? whenText(me.account.lastCheckinAt) : '—'} />
          {/* Brief 28 §2 — activation status (arms the device; never gates the trigger). */}
          <Row k="Activation" v={me?.user.entitlement === 'activated' ? 'Activated' : me ? 'Not activated' : '—'} />
        </Group>

        {/* Brief 33b — THE DOOR to the console, and it is gated TWICE on purpose.

            1. `consoleLevel` — the SERVER decided this account holds a role. An UNMARKED
               account gets null and no door; /console would answer "No console access"
               even if this block were forced to render, because the boundary is the
               server, not this condition.
            2. `present` — the VISIBLE skin only. Settings is reachable from the Hidden
               facade's gear, and it wears the Stillpoint palette in both modes. A
               "Console" link sitting in a covert user's preferences is exactly the kind
               of tell §0a exists to prevent, so the door does not exist in that skin.
               The URL still works if typed — that is a deliberate choice, not a gap:
               someone who knows to type it is not being told anything.

            Both real console accounts run the Visible skin, so this costs the operator
            nothing. */}
        {present && consoleLevel ? (
          <Link
            to="/console"
            className="mb-8 flex items-center justify-between rounded-lg border border-med-text/20 bg-black/20 p-4"
          >
            <span>
              <span className="mb-1 block text-[12px] font-medium leading-relaxed text-med-text">Console</span>
              <span className="block text-[11px] leading-relaxed text-med-text/60">
                Organisations, access codes and enrolment readiness.
              </span>
            </span>
            {/* The level the SERVER returned — so the door names the scope it opens. */}
            <span className="ml-3 shrink-0 rounded border border-med-text/40 px-2 py-[2px] font-mono text-[9px] uppercase tracking-[0.1em] text-med-text/70">
              {consoleLevel}
            </span>
          </Link>
        ) : null}

        {/* Brief 28 §2 — activation prompt for a covert user (whose only route to the
            app is here). Non-blocking; the trigger works regardless. Never shows a
            price once activated or when sponsored (org/operator source). */}
        {me?.user.entitlement === 'unactivated' ? (
          <Link to="/activate" className="mb-8 block rounded-lg border border-med-text/20 bg-black/20 p-4">
            <p className="mb-1 text-[12px] font-medium leading-relaxed text-med-text">Activate this device</p>
            <p className="text-[11px] leading-relaxed text-med-text/60">
              Enter a code or complete your one-time setup to arm the device. Your
              emergency trigger already works — activation is never required to send an alert.
            </p>
          </Link>
        ) : null}

        {/* An account with no passkey is still reachable by an emailed link — which
            matters if someone else can read that inbox. Offer the upgrade plainly;
            enrolling is what closes that door. Never nag, never block. */}
        {me?.account && me.account.passkeys === 0 && passkeySupported() ? (
          <div className="mb-8 rounded-lg border border-med-text/20 bg-black/20 p-4">
            <p className="mb-1 text-[12px] font-medium leading-relaxed text-med-text">Add a passkey</p>
            <p className="mb-3 text-[11px] leading-relaxed text-med-text/60">
              Sign in with your face, fingerprint, or device PIN — and we’ll stop sending sign-in links for
              your account, so your email can’t be used to get in.
            </p>
            <button
              type="button"
              disabled={enrolling}
              onClick={() => {
                setEnrolling(true);
                void enrollPasskey().then((r) => {
                  setEnrolling(false);
                  if (r.ok) {
                    flash('Passkey added');
                    load();
                  } else if (r.reason === 'failed') {
                    flash('Could not add a passkey');
                  }
                });
              }}
              className="w-full rounded-full border border-med-text/40 py-2.5 text-sm font-medium text-med-text disabled:opacity-50"
            >
              {enrolling ? 'Waiting…' : 'Create a passkey'}
            </button>
          </div>
        ) : null}

        {/* §0 Visibility — a TWO-ENDED, both-ends-labeled control. Hidden = covert
            (Stillpoint facade), Visible = overt (instrument). The mapping is pinned
            and never inferred: a user choosing Hidden must NEVER get the instrument.
            Hidden is the default. */}
        <Group label="Visibility">
          <div role="radiogroup" aria-label="App visibility" className="flex gap-2">
            <button
              type="button"
              role="radio"
              aria-checked={!present}
              onClick={() => selectVisibility('hidden')}
              className={`flex-1 rounded-lg border py-3 text-center font-mono text-xs uppercase tracking-[0.12em] transition-colors ${
                !present
                  ? 'border-med-text/80 bg-med-text/10 text-med-text'
                  : 'border-med-text/25 text-med-text/55'
              }`}
            >
              Hidden
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={present}
              onClick={() => selectVisibility('visible')}
              className={`flex-1 rounded-lg border py-3 text-center font-mono text-xs uppercase tracking-[0.12em] transition-colors ${
                present
                  ? 'border-med-text/80 bg-med-text/10 text-med-text'
                  : 'border-med-text/25 text-med-text/55'
              }`}
            >
              Visible
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-med-text/45">
            {present
              ? 'Visible: the full app is shown.'
              : 'Hidden: the app looks like an ordinary breathing app.'}
          </p>

          {/* 2-step in-app confirmation for switching TOWARD Visible (deliberate). */}
          {confirmVisible ? (
            <div className="mt-3 rounded-lg border border-med-warn/40 bg-med-warn/5 p-3">
              <p className="text-[12px] leading-relaxed text-med-text/80">
                Switch to <span className="text-med-text">Visible</span>? The full app will be shown
                on this phone until you set it back to Hidden.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => void applyMode('direct')}
                  className="flex-1 rounded-full bg-med-text/90 py-2.5 text-sm font-medium text-[#071416]"
                >
                  Show the full app
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmVisible(false)}
                  className="flex-1 rounded-full border border-med-text/25 py-2.5 text-sm text-med-text/70"
                >
                  Stay hidden
                </button>
              </div>
            </div>
          ) : null}
        </Group>

        <Group label="Ending an alert">
          <p className="text-[12px] leading-relaxed text-med-text/70">
            Press and <span className="text-med-text">hold the close control</span> until the ring
            completes to request closure; your contact confirms.
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-med-text/45">
            If you’re ever forced to close against your will, let go early — it looks identical, but
            silently warns your contact the danger is ongoing. Nothing to memorize, no code to type.
          </p>
        </Group>

        <Group label="Region">
          <select
            value={me?.user.regionId ?? 'jp'}
            onChange={(e) => void setRegion(e.target.value)}
            className="w-full border-b border-med-text/25 bg-transparent py-2 text-lg text-med-text outline-none"
          >
            {REGIONS.map((r) => (
              <option key={r.id} value={r.id} className="text-black">
                {r.label}
              </option>
            ))}
          </select>
        </Group>

        <ContactTabs flash={flash} />

        {/* ─── REPORTS. Two reports, two destinations, and the labels here are what keeps
            them apart. Conflating them is the failure mode this section is named against:

              ANONYMOUS  → leaves her hands. It goes to the severed public tally that closes
                           the unreported-incident gap. No identity, and no way back — which
                           is exactly why the copy says so before she sends and again at the
                           consent step.
              OFFICIAL   → never leaves her hands. Built on this device from her own
                           recording, signed so a stranger can check it, and exported by HER.
                           There is no BLACK BOX repository of personal reports: no table
                           holds one, and POST /reports/sign takes two hashes, not content.
              REVIEW     → goes nowhere at all. She opens her own recording in this tab; the
                           bytes are released when she closes the screen.

            The two flag-gated entries are always PRESENT and never dead: with zero-knowledge
            custody off they render an honest unavailable state rather than a tap that fails
            or an entry that silently isn't there. §0a: the Hidden facade renders none of
            this — the facade surfaces are asserted clean in the guard tests. */}

        {/* Brief 25 — anonymous incident tally. Severed from identity: no account, device,
            or event column exists on that store to link back with. */}
        <Group label="Anonymous report">
          <p className="mb-3 text-[12px] leading-relaxed text-med-text/60">
            Record anonymously that something happened — four taps, nothing about what happened and nothing about
            you. It goes into public statistics on violence that usually goes unreported. Because it can’t be
            traced to you, it also can’t be taken back.
          </p>
          <button
            onClick={() => setTallyOpen(true)}
            className="w-full rounded-full border border-med-text/30 py-3 text-sm text-med-text/80"
          >
            Report anonymously
          </button>
        </Group>

        {/* Brief 29 — the survivor-generated certified report. Built on her device from her
            own decrypted recording, signed so any third party can verify it independently.
            HERS: we hold no copy, and the download is what puts it in her custody. */}
        <Group label="Official report">
          <p className="mb-3 text-[12px] leading-relaxed text-med-text/60">
            Your own certified account of an incident, built on this phone from your own recording and signed so
            anyone — a court, an advocate, an insurer — can check it without taking our word for it. It is yours:
            we keep no copy, and you decide who ever sees it.
          </p>
          {envelopeEncryptionEnabled ? (
            <button
              onClick={() => setReportOpen(true)}
              className="w-full rounded-full border border-med-text/30 py-3 text-sm text-med-text/80"
            >
              Start an official report
            </button>
          ) : (
            <NotYet>Available when secure storage is enabled</NotYet>
          )}

          {/* Brief 56 §B — DELETION IS HERS, and it belongs beside the review rather than buried
              under an account-management heading. She reaches it from the same place she looks at
              her own recordings, because deciding to destroy one usually follows looking at it.

              Deliberately NOT gated on `envelopeEncryptionEnabled`. Review needs the envelope key
              to open the bytes; deleting them does not, and gating deletion behind a feature flag
              would mean a survivor who needs recordings off her phone could be told to come back
              later. Availability of destruction is a safety property, not a feature. */}
          <button
            onClick={() => setDeleteOpen(true)}
            className="mt-2.5 w-full rounded-full border border-med-text/20 py-3 text-sm text-med-text/60"
          >
            Delete my recordings
          </button>
        </Group>

        {/* Brief 26 read side — her own captures, opened on her device with her key. No
            download here on purpose: producing a file is the official report's step, behind
            its custody caution. */}
        <Group label="Evidence review">
          <p className="mb-3 text-[12px] leading-relaxed text-med-text/60">
            Watch or listen to your own recordings, opened here on this phone with your key. Nothing is downloaded
            and nothing is sent anywhere — it’s just you, looking at what was recorded.
          </p>
          {envelopeEncryptionEnabled ? (
            <button
              onClick={() => setReviewOpen(true)}
              className="w-full rounded-full border border-med-text/30 py-3 text-sm text-med-text/80"
            >
              Review my evidence
            </button>
          ) : (
            <NotYet>Available when secure storage is enabled</NotYet>
          )}
        </Group>

        {/* THREE entries, and only three. The guided intake (Brief 27) used to sit here as a
            fourth, "Written account" — but her own words are already a section of the Official
            Report, so a separate door was a duplicate and reopened exactly the conflation this
            section exists to prevent. The intake subsystem is untouched and still sealed-file
            capable; what is removed is the second door to the same thing. */}

        <button onClick={() => void signOut()} className="mt-4 w-full rounded-full border border-med-text/25 py-3 text-med-text/70">
          Sign out
        </button>

        {/* Delete account (Brief 13 B17) — behind a double confirmation; wipes the
            account server-side and returns to signup. */}
        <button
          onClick={() => void deleteAccount()}
          className="mt-3 w-full rounded-full border border-med-warn/40 py-3 text-sm text-med-warn/80"
        >
          Delete account
        </button>

        {/* Live build id (Brief 13 B1) — lets the device's running build be
            confirmed against the latest deploy. */}
        <p className="mt-6 text-center font-mono text-[10px] text-med-text/30">build {__BUILD_ID__}</p>
      </div>

      {toast ? (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-5 py-2 text-sm text-med-text">
          {toast}
        </div>
      ) : null}

      {tallyOpen ? <AnonymousTally onClose={() => setTallyOpen(false)} /> : null}
      {reportOpen ? <CertifiedReport onClose={() => setReportOpen(false)} /> : null}
      {reviewOpen ? <EvidenceReview onClose={() => setReviewOpen(false)} /> : null}
      {deleteOpen ? <DeleteRecordings onClose={() => setDeleteOpen(false)} /> : null}
    </main>
  );
}

/**
 * Brief 0B §5 — the live-alert lock, made honest. When Settings is opened during an
 * active alert we no longer load-then-silently-revert; we say plainly that it is
 * unavailable and offer the way back to the live screen. VISIBLE-only: this notice
 * names an active alert, so it must never render in the Hidden facade (§0a) — the
 * covert path bounces straight back to the breathing screen instead.
 */
function ActiveAlertLock(): JSX.Element {
  const navigate = useNavigate();
  return (
    <main className="stillpoint-bg flex min-h-full w-full flex-col items-center justify-center px-8 text-center text-med-text">
      <h1 className="font-serif text-2xl font-light tracking-[0.04em]">Unavailable during an active alert</h1>
      <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-med-text/60">
        Settings are locked while an alert is open. Close the alert to make changes.
      </p>
      <button
        type="button"
        onClick={() => navigate('/blackbox', { replace: true })}
        className="mt-8 rounded-full border border-med-text/40 px-6 py-3 text-sm font-medium text-med-text"
      >
        Back to the alert
      </button>
    </main>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="mb-8">
      <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/45">{label}</div>
      {children}
    </section>
  );
}
/**
 * The honest state for an entry whose feature is not switched on yet. Deliberately NOT a
 * button: a tap that goes nowhere teaches a survivor that this app's controls are unreliable,
 * and that lesson is expensive on the one day it matters. The entry stays visible and named
 * so she knows the capability exists and what turns it on.
 */
function NotYet({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <p className="w-full rounded-full border border-dashed border-med-text/20 py-3 text-center text-[12px] text-med-text/40">
      {children}
    </p>
  );
}
function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="flex justify-between border-b border-med-text/15 py-2">
      <span className="text-med-text/60">{k}</span>
      <span className="text-med-text">{v}</span>
    </div>
  );
}

