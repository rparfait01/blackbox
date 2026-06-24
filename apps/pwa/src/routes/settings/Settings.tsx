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
import { hashClosurePin, verifyPin } from '@/lib/crypto/pin';
import { getStoredClosurePin, setStoredClosurePin } from '@/lib/storage';
import { REGIONS } from '@/lib/regions';
import { PinPad } from '@/components/PinPad';
import { useActiveAlert } from '@/lib/active-alert';
import { ContactTabs } from './ContactTabs';

interface MeData {
  user: { name: string | null; email: string | null; phone: string | null; displayMode: string | null; regionId: string | null; nationality: string | null; hasDuressCode: boolean };
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
  const [pinOverlay, setPinOverlay] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = (): void => {
    void api<MeData>('/v1/me').then((r) => r.ok && r.data && setMe(r.data));
  };
  useEffect(load, []);

  if (!isSetupComplete()) {
    return <Navigate to="/onboarding" replace />;
  }
  // Active-alert lockdown (Fix Brief 8 P0): never render Settings during an alert,
  // even via deep-link or back-navigation. Return to the armed screen.
  if (alertActive) {
    return <Navigate to={getDisplayMode() === 'direct' ? '/blackbox' : '/'} replace />;
  }

  const flash = (msg: string): void => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  };

  async function switchMode(mode: DisplayMode): Promise<void> {
    if (mode === getDisplayMode()) {
      return;
    }
    if (!window.confirm('This will change how the app launches. Continue?')) {
      return;
    }
    const res = await api('/v1/me/display-mode', { body: { displayMode: mode } });
    if (res.ok) {
      setDisplayMode(mode);
      navigate('/', { replace: true });
    }
  }

  async function setRegion(regionId: string): Promise<void> {
    const res = await api('/v1/me/region', { body: { regionId } });
    if (res.ok) {
      flash('Region updated');
      load();
    }
  }

  function signOut(): void {
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

        {/* "Present" toggle (Brief 13 A4/B6). Deliberately ambiguous — no
            safety-revealing subtext. Right = ON (overt instrument), left = OFF
            (covert facade). switchMode carries the required second confirmation. */}
        <Group label="Present">
          <button
            type="button"
            role="switch"
            aria-checked={present}
            aria-label="Present"
            onClick={() => void switchMode(present ? 'covert' : 'direct')}
            className="flex w-full items-center justify-between py-1"
          >
            <span className="text-med-text/80">{present ? 'On' : 'Off'}</span>
            {/* Proper switch: ON = filled active track + knob right; OFF = muted
                track + knob left. `block` so the width/height actually apply (an
                inline span ignores them); knob pinned via left so position can't
                drift from the label. Right = ON (overt), left = OFF (covert). */}
            <span
              className={`relative block h-7 w-12 shrink-0 rounded-full transition-colors ${
                present ? 'bg-[#34c759]' : 'bg-med-text/20'
              }`}
            >
              <span
                className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${
                  present ? 'left-6' : 'left-1'
                }`}
              />
            </span>
          </button>
        </Group>

        <Group label="Closure pin">
          <button onClick={() => setPinOverlay(true)} className="block w-full py-2 text-left text-med-text/80">
            Change closure pin
          </button>
          <p className="mt-1 text-[11px] leading-relaxed text-med-text/45">
            Your 3-digit pin ends an alert (your contact confirms). To signal duress, enter it with
            the last digit wrong — it looks normal but warns your contact.
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

        <button onClick={signOut} className="mt-4 w-full rounded-full border border-med-text/25 py-3 text-med-text/70">
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

      {pinOverlay ? (
        <ClosurePinOverlay
          onDone={(msg) => {
            setPinOverlay(false);
            flash(msg);
          }}
          onClose={() => setPinOverlay(false)}
        />
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

/**
 * Change the ONE 3-digit closure pin (Brief 12). This is the single source of
 * truth — the same pin closure evaluates (SAT = exact; DURESS = last digit
 * altered). Stored on-device only; never transmitted. Requires the current pin
 * to change it (when one is already set). No backup code exists.
 */
function ClosurePinOverlay({
  onDone,
  onClose,
}: {
  onDone: (msg: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [phase, setPhase] = useState<'auth' | 'new' | 'confirm'>('auth');
  const [firstNew, setFirstNew] = useState('');
  const [error, setError] = useState<string | null>(null);

  // If no pin is set yet, skip straight to choosing one.
  useEffect(() => {
    void getStoredClosurePin().then((existing) => {
      if (!existing) {
        setPhase('new');
      }
    });
  }, []);

  const prompts = {
    auth: 'Enter your current pin',
    new: 'Choose a new 3-digit pin',
    confirm: 'Re-enter your new pin',
  };

  async function onCode(code: string): Promise<void> {
    setError(null);
    if (phase === 'auth') {
      const existing = await getStoredClosurePin();
      if (existing && (await verifyPin(code, existing.full))) {
        setPhase('new');
      } else {
        setError('That pin is incorrect. Try again.');
      }
    } else if (phase === 'new') {
      setFirstNew(code);
      setPhase('confirm');
    } else if (code === firstNew) {
      await setStoredClosurePin(await hashClosurePin(code));
      onDone('Closure pin changed');
    } else {
      setError('Pins did not match. Start again.');
      setPhase('new');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm p-8" onClick={onClose}>
      <div className="stillpoint-bg w-full max-w-sm rounded-2xl p-8 text-med-text" onClick={(e) => e.stopPropagation()}>
        <p className="mb-8 text-center font-serif text-lg font-light text-med-text/80">{prompts[phase]}</p>
        <PinPad onComplete={(code) => void onCode(code)} resetKey={phase} length={3} />
        {error ? <p className="mt-4 text-center text-sm text-med-warn">{error}</p> : null}
        <button onClick={onClose} className="mt-6 block w-full text-center text-sm text-med-text/40 underline">
          Cancel
        </button>
      </div>
    </div>
  );
}
