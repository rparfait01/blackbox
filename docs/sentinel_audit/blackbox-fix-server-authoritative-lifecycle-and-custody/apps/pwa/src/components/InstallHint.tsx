import { useEffect, useState } from 'react';

/**
 * Install affordance (Fix Brief 1 #10). Three cases:
 *  - already installed (standalone display-mode) → render nothing.
 *  - Android / desktop Chrome → capture `beforeinstallprompt` and show a real
 *    Install button that calls prompt().
 *  - iOS Safari → no automatic prompt exists, so show the manual Add-to-Home-
 *    Screen steps (Share → Add to Home Screen).
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari exposes navigator.standalone
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function InstallHint(): JSX.Element | null {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone());

  useEffect(() => {
    const onPrompt = (e: Event): void => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = (): void => setInstalled(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed) {
    return null;
  }

  if (deferred) {
    return (
      <button
        type="button"
        onClick={() => {
          void deferred.prompt();
          setDeferred(null);
        }}
        className="w-full rounded-full border border-med-text/40 py-3 text-sm font-medium text-med-text"
      >
        Install app to your phone
      </button>
    );
  }

  if (isIos()) {
    return (
      <div className="rounded-lg border border-med-text/20 bg-black/20 p-4 text-[12px] leading-relaxed text-med-text/70">
        <p className="mb-1 font-medium text-med-text/85">Add to your Home Screen</p>
        <p>
          In Safari, tap the Share icon (the square with an up-arrow), then “Add to Home Screen”.
          Launching from the home-screen icon runs it full-screen, with no browser bar.
        </p>
      </div>
    );
  }

  return null;
}
