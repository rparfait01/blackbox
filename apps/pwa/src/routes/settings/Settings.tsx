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
import { hashPin } from '@/lib/crypto/pin';
import { setStoredDuressPin, setStoredPin } from '@/lib/storage';
import { REGIONS } from '@/lib/regions';
import { PinPad } from '@/components/PinPad';

interface MeData {
  user: { name: string | null; email: string | null; phone: string | null; displayMode: string | null; regionId: string | null; hasDuressCode: boolean };
  guardian: { name: string | null; relationship: string | null; status: string } | null;
}

/**
 * Settings (W8A). Profile (read-only for now), display-mode toggle (with a
 * confirm), lock/backup code changes, region, support contact, and sign out.
 * Same Stillpoint design language as onboarding.
 */
export function Settings(): JSX.Element {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeData | null>(null);
  const [codeOverlay, setCodeOverlay] = useState<'lock' | 'duress' | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = (): void => {
    void api<MeData>('/v1/me').then((r) => r.ok && r.data && setMe(r.data));
  };
  useEffect(load, []);

  if (!isSetupComplete()) {
    return <Navigate to="/onboarding" replace />;
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

  async function resendInvite(): Promise<void> {
    const res = await api('/v1/guardians/resend', { body: {} });
    flash(res.ok ? 'Invite resent' : 'Could not resend');
  }
  async function removeGuardian(): Promise<void> {
    if (!window.confirm('Remove your support contact?')) {
      return;
    }
    await api('/v1/guardians', { method: 'DELETE' });
    flash('Support contact removed');
    load();
  }

  function signOut(): void {
    clearSession();
    navigate('/onboarding', { replace: true });
  }

  const mode = getDisplayMode();

  // Back returns to the armed screen — Stillpoint in covert, BLACK BOX in direct.
  const goBack = (): void => navigate(mode === 'direct' ? '/blackbox' : '/', { replace: true });

  return (
    <main className="stillpoint-bg min-h-full w-full overflow-y-auto p-6 text-med-text">
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
        </Group>

        <Group label="Display mode">
          <div className="flex gap-3">
            {(['direct', 'covert'] as const).map((m) => (
              <button
                key={m}
                onClick={() => void switchMode(m)}
                className={`flex-1 rounded-lg border py-3 font-mono text-xs uppercase tracking-[0.1em] ${
                  mode === m ? 'border-med-text/80 bg-med-text/10' : 'border-med-text/25 text-med-text/60'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </Group>

        <Group label="Codes">
          <button onClick={() => setCodeOverlay('lock')} className="block w-full py-2 text-left text-med-text/80">
            Change session lock code
          </button>
          <button onClick={() => setCodeOverlay('duress')} className="block w-full py-2 text-left text-med-text/80">
            Change backup code
          </button>
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

        <Group label="Support contact">
          {me?.guardian ? (
            <>
              <Row k={me.guardian.name ?? 'Contact'} v={me.guardian.status === 'accepted' ? 'Verified' : 'Waiting…'} />
              <div className="mt-2 flex gap-4">
                {me.guardian.status !== 'accepted' ? (
                  <button onClick={resendInvite} className="text-sm text-med-text/60 underline">
                    Resend invite
                  </button>
                ) : null}
                <button onClick={removeGuardian} className="text-sm text-status-active/80 underline">
                  Remove
                </button>
              </div>
            </>
          ) : (
            <div className="text-sm text-med-text/50">No support contact. Add one during onboarding or contact support.</div>
          )}
        </Group>

        <button onClick={signOut} className="mt-4 w-full rounded-full border border-med-text/25 py-3 text-med-text/70">
          Sign out
        </button>
      </div>

      {toast ? (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-5 py-2 text-sm text-med-text">
          {toast}
        </div>
      ) : null}

      {codeOverlay ? (
        <CodeChangeOverlay
          kind={codeOverlay}
          onDone={(msg) => {
            setCodeOverlay(null);
            flash(msg);
            load();
          }}
          onClose={() => setCodeOverlay(null)}
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

/** Change lock or backup code: enter authorising code, then new code twice. */
function CodeChangeOverlay({
  kind,
  onDone,
  onClose,
}: {
  kind: 'lock' | 'duress';
  onDone: (msg: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [phase, setPhase] = useState<'auth' | 'new' | 'confirm'>('auth');
  const [authCode, setAuthCode] = useState('');
  const [firstNew, setFirstNew] = useState('');
  const [error, setError] = useState<string | null>(null);

  const prompts = {
    auth: kind === 'lock' ? 'Enter current lock code' : 'Enter your lock code',
    new: kind === 'lock' ? 'Enter new lock code' : 'Enter new backup code',
    confirm: 'Re-enter the new code',
  };

  async function submit(newCode: string): Promise<void> {
    const path = kind === 'lock' ? '/v1/me/lock-code' : '/v1/me/duress-code';
    const body =
      kind === 'lock'
        ? { oldCode: authCode, newCode }
        : { lockCode: authCode, newDuressCode: newCode };
    const res = await api(path, { body });
    if (res.ok) {
      const hashed = await hashPin(newCode);
      if (kind === 'lock') {
        await setStoredPin(hashed);
      } else {
        await setStoredDuressPin(hashed);
      }
      onDone(kind === 'lock' ? 'Lock code changed' : 'Backup code changed');
    } else {
      setError('That code is incorrect. Start again.');
      setPhase('auth');
    }
  }

  function onCode(code: string): void {
    setError(null);
    if (phase === 'auth') {
      setAuthCode(code);
      setPhase('new');
    } else if (phase === 'new') {
      setFirstNew(code);
      setPhase('confirm');
    } else if (code === firstNew) {
      void submit(code);
    } else {
      setError('Codes did not match. Start again.');
      setPhase('new');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm p-8" onClick={onClose}>
      <div className="stillpoint-bg w-full max-w-sm rounded-2xl p-8 text-med-text" onClick={(e) => e.stopPropagation()}>
        <p className="mb-8 text-center font-serif text-lg font-light text-med-text/80">{prompts[phase]}</p>
        <PinPad onComplete={onCode} resetKey={phase} />
        {error ? <p className="mt-4 text-center text-sm text-status-active">{error}</p> : null}
        <button onClick={onClose} className="mt-6 block w-full text-center text-sm text-med-text/40 underline">
          Cancel
        </button>
      </div>
    </div>
  );
}
