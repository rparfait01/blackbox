import { useCallback, useEffect, useRef, useState } from 'react';

import { envelopeEncryptionEnabled } from '@/lib/env';
import {
  listReviewableEvents,
  openCaptureForReview,
  revokeReview,
  type ReviewCapture,
  type ReviewEventSummary,
} from '@/lib/report/playback';

/**
 * Evidence review — the survivor looking at her own captures.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE CERTIFIED REPORT. The report produces a document she
 * can hand to someone else. This produces nothing: the recording is decrypted in this tab,
 * played, and released when she closes the screen. There is no download, no share, no export
 * here — the moment evidence becomes a file is a moment with consequences, and it belongs to
 * the report flow, behind its custody caution, not to browsing.
 *
 * IT IS HERS AND ONLY HERS. Every endpoint is owner-scoped; the decryption happens on this
 * device with her key. The server hands over ciphertext and cannot open it. If this device
 * does not hold her key, we say so plainly instead of showing an empty player.
 *
 * Settings/Visible only — never reachable from the Hidden facade (§0a). Gated on
 * zero-knowledge custody: with the flag off there is nothing sealed to review, and the
 * screen says that honestly rather than failing.
 */

type Step = 'blocked' | 'pick' | 'opening' | 'watch' | 'failed';

/**
 * How long a decrypted recording may sit on screen untouched before it clears itself.
 * Playback counts as activity (timeupdate fires while it plays), so this never interrupts
 * her watching — it catches the phone put down, handed over, or taken.
 */
const IDLE_CLEAR_MS = 120_000;

const FAILURE_COPY: Record<string, string> = {
  disabled: 'Secure storage is not enabled yet, so there is no sealed recording to review.',
  no_key: 'This device does not hold your key, so your recording cannot be opened here.',
  no_event: 'That record could not be found.',
  no_capture: 'Nothing was recorded for that record.',
  unopenable: 'Your recording is here, but none of it could be opened on this device.',
  network: 'No connection. Nothing was opened.',
};

export function EvidenceReview({ onClose }: { onClose: () => void }): JSX.Element {
  const [step, setStep] = useState<Step>(envelopeEncryptionEnabled ? 'pick' : 'blocked');
  const [events, setEvents] = useState<ReviewEventSummary[] | null>(null);
  const [capture, setCapture] = useState<ReviewCapture | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Held in a ref as well so teardown can revoke the object URL without re-running on every
  // state change — the bytes must not outlive this screen.
  const openRef = useRef<ReviewCapture | null>(null);
  // Kept in a ref so the protective-clear effect never re-subscribes (and so never resets the
  // idle window) just because Settings re-rendered and handed us a new closure.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (step !== 'pick' || events !== null) return;
    void listReviewableEvents().then((list) => setEvents(list ?? []));
  }, [step, events]);

  useEffect(() => {
    return () => revokeReview(openRef.current);
  }, []);

  /** Last sign of her attention. Playback counts (see onTimeUpdate), so watching a long
   *  recording without touching the screen is never mistaken for walking away. */
  const lastActivity = useRef(Date.now());
  const touch = useCallback(() => {
    lastActivity.current = Date.now();
  }, []);

  /**
   * Protective clearing. Decrypted evidence lives in this tab's memory and nowhere else, and
   * it must not outlive her attention: backgrounding the app, or leaving it untouched, drops
   * the screen back to Settings with the bytes released.
   *
   * This is not a lock and does not pretend to be one. It is the difference between someone
   * picking up her phone and finding the worst moment of her life on screen, and finding
   * settings.
   */
  useEffect(() => {
    if (step !== 'watch') return undefined;

    const clear = (): void => {
      revokeReview(openRef.current);
      openRef.current = null;
      onCloseRef.current();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') clear();
    };
    const tick = window.setInterval(() => {
      if (Date.now() - lastActivity.current > IDLE_CLEAR_MS) clear();
    }, 10_000);

    lastActivity.current = Date.now();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', clear);
    document.addEventListener('pointerdown', touch, true);
    document.addEventListener('keydown', touch, true);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', clear);
      document.removeEventListener('pointerdown', touch, true);
      document.removeEventListener('keydown', touch, true);
    };
  }, [step, touch]);

  async function open(eventId: string): Promise<void> {
    setError(null);
    setStep('opening');
    const result = await openCaptureForReview(eventId);
    if (!result.ok) {
      setError(FAILURE_COPY[result.reason] ?? 'Nothing could be opened.');
      setStep('failed');
      return;
    }
    revokeReview(openRef.current);
    openRef.current = result.capture;
    setCapture(result.capture);
    setStep('watch');
  }

  function backToList(): void {
    revokeReview(openRef.current);
    openRef.current = null;
    setCapture(null);
    setStep('pick');
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#071416]/97 text-med-text backdrop-blur-sm">
      {/* Always present, never buried: one tap clears the decrypted view and leaves. It is
          the ordinary way out AND the quick exit — the same control, so there is nothing to
          find in a hurry. */}
      <div className="flex shrink-0 items-center justify-between border-b border-med-text/15 px-6 pb-3 pt-safe-4">
        <button
          onClick={() => {
            revokeReview(openRef.current);
            openRef.current = null;
            onClose();
          }}
          className="text-sm text-med-text/70 underline"
        >
          Close
        </button>
        <span className="text-[11px] uppercase tracking-[0.18em] text-med-text/40">Evidence review</span>
      </div>

      <div className="mx-auto flex w-full max-w-md flex-1 flex-col overflow-y-auto px-6 pb-10 pt-6">
        {step === 'blocked' ? (
          <Center>
            <h2 className="mb-3 font-serif text-2xl font-light">Not available yet</h2>
            <p className="mb-8 text-[13px] leading-relaxed text-med-text/60">
              Reviewing your own recordings needs secure storage to be switched on for your account. Nothing here
              is broken — the feature is not on yet.
            </p>
            <Secondary onClick={onClose}>Close</Secondary>
          </Center>
        ) : null}

        {step === 'pick' ? (
          <div className="flex flex-1 flex-col">
            <h2 className="mb-2 font-serif text-2xl font-light">Your recordings</h2>
            <p className="mb-6 text-[13px] leading-relaxed text-med-text/55">
              These are yours. They are opened here, on this phone, with your key — nothing is downloaded and
              nothing is sent anywhere.
            </p>
            {events === null ? <p className="text-[13px] text-med-text/50">Loading&hellip;</p> : null}
            {events !== null && events.length === 0 ? (
              <p className="text-[13px] leading-relaxed text-med-text/55">There are no records on your account yet.</p>
            ) : null}
            <div className="space-y-2.5">
              {(events ?? []).map((e) => (
                <button
                  key={e.eventId}
                  onClick={() => void open(e.eventId)}
                  className="w-full rounded-lg border border-med-text/25 px-4 py-3.5 text-left transition-colors hover:border-med-text/60 hover:bg-med-text/5"
                >
                  <span className="block text-med-text">{new Date(e.createdAt).toLocaleString()}</span>
                  <span className="block text-[12px] text-med-text/45">
                    {e.status}
                    {e.closedAt ? ` · closed ${new Date(e.closedAt).toLocaleString()}` : ''}
                  </span>
                </button>
              ))}
            </div>
            <Secondary onClick={onClose}>Done</Secondary>
          </div>
        ) : null}

        {step === 'opening' ? (
          <Center>
            <h2 className="mb-3 font-serif text-2xl font-light">Opening your recording</h2>
            <p className="text-[13px] leading-relaxed text-med-text/60">
              This happens here, on your phone — not on a server. It can take a moment for a long recording.
            </p>
          </Center>
        ) : null}

        {step === 'failed' ? (
          <Center>
            <h2 className="mb-3 font-serif text-2xl font-light">Couldn&rsquo;t open it</h2>
            <p className="mb-8 text-[13px] leading-relaxed text-med-text/70">{error}</p>
            <Secondary onClick={backToList}>Back to your recordings</Secondary>
          </Center>
        ) : null}

        {step === 'watch' && capture ? (
          <div className="flex flex-1 flex-col">
            <h2 className="mb-4 font-serif text-2xl font-light">Your recording</h2>
            {/* Deliberate open, never autoplay: she chose this recording, and nothing plays
                at her until she presses play. onTimeUpdate keeps the idle clear from firing
                while she is actually watching. */}
            {capture.media.kind === 'video' ? (
              <video
                src={capture.media.url}
                controls
                playsInline
                onTimeUpdate={touch}
                className="w-full rounded-lg border border-med-text/20 bg-black"
              />
            ) : (
              <audio src={capture.media.url} controls onTimeUpdate={touch} className="w-full" />
            )}

            {/* Honest status (never a silent omission): what opened, what did not, and
                whether what opened is bit-for-bit what the device recorded at the time. */}
            <dl className="mt-6 space-y-1.5 text-[12px]">
              <Stat k="Segments played" v={String(capture.segmentsOpened)} />
              {capture.segmentsUnopenable > 0 ? (
                <Stat k="Could not be opened" v={String(capture.segmentsUnopenable)} warn />
              ) : null}
              {capture.segmentsMissing > 0 ? <Stat k="Not found" v={String(capture.segmentsMissing)} warn /> : null}
              <Stat
                k="Matches what was recorded"
                v={
                  capture.segmentsVerified + capture.segmentsFailedCheck === 0
                    ? 'No capture-time check available'
                    : `${capture.segmentsVerified} of ${capture.segmentsVerified + capture.segmentsFailedCheck}`
                }
                warn={capture.segmentsFailedCheck > 0}
              />
            </dl>

            <p className="mt-5 text-[12px] leading-relaxed text-med-text/45">
              Nothing here is saved to your phone. To keep a copy, or to give one to someone, make an official
              report — that is the step that produces a file, and it explains what changes when it does.
            </p>

            <Secondary onClick={backToList}>Back to your recordings</Secondary>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="flex flex-1 flex-col items-center justify-center text-center">{children}</div>;
}
function Secondary({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return <button {...p} className="mt-6 block w-full text-center text-sm text-med-text/50 underline">{children}</button>;
}
function Stat({ k, v, warn }: { k: string; v: string; warn?: boolean }): JSX.Element {
  return (
    <div className="flex justify-between border-b border-med-text/10 pb-1.5">
      <dt className="text-med-text/50">{k}</dt>
      <dd className={warn ? 'text-med-warn/80' : 'text-med-text/80'}>{v}</dd>
    </div>
  );
}
