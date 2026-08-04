import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatEvidenceLabel } from '@blackbox/shared';
import { envelopeEncryptionEnabled } from '@/lib/env';
import {
  listReviewableEvents,
  openCaptureForReview,
  revokeReview,
  type ReviewCapture,
  type ReviewEventSummary,
} from '@/lib/report/playback';
import { buildSummaryPanel, toneLabel, type SummaryItem } from '@/lib/review/summary';
import { activeLineIndex, buildTranscript } from '@/lib/review/transcript';
import { formatCoord, formatDistance, plotLocations, type LocationPlot } from '@/lib/review/geo';
import { computeWaveform, waveformPath, type Waveform } from '@/lib/review/waveform';

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
 * EVERY PANEL IS A REPLAY, NEVER AN ANALYSIS. The summary, transcript and location panels
 * render rows that were written during the incident. Nothing on this screen examines the
 * media and asserts a conclusion about it; nothing infers; a field with no recorded signal
 * stays empty. See lib/review/summary.ts for why the people rows are structurally unnamed.
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

  /** Newest first. The Worker already orders it this way; sorting here too means the ordering
   *  is a property of this screen rather than a remote detail that could quietly change. */
  const ordered = useMemo(
    () => (events ? [...events].sort((a, b) => b.createdAt - a.createdAt) : null),
    [events],
  );

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
          {step === 'watch' ? 'Close dashboard' : 'Close'}
        </button>
        <span className="text-[11px] uppercase tracking-[0.18em] text-med-text/40">Evidence review</span>
      </div>

      {/* The list and the failure states stay in a narrow reading column; the dashboard itself
          needs the full width on a desktop, so it opts out of the max-width. */}
      <div
        className={`flex-1 overflow-y-auto px-4 pb-10 pt-6 sm:px-6 ${
          step === 'watch' ? 'w-full' : 'mx-auto w-full max-w-md'
        }`}
      >
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
            {ordered === null ? <p className="text-[13px] text-med-text/50">Loading&hellip;</p> : null}
            {ordered !== null && ordered.length === 0 ? (
              <p className="text-[13px] leading-relaxed text-med-text/55">There are no records on your account yet.</p>
            ) : null}
            <div className="space-y-2.5">
              {(ordered ?? []).map((e) => (
                <button
                  key={e.eventId}
                  onClick={() => void open(e.eventId)}
                  className="w-full rounded-lg border border-med-text/25 px-4 py-3.5 text-left transition-colors hover:border-med-text/60 hover:bg-med-text/5"
                >
                  {/* THE NAME OF THE SEALED RECORDING. Not the stored identifier — she does
                      not recognise `evt-9f2c…`, she recognises the evening it happened. Her
                      own local clock at the time, so it reads the same wherever she reviews it. */}
                  <span className="block font-mono text-[15px] tracking-[0.02em] text-med-text">
                    {formatEvidenceLabel(e.createdAt, e.tzOffsetMinutes)}
                  </span>
                  <span className="mt-0.5 block text-[12px] text-med-text/45">
                    {e.status}
                    {e.closedAt ? ` · closed ${formatEvidenceLabel(e.closedAt, e.tzOffsetMinutes)}` : ''}
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
          <Dashboard capture={capture} onBack={backToList} onActivity={touch} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The dashboard. Two columns on a wide screen, one on a phone — and the ORDER of that single
 * column is chosen, not inherited: recording, then transport, then what the record said, then
 * her words, then where she was. On a phone she scrolls that sequence; on a desktop the same
 * panels sit side by side and nothing is hidden behind a tab.
 */
function Dashboard({
  capture,
  onBack,
  onActivity,
}: {
  capture: ReviewCapture;
  onBack: () => void;
  onActivity: () => void;
}): JSX.Element {
  // HTMLMediaElement, not the video/audio subtype: play/pause/currentTime/duration all live on
  // the shared base, so one transport drives either element without a cast.
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [positionSec, setPositionSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [running, setRunning] = useState(false);
  const [peaks, setPeaks] = useState<Waveform | null>(null);
  const [peaksSettled, setPeaksSettled] = useState(false);

  const { record } = capture;
  const eventStart = record.event?.createdAt ?? 0;
  const tz = record.event?.tzOffsetMinutes ?? null;

  /**
   * One playback tick means two things, so it is one handler: she is still attending (the
   * protective idle clear watches this), and the transport clock has moved. Keeping them
   * together is what guarantees the displayed position is the element's real position rather
   * than a counter that could drift away from the audio she is hearing.
   */
  const touch = useCallback(() => {
    onActivity();
    setPositionSec(mediaRef.current?.currentTime ?? 0);
  }, [onActivity]);

  // The waveform is drawn from the decrypted bytes already in memory. It is decoration: if it
  // cannot be produced the transport below still works, so a failure here is not surfaced as
  // an error to her.
  useEffect(() => {
    let live = true;
    void computeWaveform(capture.blob).then((w) => {
      if (!live) return;
      setPeaks(w);
      setPeaksSettled(true);
    });
    return () => {
      live = false;
    };
  }, [capture.blob]);

  const transcript = useMemo(() => buildTranscript(record.fragments, eventStart), [record.fragments, eventStart]);
  const activeLine = activeLineIndex(transcript, positionSec);

  // The summary DEVELOPS as she replays: only what had been observed by the current playback
  // position is shown. Before she presses play, the panel shows the whole event rather than an
  // empty box — an empty panel would read as "nothing was recorded", which is a different and
  // false statement.
  const throughMs = running || positionSec > 0 ? eventStart + positionSec * 1000 : Infinity;
  const summary = useMemo(() => buildSummaryPanel(record.observations, throughMs), [record.observations, throughMs]);

  const plot = useMemo(() => plotLocations(record.locations), [record.locations]);

  /** Seeking is only meaningful once the element has told us how long the recording is. */
  const seekable = durationSec > 0 && Number.isFinite(durationSec);

  /**
   * Play/pause. NOTHING plays until she presses this — there is no autoplay on entry and no
   * repeat at the end. The media element is the clock: the transport asks it to start or stop
   * and then renders whatever position it reports, so the numbers on screen are always the
   * real playback position rather than a counter that could drift away from the audio.
   */
  function toggle(): void {
    const el = mediaRef.current;
    if (!el) return;
    touch();
    if (el.paused) {
      void el.play().catch(() => setRunning(false));
    } else {
      el.pause();
    }
  }

  /** Back to the start, still paused — a deliberate re-listen, never an automatic one. */
  function reset(): void {
    const el = mediaRef.current;
    if (!el) return;
    touch();
    el.pause();
    el.currentTime = 0;
    setPositionSec(0);
  }

  /** Scrub. `fraction` is 0..1 across the waveform, so a tap anywhere on it seeks there. */
  function seekTo(fraction: number): void {
    const el = mediaRef.current;
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
    touch();
    const target = Math.min(el.duration, Math.max(0, fraction * el.duration));
    el.currentTime = target;
    setPositionSec(target);
  }

  /** A callback ref, so one HTMLMediaElement handle serves both the video and audio cases. */
  const attach = (el: HTMLMediaElement | null): void => {
    mediaRef.current = el;
  };
  const onRunning = (): void => setRunning(true);
  const onStopped = (): void => setRunning(false);
  const onDuration = (): void => setDurationSec(mediaRef.current?.duration ?? 0);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-serif text-xl font-light">
          <span className="font-mono tracking-[0.02em]">{formatEvidenceLabel(eventStart, tz)}</span>
        </h2>
        <button onClick={onBack} className="text-[12px] text-med-text/50 underline">
          Choose another recording
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── LEFT COLUMN ─────────────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Panel title="Recording">
            {/* Deliberate open: she chose this recording, and nothing starts until she presses
                play below. onTimeUpdate keeps the idle clear from firing while she watches. */}
            {capture.media.kind === 'video' ? (
              <video
                ref={attach}
                src={capture.media.url}
                onTimeUpdate={touch}
                onPlay={onRunning}
                onPause={onStopped}
                onEnded={onStopped}
                onDurationChange={onDuration}
                onLoadedMetadata={onDuration}
                preload="metadata"
                playsInline
                className="w-full rounded border border-med-text/20 bg-black"
              />
            ) : (
              <>
                {/* The element is visually hidden because the waveform IS the audio UI.
                    `preload="metadata"` + onLoadedMetadata ask for the duration BEFORE she
                    presses play, which the transport needs: seekTo() cannot convert a scrub
                    fraction into a time without a finite duration, so without this, scrubbing
                    would do nothing until after the first play. Metadata only — no audio data
                    is fetched until she chooses to play. The waveform below does not depend on
                    this at all; it is computed from the decrypted Blob directly. */}
                <audio
                  ref={attach}
                  src={capture.media.url}
                  onTimeUpdate={touch}
                  onPlay={onRunning}
                  onPause={onStopped}
                  onEnded={onStopped}
                  onDurationChange={onDuration}
                  onLoadedMetadata={onDuration}
                  preload="metadata"
                  className="hidden"
                />
                <div className="flex h-28 items-center justify-center rounded border border-med-text/20 bg-black/40 text-[12px] text-med-text/40">
                  Audio only — no camera recording in this capture
                </div>
              </>
            )}
          </Panel>

          <Panel title="Sound">
            {/* HONEST STATUS on the scrub target. Seeking needs a known duration, and until the
                media element reports one a tap on the waveform cannot go anywhere. Rather than
                absorb the tap and appear broken, the waveform says seeking is not ready — a
                control that quietly does nothing is the failure mode this project forbids. */}
            <WaveformView
              peaks={peaks}
              settled={peaksSettled}
              progress={durationSec > 0 ? positionSec / durationSec : 0}
              onSeek={seekable ? seekTo : null}
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Transport onClick={toggle}>{running ? 'Pause' : 'Play'}</Transport>
              <Transport onClick={reset}>Reset</Transport>
              <span className="ml-auto font-mono text-[12px] text-med-text/50">
                {clock(positionSec)} / {seekable ? clock(durationSec) : '--:--'}
              </span>
            </div>
          </Panel>

          <Panel title="This capture">
            <dl className="space-y-1.5 text-[12px]">
              <Stat k="Date" v={formatEvidenceLabel(eventStart, tz).split('@')[0]} />
              <Stat k="Time" v={formatEvidenceLabel(eventStart, tz).split('@')[1]} />
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
            <p className="mt-3 text-[12px] leading-relaxed text-med-text/50">
              Any information you can provide. Do not rush or pressure yourself.
            </p>
          </Panel>
        </div>

        {/* ── RIGHT COLUMN ────────────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Panel title="Summary">
            {/* READ-ONLY BY CONSTRUCTION — there is no input, no editable field, and no save
                on this panel. It replays what the record holds. */}
            <p className="mb-3 text-[11px] leading-relaxed text-med-text/40">
              What the system recorded as this happened. It is not an interpretation, and it cannot be edited.
            </p>
            {summary.empty ? (
              <p className="text-[12px] leading-relaxed text-med-text/55">
                Nothing was recorded in these fields for this capture.
              </p>
            ) : null}
            <dl className="space-y-2 text-[12px]">
              {/* The people rows are unnamed on purpose: nothing in the record establishes who
                  anyone is, and guessing would be the most damaging thing this screen could do. */}
              <Field
                label="Aggressor(s)"
                items={summary.aggressors}
                fallback={
                  summary.multipleSpeakersHeard
                    ? 'More than one voice was heard. The record does not identify anyone.'
                    : 'Not recorded — the system never names a person.'
                }
              />
              <Field
                label="Victim(s)"
                items={summary.victims}
                fallback="Not recorded — the system never names a person."
              />
              <Field label="Tone" items={summary.tone} render={toneLabel} />
              {/* ═══ BRIEF 55 §D3 — WHAT AN EMPTY FIELD IS ALLOWED TO SAY ══════════════════
                  These two read "Weapon(s)" and "Danger(s)" with a fallback of "Not recorded.",
                  and that combination made a specific false statement. A capture whose transcript
                  contained "I'm gonna cut your throat" rendered `WEAPON(S): Not recorded` — which
                  a survivor reads as NOTHING LIKE THAT HAPPENED, when what actually happened is
                  that the detection had no entry for it.

                  "Not recorded" describes the world. "Not established from audio" describes the
                  instrument, which is the only thing this page has ever been able to speak about.
                  The field names say REFERENCES and SIGNALS for the same reason: they are claims
                  about language that was heard, never claims that a weapon was in the room. The
                  survivor corroborates what was present; the system records only what it heard,
                  and it must never upgrade an implication into a confirmation. */}
              <Field
                label="Weapon references"
                items={summary.weapons}
                fallback="Not established from audio — no weapon was referred to in language the detection could read."
              />
              <Field
                label="Danger signals"
                items={summary.dangers}
                fallback="Not established from audio — no danger category was detected in what could be read."
              />
            </dl>
            {summary.recordedNotes.length > 0 ? (
              <div className="mt-3 border-t border-med-text/10 pt-3">
                <span className="text-[11px] uppercase tracking-[0.14em] text-med-text/35">Recorded at the time</span>
                <ul className="mt-1.5 space-y-1">
                  {summary.recordedNotes.map((n) => (
                    <li key={`${n.at}-${n.text}`} className="text-[12px] leading-relaxed text-med-text/65">
                      {n.text}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Panel>

          <Panel title="Transcript">
            {transcript.length === 0 ? (
              <p className="text-[12px] leading-relaxed text-med-text/55">No transcript was recorded.</p>
            ) : (
              <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                {transcript.map((line, i) => (
                  <p
                    key={line.sequence}
                    className={`text-[13px] leading-relaxed transition-colors ${
                      i === activeLine ? 'text-med-text' : 'text-med-text/45'
                    }`}
                  >
                    {/* Jump to where these words fall. Not underlined as a link when seeking is
                        unavailable — it would advertise an action it could not perform. */}
                    <button
                      onClick={() => seekable && seekTo(line.offsetSec / durationSec)}
                      disabled={!seekable}
                      className={`mr-2 font-mono text-[11px] text-med-text/35 ${seekable ? 'underline' : ''}`}
                    >
                      {clock(line.offsetSec)}
                    </button>
                    {line.text}
                    {!line.final ? <span className="ml-1 text-[11px] text-med-text/30">(partial)</span> : null}
                  </p>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Location">
            <LocationPanel plot={plot} />
          </Panel>
        </div>
      </div>

      <p className="mt-6 text-[12px] leading-relaxed text-med-text/45">
        Nothing here is saved to your phone. To keep a copy, or to give one to someone, make an official
        report — that is the step that produces a file, and it explains what changes when it does.
      </p>
      <Secondary onClick={onBack}>Back to your recordings</Secondary>
    </div>
  );
}

/** mm:ss for a position in seconds. */
function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * The waveform, with a progress cursor. Click or drag anywhere to seek.
 *
 * When the audio could not be decoded this degrades to a plain progress bar rather than
 * disappearing — the scrub target must still be there, because seeking is the useful part and
 * the picture is not.
 */
function WaveformView({
  peaks,
  settled,
  progress,
  onSeek,
}: {
  peaks: Waveform | null;
  settled: boolean;
  progress: number;
  /** null when the recording's length is not known yet, so seeking cannot work. */
  onSeek: ((fraction: number) => void) | null;
}): JSX.Element {
  const W = 1000;
  const H = 120;

  function fractionFrom(e: React.PointerEvent<HTMLDivElement>): number {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
  }

  return (
    <div
      role="presentation"
      onPointerDown={(e) => onSeek?.(fractionFrom(e))}
      onPointerMove={(e) => {
        // Only while a button is held: `buttons` is a bitmask, so 0 means a bare hover.
        if (e.buttons > 0) onSeek?.(fractionFrom(e));
      }}
      className={`relative h-[72px] w-full touch-none overflow-hidden rounded border border-med-text/20 bg-black/40 ${
        onSeek ? 'cursor-pointer' : 'cursor-default'
      }`}
    >
      {peaks && peaks.length > 0 ? (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
          <polygon points={waveformPath(peaks, W, H)} fill="rgba(160,214,214,0.32)" />
          <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="rgba(160,214,214,0.18)" strokeWidth={1} />
        </svg>
      ) : (
        <div className="flex h-full items-center justify-center text-[11px] text-med-text/35">
          {settled ? 'Sound could not be drawn — playback and seeking still work' : 'Reading sound…'}
        </div>
      )}
      {!onSeek && peaks && peaks.length > 0 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-1 text-center text-[10px] text-med-text/35">
          Press play to enable seeking
        </div>
      ) : null}
      {/* The playback cursor. */}
      <div
        className="pointer-events-none absolute inset-y-0 w-px bg-[#a0d6d6]/70"
        style={{ left: `${Math.min(100, Math.max(0, progress * 100))}%` }}
      />
      <div
        className="pointer-events-none absolute inset-y-0 left-0 bg-[#a0d6d6]/8"
        style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
      />
    </div>
  );
}

/**
 * The location panel: her recorded fixes drawn against a plain graticule.
 *
 * No tiles, no street names, no third-party request — see lib/review/geo.ts for why that is a
 * privacy requirement rather than a shortcut. The coordinates are printed because they, not
 * the drawing, are the record.
 */
function LocationPanel({ plot }: { plot: LocationPlot }): JSX.Element {
  if (!plot.start) {
    return <p className="text-[12px] leading-relaxed text-med-text/55">No location was recorded.</p>;
  }

  const path = plot.points.map((p) => `${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`).join(' ');

  return (
    <>
      <div className="relative overflow-hidden rounded border border-med-text/20 bg-black/40">
        <svg viewBox="0 0 100 100" className="h-44 w-full sm:h-56">
          {/* A graticule for scale only — it is not a map of anything. */}
          {[20, 40, 60, 80].map((g) => (
            <g key={g}>
              <line x1={g} y1={0} x2={g} y2={100} stroke="rgba(160,214,214,0.08)" strokeWidth={0.4} />
              <line x1={0} y1={g} x2={100} y2={g} stroke="rgba(160,214,214,0.08)" strokeWidth={0.4} />
            </g>
          ))}
          {/* The travelled path renders ONLY when she actually moved. Drawing a line between
              jittering fixes at one address would depict a journey that never happened. */}
          {plot.traveling && plot.points.length > 1 ? (
            <polyline points={path} fill="none" stroke="rgba(160,214,214,0.5)" strokeWidth={0.8} />
          ) : null}
          {plot.traveling && plot.end ? (
            <circle cx={plot.points[plot.points.length - 1].x * 100} cy={plot.points[plot.points.length - 1].y * 100} r={1.8} fill="#a0d6d6" />
          ) : null}
          {/* Start pin, always. */}
          <circle cx={plot.points[0].x * 100} cy={plot.points[0].y * 100} r={2.4} fill="none" stroke="#e8b4b8" strokeWidth={0.9} />
          <circle cx={plot.points[0].x * 100} cy={plot.points[0].y * 100} r={0.9} fill="#e8b4b8" />
        </svg>
      </div>
      <dl className="mt-3 space-y-1.5 text-[12px]">
        <Stat k="Start" v={formatCoord(plot.start)} />
        <Stat k="Traveling" v={plot.traveling ? 'Yes' : 'No'} />
        {plot.traveling ? (
          <>
            <Stat k="Distance covered" v={formatDistance(plot.pathMetres)} />
            <Stat k="Straight-line" v={formatDistance(plot.netMetres)} />
            {plot.end ? <Stat k="Last fix" v={formatCoord(plot.end)} /> : null}
          </>
        ) : null}
        <Stat k="Fixes recorded" v={String(plot.points.length)} />
      </dl>
      <p className="mt-2 text-[11px] leading-relaxed text-med-text/35">
        Drawn from your recorded coordinates on this device. No map service is contacted, so looking at this
        tells nobody where you were.
      </p>
    </>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded-lg border border-med-text/15 bg-black/20 p-4">
      <h3 className="mb-3 text-[11px] uppercase tracking-[0.16em] text-med-text/40">{title}</h3>
      {children}
    </section>
  );
}

/** One summary field. An empty field says so — it is never quietly omitted, because a missing
 *  row and a recorded-nothing row mean different things to someone reading this as evidence. */
function Field({
  label,
  items,
  fallback = 'Not recorded.',
  render,
}: {
  label: string;
  items: SummaryItem[];
  fallback?: string;
  render?: (v: string) => string;
}): JSX.Element {
  return (
    <div className="border-b border-med-text/10 pb-2">
      <dt className="text-[11px] uppercase tracking-[0.12em] text-med-text/35">{label}</dt>
      <dd className="mt-1">
        {items.length === 0 ? (
          <span className="text-med-text/40">{fallback}</span>
        ) : (
          <span className="flex flex-wrap gap-1.5">
            {items.map((i) => (
              <span
                key={i.label}
                className="rounded border border-med-text/20 bg-med-text/5 px-2 py-0.5 text-med-text/80"
              >
                {render ? render(i.label) : i.label}
                {/* §D2 — the count is how many 5-second classification ticks carried this
                    category, NOT how many times it was said. Twelve ticks of one latched match
                    rendered as "×12" reads as twelve incidents, which is the inflation that
                    turned a single word into twenty-four dangers. The number is still useful —
                    a category present throughout differs from one that fired once — so it is
                    kept and LABELLED rather than dropped or left to be misread. */}
                {i.observations > 1 ? (
                  <span className="ml-1 text-med-text/40" title="Number of 5-second classification intervals in which this category was present">
                    · in {i.observations} intervals
                  </span>
                ) : null}
              </span>
            ))}
          </span>
        )}
      </dd>
    </div>
  );
}

function Transport({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      {...p}
      className="rounded-full border border-med-text/25 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-med-text/75 transition-colors hover:border-med-text/60"
    >
      {children}
    </button>
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
    <div className="flex justify-between gap-3 border-b border-med-text/10 pb-1.5">
      <dt className="shrink-0 text-med-text/50">{k}</dt>
      <dd className={`text-right ${warn ? 'text-med-warn/80' : 'text-med-text/80'}`}>{v}</dd>
    </div>
  );
}
