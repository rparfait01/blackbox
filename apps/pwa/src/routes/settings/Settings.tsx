import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { CaretLeft } from '@phosphor-icons/react';

import { api } from '@/lib/api';
import {
  clearSession,
  getDisplayMode,
  isSetupComplete,
  setDisplayMode,
  type DisplayMode,
} from '@/lib/auth';
import { REGIONS } from '@/lib/regions';
import { useActiveAlert } from '@/lib/active-alert';
import { ContactTabs } from './ContactTabs';

interface MeData {
  user: { name: string | null; email: string | null; phone: string | null; displayMode: string | null; regionId: string | null; nationality: string | null; hasDuressCode: boolean };
  /** Server-truth live-alert flag (Brief 20 §1): true while an event is open for
   *  the account, even if this device lost its local session. */
  activeEvent?: boolean;
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

  const load = (): void => {
    void api<MeData>('/v1/me').then((r) => r.ok && r.data && setMe(r.data));
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
    return <Navigate to={getDisplayMode() === 'direct' ? '/blackbox' : '/'} replace />;
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
    if (mode === getDisplayMode()) {
      return;
    }
    const res = await api('/v1/me/display-mode', { body: { displayMode: mode } });
    if (!res.ok) {
      flash('Couldn’t change visibility — please try again.');
      return;
    }
    setDisplayMode(mode);
    // Brief 30: mode is a DISPLAY setting only — it touches no trigger state, so the
    // switch is a plain hard-navigate with nothing to reconcile. Trigger active-state
    // lives solely in the one trigger core and is reset by this reload; the new mode's
    // arm calls the same triggerAlert() and asks the server, so there is no residual
    // state and no race to clear.
    window.location.assign(mode === 'direct' ? '/blackbox' : '/');
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

  const mode = getDisplayMode();
  const present = mode === 'direct';

  // Back returns to the armed screen — Stillpoint in covert, BLACK BOX in direct.
  const goBack = (): void => navigate(mode === 'direct' ? '/blackbox' : '/', { replace: true });

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
function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="flex justify-between border-b border-med-text/15 py-2">
      <span className="text-med-text/60">{k}</span>
      <span className="text-med-text">{v}</span>
    </div>
  );
}

