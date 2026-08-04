import { useEffect, useMemo, useState } from 'react';

import { listReviewableEvents, type ReviewEventSummary } from '@/lib/report/playback';
import { purgeMany, purgeRefusalText, type PurgeOutcome } from '@/lib/review/purge';
import { formatEvidenceLabel } from '@blackbox/shared';

/**
 * BRIEF 56 §B — DELETING HER OWN RECORDINGS.
 *
 * ═══ THE DESIGN HOLDS TWO TRUE THINGS AT ONCE ════════════════════════════════════════════════
 *
 * Deletion is a SAFETY feature. A survivor whose abuser has found the app is carrying recordings
 * that are dangerous to her, and being unable to destroy them is its own harm.
 *
 * And that record may be the only account of what happened to her that exists anywhere. It is
 * what a court sees. A deletion made in a bad hour cannot be taken back.
 *
 * So: MODERATE FRICTION, NEVER COERCION. Three explicit steps, the facts stated once in plain
 * language, and then it is hers to decide. What this screen deliberately does NOT do:
 *
 *   - argue with her, or repeat the warning
 *   - require her to type a word to prove she means it
 *   - impose a delay, a cooling-off period, or a support ticket
 *   - offer a select-all that can be hit by accident
 *   - say "delete 12 recordings" without showing which twelve
 *
 * Every one of those is a real pattern in consumer software and every one of them is a way of
 * making a person prove herself to a machine. She has done enough of that.
 *
 * ═══ §B6.1 — AN ACCEPTED RISK, STATED ════════════════════════════════════════════════════════
 *
 * Someone holding her unlocked phone can walk this flow and destroy her evidence. The friction
 * here is the only barrier and it is deliberately moderate.
 *
 * A PIN would not fix it. A PIN that an aggressor can force her to enter is worse than the
 * deletion, because it adds a coercion event to the harm — the same reasoning that put the
 * closure gesture where it is and that refuses this operation entirely during a live alert.
 * Accepted, knowingly.
 *
 * ═══ §B4 IS NOT BUILT, AND THAT IS RECORDED RATHER THAN HIDDEN ═══════════════════════════════
 *
 * "She may choose to notify her primary support contact" requires a new ChannelMessage kind,
 * which every channel implements exhaustively — router, LINE, SendGrid, Twilio, the email
 * builders and the stub, eight files inside the dispatch layer the ALERT path runs through.
 * That is not a change to make at the end of a long session ahead of a deploy, for an optional
 * notification that §B4 itself specifies as OFF by default.
 *
 * So the behaviour today is exactly the specified default: NOBODY IS TOLD. Not the coordinator,
 * not an organisation, not the operator. The screen says so plainly at the final step rather
 * than offering a switch that does nothing.
 */

type Step = 'select' | 'confirm' | 'final' | 'working' | 'done';

export function DeleteRecordings({ onClose }: { onClose: () => void }): JSX.Element {
  const [step, setStep] = useState<Step>('select');
  const [events, setEvents] = useState<ReviewEventSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<PurgeOutcome[] | null>(null);

  useEffect(() => {
    void listReviewableEvents().then((list) => setEvents(list ?? []));
  }, []);

  /** Only entries that still HAVE something to delete. An already-purged entry stays visible in
   *  her list (§B4) but is not offerable again — the flow never asks her to confirm a no-op. */
  const deletable = useMemo(
    () => (events ?? []).filter((e) => !e.capturePurged && (e.segments ?? 0) > 0),
    [events],
  );
  const chosen = useMemo(() => deletable.filter((e) => selected.has(e.eventId)), [deletable, selected]);
  const totalSegments = chosen.reduce((n, e) => n + (e.segments ?? 0), 0);

  function toggle(eventId: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  }

  async function run(): Promise<void> {
    setStep('working');
    setProgress({ done: 0, total: chosen.length });
    const results = await purgeMany(
      chosen.map((e) => e.eventId),
      (done, total) => setProgress({ done, total }),
    );
    setOutcomes(results);
    setStep('done');
    // Refresh so the list reflects reality rather than what we assume happened.
    void listReviewableEvents().then((list) => setEvents(list ?? []));
  }

  return (
    <section className="mx-auto w-full max-w-2xl">
      <div className="mb-4 flex items-baseline justify-between gap-2">
        <h2 className="font-serif text-xl font-light">Delete recordings</h2>
        <button onClick={onClose} className="text-[12px] text-med-text/50 underline">
          Back
        </button>
      </div>

      {/* ── STEP 1 — SELECT ──────────────────────────────────────────────────────────────── */}
      {step === 'select' ? (
        <>
          <WhatThisMeans />
          {events === null ? (
            <p className="text-[12px] text-med-text/55">Loading your recordings…</p>
          ) : deletable.length === 0 ? (
            <p className="text-[12px] leading-relaxed text-med-text/55">
              There are no recordings to delete.
            </p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {deletable.map((e) => (
                  <li key={e.eventId}>
                    <label className="flex cursor-pointer items-center gap-3 rounded border border-med-text/15 px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(e.eventId)}
                        onChange={() => toggle(e.eventId)}
                        className="h-4 w-4 shrink-0"
                      />
                      <span className="flex-1 font-mono text-[12px] tracking-[0.02em] text-med-text/85">
                        {formatEvidenceLabel(e.createdAt, e.tzOffsetMinutes)}
                      </span>
                      <span className="text-[11px] text-med-text/40">
                        {e.segments} {e.segments === 1 ? 'segment' : 'segments'}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {/* §B2 — no select-all. Each entry is chosen deliberately, one tap each. A control
                  that selects everything is one mis-tap away from destroying everything, and this
                  is the one screen in the app where a mis-tap is unrecoverable. */}
              <div className="mt-5 flex items-center justify-between gap-3">
                <span className="text-[12px] text-med-text/50">
                  {chosen.length === 0 ? 'Nothing selected' : `${chosen.length} selected`}
                </span>
                <button
                  disabled={chosen.length === 0}
                  onClick={() => setStep('confirm')}
                  className="rounded border border-med-text/30 px-4 py-2 text-[13px] text-med-text disabled:opacity-30"
                >
                  Continue
                </button>
              </div>
            </>
          )}
          {/* Already-deleted entries stay listed, marked. §B4: the entry is her own record that
              something happened, and removing it would be a second deletion she did not ask for. */}
          {(events ?? []).some((e) => e.capturePurged) ? (
            <div className="mt-6 border-t border-med-text/10 pt-4">
              <p className="mb-2 text-[11px] uppercase tracking-[0.14em] text-med-text/35">
                Already deleted
              </p>
              <ul className="space-y-1">
                {(events ?? [])
                  .filter((e) => e.capturePurged)
                  .map((e) => (
                    <li key={e.eventId} className="font-mono text-[12px] text-med-text/40">
                      {formatEvidenceLabel(e.createdAt, e.tzOffsetMinutes)} — recordings deleted
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      {/* ── STEP 2 — CONFIRM THE LIST ────────────────────────────────────────────────────── */}
      {step === 'confirm' ? (
        <>
          <p className="mb-3 text-[13px] leading-relaxed text-med-text">
            These recordings will be permanently deleted.
          </p>
          <ul className="space-y-1.5">
            {chosen.map((e) => (
              <li
                key={e.eventId}
                className="flex items-center gap-3 rounded border border-med-text/15 px-3 py-2.5"
              >
                <span className="flex-1 font-mono text-[12px] text-med-text/85">
                  {formatEvidenceLabel(e.createdAt, e.tzOffsetMinutes)}
                </span>
                <span className="text-[11px] text-med-text/40">
                  {e.segments} {e.segments === 1 ? 'segment' : 'segments'}
                </span>
                {/* §B2 — every entry is individually removable AT THIS POINT. Changing her mind
                    about one of twelve must not mean starting over. */}
                <button
                  onClick={() => toggle(e.eventId)}
                  className="text-[11px] text-med-text/50 underline"
                >
                  Keep this one
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] text-med-text/50">
            {chosen.length} {chosen.length === 1 ? 'recording' : 'recordings'} · {totalSegments}{' '}
            {totalSegments === 1 ? 'segment' : 'segments'} in total
          </p>

          {/* §B4 — NOT BUILT, AND DELIBERATELY NOT STUBBED. See the header note.
              A checkbox reading "tell my contact" that reaches no dispatcher is the exact defect
              class this codebase keeps producing: a control that reads as protective and protects
              nothing. Its absence is honest; a dead toggle would not be. */}
          <div className="mt-5 flex items-center justify-between gap-3">
            <button onClick={() => setStep('select')} className="text-[12px] text-med-text/50 underline">
              Back
            </button>
            <button
              disabled={chosen.length === 0}
              onClick={() => setStep('final')}
              className="rounded border border-med-text/30 px-4 py-2 text-[13px] text-med-text disabled:opacity-30"
            >
              Continue
            </button>
          </div>
        </>
      ) : null}

      {/* ── STEP 3 — FINAL ───────────────────────────────────────────────────────────────── */}
      {step === 'final' ? (
        <>
          <p className="mb-2 text-[15px] leading-relaxed text-med-text">
            Any changes before this is permanent?
          </p>
          <p className="mb-5 text-[12px] leading-relaxed text-med-text/55">
            {chosen.length} {chosen.length === 1 ? 'recording' : 'recordings'} ·{' '}
            {totalSegments} {totalSegments === 1 ? 'segment' : 'segments'}
            {/* Nobody is told. That is the current behaviour and it is what §B4 specifies as
                the DEFAULT — the optional notification simply does not exist yet. */}
            {' · nobody will be told'}
          </p>
          <div className="flex items-center justify-between gap-3">
            <button onClick={() => setStep('confirm')} className="text-[12px] text-med-text/50 underline">
              Change the list
            </button>
            <button
              onClick={() => void run()}
              className="rounded border border-status-armed/60 bg-status-armed/10 px-4 py-2 text-[13px] text-med-text"
            >
              Delete permanently
            </button>
          </div>
        </>
      ) : null}

      {/* ── WORKING — §B6.3, never a frozen screen ───────────────────────────────────────── */}
      {step === 'working' ? (
        <div>
          <p className="text-[13px] text-med-text">Deleting…</p>
          <p className="mt-1 font-mono text-[12px] text-med-text/55">
            {progress?.done ?? 0} of {progress?.total ?? 0}
          </p>
          <div className="mt-3 h-1 w-full overflow-hidden rounded bg-med-text/10">
            <div
              className="h-full bg-med-text/50 transition-[width]"
              style={{
                width: `${progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      ) : null}

      {/* ── DONE ─────────────────────────────────────────────────────────────────────────── */}
      {step === 'done' && outcomes ? <Result outcomes={outcomes} onClose={onClose} /> : null}
    </section>
  );
}

/**
 * §B1/§B3 — the facts, once.
 *
 * Stated at the start rather than repeated at every step, because repetition is how an interface
 * argues. The retained-chain paragraph is deliberately framed as what it is — a protection, not a
 * caveat: it is what stops anyone claiming the evidence never existed.
 */
function WhatThisMeans(): JSX.Element {
  return (
    <div className="mb-5 space-y-2 rounded border border-med-text/15 px-4 py-3.5">
      <p className="text-[12px] leading-relaxed text-med-text/75">
        These recordings may be the only account of what happened. A court cannot see what does not
        exist. This cannot be undone.
      </p>
      <p className="text-[12px] leading-relaxed text-med-text/75">
        The recordings are gone. The signed record that they existed stays, so nobody can claim
        they never did.
      </p>
    </div>
  );
}

/** What actually happened, per entry. A partial failure names which ones and why (§B5). */
function Result({ outcomes, onClose }: { outcomes: PurgeOutcome[]; onClose: () => void }): JSX.Element {
  const ok = outcomes.filter((o) => o.ok);
  const failed = outcomes.filter((o) => !o.ok);
  return (
    <div>
      <p className="text-[13px] leading-relaxed text-med-text">
        {ok.length} {ok.length === 1 ? 'recording' : 'recordings'} deleted.
      </p>
      {failed.length > 0 ? (
        <div className="mt-4 space-y-2">
          <p className="text-[12px] text-med-text/70">
            {failed.length} could not be deleted:
          </p>
          <ul className="space-y-1.5">
            {failed.map((f) => (
              <li key={f.eventId} className="text-[12px] leading-relaxed text-med-text/55">
                {purgeRefusalText(f.reason)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <button
        onClick={onClose}
        className="mt-6 rounded border border-med-text/30 px-4 py-2 text-[13px] text-med-text"
      >
        Done
      </button>
    </div>
  );
}
