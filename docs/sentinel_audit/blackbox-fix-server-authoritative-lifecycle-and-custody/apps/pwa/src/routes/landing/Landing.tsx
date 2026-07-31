import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '@/lib/api';
import { cacheConsoleLevel, getCachedConsoleLevel, getCachedUser, getSessionToken } from '@/lib/auth';

/**
 * THE ENTRY ROUTER (blackbox-pwa.pages.dev root).
 *
 * This is what "Launch App" on the public site opens into, so it wears the house brand —
 * ink, bone, amber, IBM Plex — and reads as the same ecosystem rather than an unrelated
 * tab. From here every destination is an INTERNAL route: the app, the console, sign-in,
 * onboarding. Onboarding is ONE branch, not the default everybody was dumped onto.
 *
 * §0a — WHY THIS FILE CAN NEVER BE THE HIDDEN FACADE'S PROBLEM.
 *
 * The installed PWA is called "Stillpoint" and its start_url is `/`. For a covert
 * install, `/` MUST render the meditation disguise — a branded splash there would be the
 * single loudest tell in the product. So RootGate checks covert FIRST and returns the
 * facade without ever reaching this component. This file is only ever mounted when the
 * install is NOT covert. It is also never linked from any facade surface.
 *
 * The wordmark is built from type, not from the app icon: those icons are the DISGUISE
 * (a wellness mark, deliberately) and must keep looking like one on the home screen.
 */

type Level = 'DEV' | 'ADMIN' | 'COORD' | null;

/** The house mark. Same language as the console header, so the two read as one system. */
function Wordmark(): JSX.Element {
  return (
    <div className="mb-3 font-mono text-[12px] uppercase tracking-[0.22em] text-bb-text-secondary">
      <b className="font-bold text-bb-text">BLACK BOX</b> <span className="text-status-armed">■</span> SENTINEL
    </div>
  );
}

function Action({
  to,
  title,
  detail,
  primary,
  badge,
}: {
  to: string;
  title: string;
  detail: string;
  primary?: boolean;
  badge?: string;
}): JSX.Element {
  return (
    <Link
      to={to}
      className={`flex items-center justify-between gap-4 border p-4 transition-colors ${
        primary
          ? 'border-status-armed bg-status-armed/10 hover:bg-status-armed/20'
          : 'border-bb-border-defined bg-bb-surface hover:border-bb-text-secondary'
      }`}
    >
      <span className="min-w-0">
        <span className={`mb-1 block text-[13px] font-medium ${primary ? 'text-status-armed' : 'text-bb-text'}`}>
          {title}
        </span>
        <span className="block text-[11px] leading-relaxed text-bb-text-secondary">{detail}</span>
      </span>
      {badge ? (
        <span className="shrink-0 border border-bb-border-defined px-2 py-[2px] font-mono text-[9px] uppercase tracking-[0.1em] text-bb-text-secondary">
          {badge}
        </span>
      ) : (
        <span className="shrink-0 font-mono text-[11px] text-bb-text-tertiary">→</span>
      )}
    </Link>
  );
}

export function Landing(): JSX.Element {
  const signedIn = getSessionToken() != null;
  // Start from the cached hint so the first paint is already correct for a roled user
  // (no flash of the wrong set of choices), then confirm against the server below.
  const [level, setLevel] = useState<Level>(signedIn ? (getCachedConsoleLevel() as Level) : null);
  const user = getCachedUser();

  useEffect(() => {
    if (!signedIn) {
      cacheConsoleLevel(null);
      return;
    }
    // SERVER-SIDE truth. The cache only chose the first paint; this is what the page
    // settles on, and it is also what refreshes the hint for the next cold start.
    void api<{ level: string; levelLabel: string }>('/v1/console/me').then((r) => {
      const next = r.ok && r.data && r.data.level !== 'unmarked' ? (r.data.levelLabel as Level) : null;
      setLevel(next);
      cacheConsoleLevel(next);
    });
  }, [signedIn]);

  return (
    <main className="flex min-h-full w-full flex-col items-center justify-center bg-bb-bg px-6 py-12 text-bb-text">
      <div className="w-full max-w-sm">
        <Wordmark />
        <h1 className="mb-2 font-display text-[30px] font-bold leading-tight tracking-[-0.01em]">
          {signedIn ? `Welcome back${user?.name ? `, ${user.name}` : ''}` : 'BlackBox Sentinel'}
        </h1>
        <p className="mb-8 text-[13px] leading-relaxed text-bb-text-secondary">
          {signedIn
            ? 'Where would you like to go?'
            : 'A personal safety system for people who cannot afford to be safe. Sign in, or create an account to set up your device.'}
        </p>

        <div className="flex flex-col gap-3">
          {signedIn ? (
            <>
              <Action
                to="/blackbox"
                title="Open the app"
                detail="Your device, your contacts, and the trigger."
                primary
              />
              {/* Only a roled account is offered the console, and the console re-checks
                  the session server-side regardless of how it was reached. */}
              {level ? (
                <Action
                  to="/console"
                  title="Console"
                  detail="Organisations, access codes and enrolment readiness."
                  badge={level}
                />
              ) : null}
              <Action to="/settings" title="Settings" detail="Contacts, visibility, and your account." />
            </>
          ) : (
            <>
              <Action to="/signin" title="Sign in" detail="Passkey, email link, or a recovery code." primary />
              <Action
                to="/onboarding"
                title="Create an account"
                detail="Set up a new device. It takes a couple of minutes."
              />
            </>
          )}
        </div>

        <p className="mt-10 border-t border-bb-border-subtle pt-4 font-mono text-[10px] uppercase leading-[1.9] tracking-[0.08em] text-bb-text-tertiary">
          Your recordings belong to you. No one here — including us — can read them.
        </p>
      </div>
    </main>
  );
}
