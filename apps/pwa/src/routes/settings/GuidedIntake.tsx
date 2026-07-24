import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import {
  INCIDENT_TYPES,
  INJURY_OPTIONS,
  RELATIONSHIPS,
  WEAPON_COERCION_FLAGS,
  WHEN_RANGES,
  incidentTypeById,
} from '@/lib/intake/taxonomy';
import { REGIONS } from '@/lib/regions';
import { buildCaseFileRecord, draftSummary, sealCaseFile } from '@/lib/intake/case-file';
import { clearDraft, loadDraft, saveDraft, type IntakeDraft } from '@/lib/intake/draft';

/**
 * Guided intake (Brief 27 §3–§4) — a trauma-informed interview producing a structured,
 * standards-mapped case file, filed FAIL-CLOSED under zero-knowledge custody.
 *
 * Trauma-informed by construction: one prompt at a time; Pause/Stop reachable at EVERY
 * step; it NEVER auto-advances (there are no timers — the survivor advances by an explicit
 * action); it never grades, scores, or challenges an answer; every question is skippable.
 * Experiential (FETI-style) narrative prompts, not a chronological interrogation.
 *
 * A partial draft is sealed to the survivor's own key and resumable — never a plaintext
 * draft, never discarded. Filing requires an explicit review and is blocked entirely while
 * secure storage is off (the honest "not enabled yet" screen), so no case file — and no
 * draft — ever lands unencrypted.
 *
 * Settings/Visible only; never reachable from the Hidden facade.
 */

type Step =
  | 'resume'
  | 'intro'
  | 'incident'
  | 'when'
  | 'where'
  | 'relationship'
  | 'flags'
  | 'injury'
  | 'reported'
  | 'prior'
  | 'narrative'
  | 'review'
  | 'filing'
  | 'done'
  | 'blocked';

const STRUCTURED_ORDER: Step[] = ['incident', 'when', 'where', 'relationship', 'flags', 'injury', 'reported', 'prior', 'narrative', 'review'];

interface Answers {
  incidentTypeId: string | null;
  whenRange: string | null;
  regionId: string | null;
  relationshipId: string | null;
  weaponCoercionFlags: string[];
  injuryId: string | null;
  reportedToAuthorities: 'yes' | 'no' | 'prefer_not_to_say' | null;
  priorIncidents: 'yes' | 'no' | 'prefer_not_to_say' | null;
  narrative: string;
}

const EMPTY: Answers = {
  incidentTypeId: null,
  whenRange: null,
  regionId: null,
  relationshipId: null,
  weaponCoercionFlags: [],
  injuryId: null,
  reportedToAuthorities: null,
  priorIncidents: null,
  narrative: '',
};

function nowMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function GuidedIntake({ onClose }: { onClose: () => void }): JSX.Element {
  const [step, setStep] = useState<Step>('intro');
  const [a, setA] = useState<Answers>(EMPTY);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On open, offer to resume a sealed draft if one exists (armed only).
  useEffect(() => {
    void loadDraft().then((d) => {
      if (d && Object.keys(d).length > 1) {
        setStep('resume');
      }
    });
  }, []);

  // Persist a sealed draft when the step changes (never plaintext; a no-op while off).
  useEffect(() => {
    if (step === 'intro' || step === 'resume' || step === 'done') return;
    const draft: IntakeDraft = { ...a, step };
    void saveDraft(draft);
  }, [step, a]);

  const set = <K extends keyof Answers>(k: K, v: Answers[K]): void => setA((prev) => ({ ...prev, [k]: v }));

  function next(from: Step): void {
    const i = STRUCTURED_ORDER.indexOf(from);
    setStep(i >= 0 && i < STRUCTURED_ORDER.length - 1 ? STRUCTURED_ORDER[i + 1]! : 'review');
  }
  // Answering advances — but only on an explicit tap; nothing advances on silence.
  function answer<K extends keyof Answers>(k: K, v: Answers[K], from: Step): void {
    set(k, v);
    next(from);
  }

  async function pauseAndClose(): Promise<void> {
    await saveDraft({ ...a, step }); // sealed if armed; in-memory only otherwise
    onClose();
  }
  async function stopAndDiscard(): Promise<void> {
    await clearDraft();
    onClose();
  }

  async function file(): Promise<void> {
    setError(null);
    setStep('filing');
    const record = buildCaseFileRecord({
      incidentTypeId: a.incidentTypeId,
      whenRange: a.whenRange,
      location: a.regionId ? { granularity: 'region', regionId: a.regionId } : { granularity: 'none' },
      relationshipId: a.relationshipId,
      weaponCoercionFlags: a.weaponCoercionFlags,
      injuryId: a.injuryId,
      reportedToAuthorities: a.reportedToAuthorities,
      priorIncidents: a.priorIncidents,
      narrative: a.narrative,
      classificationDraft: null,
      submissionMonth: nowMonth(),
    });
    // FAIL-CLOSED: seal or nothing. No plaintext case file, ever.
    const sealed = await sealCaseFile(record);
    if (!sealed.ok) {
      setStep('blocked');
      return;
    }
    const res = await api<{ id?: string; error?: string }>('/v1/me/case-files', {
      body: { sealedCaseFile: sealed.sealed, taxonomyVersion: sealed.taxonomyVersion },
    });
    if (res.ok && res.data?.id) {
      await clearDraft();
      setStep('done');
    } else if (res.status === 409) {
      setStep('blocked'); // server's fail-closed gate
    } else {
      setError('Could not file your report. Please try again.');
      setStep('review');
    }
  }

  const incidentLabel = incidentTypeById(a.incidentTypeId)?.label;
  const whenLabel = WHEN_RANGES.find((w) => w.id === a.whenRange)?.label;
  const relLabel = RELATIONSHIPS.find((r) => r.id === a.relationshipId)?.label;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#071416]/97 text-med-text backdrop-blur-sm">
      {/* Pause / Stop — reachable at EVERY step (trauma-informed §2). */}
      {step !== 'intro' && step !== 'done' && step !== 'resume' ? (
        <div className="flex shrink-0 items-center justify-between border-b border-med-text/15 px-6 pb-3 pt-safe-4">
          <button onClick={() => void pauseAndClose()} className="text-sm text-med-text/70 underline">
            Pause &amp; save
          </button>
          <button onClick={() => void stopAndDiscard()} className="text-sm text-med-text/50 underline">
            Stop
          </button>
        </div>
      ) : null}

      <div className="mx-auto flex w-full max-w-md flex-1 flex-col overflow-y-auto px-6 pb-10 pt-safe-6">
        {step === 'resume' ? (
          <Center>
            <h2 className="mb-3 font-serif text-2xl font-light">Continue where you left off?</h2>
            <p className="mb-8 text-[13px] leading-relaxed text-med-text/60">
              Your unfinished report was saved, encrypted, on this device. Only you can open it.
            </p>
            <Primary onClick={() => void loadDraft().then((d) => { if (d) { setA({ ...EMPTY, ...(d as Answers) }); } setStep((d?.step as Step) ?? 'incident'); })}>
              Continue my report
            </Primary>
            <Secondary onClick={() => { void clearDraft(); setA(EMPTY); setStep('intro'); }}>Start over</Secondary>
          </Center>
        ) : null}

        {step === 'intro' ? (
          <Center>
            <h2 className="mb-3 font-serif text-2xl font-light tracking-[0.03em]">Make a report</h2>
            <p className="mb-4 text-[13px] leading-relaxed text-med-text/70">
              This is a private, guided space to record what happened, in your own words and at your own pace.
              There are no right answers, nothing is graded, and you can skip any question.
            </p>
            <p className="mb-8 text-[13px] leading-relaxed text-med-text/60">
              You can <span className="text-med-text">pause and save</span> at any point and come back — your
              report is encrypted so only you can open it. Nothing is filed until you review it and choose to.
            </p>
            <Primary onClick={() => setStep('incident')}>Begin</Primary>
            <Secondary onClick={onClose}>Not now</Secondary>
          </Center>
        ) : null}

        {step === 'incident' ? (
          <Choice
            title="What kind of thing happened?"
            hint="Choose the closest — you can add detail in your own words later."
            options={INCIDENT_TYPES.map((t) => ({ v: t.id, label: t.label }))}
            onPick={(v) => answer('incidentTypeId', v, 'incident')}
            onSkip={() => answer('incidentTypeId', null, 'incident')}
          />
        ) : null}

        {step === 'when' ? (
          <Choice
            title="Roughly when?"
            hint="A rough range is fine — an exact date isn't needed."
            options={WHEN_RANGES.map((w) => ({ v: w.id, label: w.label }))}
            onPick={(v) => answer('whenRange', v, 'when')}
            onSkip={() => answer('whenRange', null, 'when')}
          />
        ) : null}

        {step === 'where' ? (
          <Choice
            title="Roughly where?"
            hint="Only as specific as you want — region is enough, or skip it."
            options={REGIONS.map((r) => ({ v: r.id, label: r.label }))}
            onPick={(v) => answer('regionId', v, 'where')}
            onSkip={() => answer('regionId', null, 'where')}
          />
        ) : null}

        {step === 'relationship' ? (
          <Choice
            title="Your relationship to the person who did it?"
            options={RELATIONSHIPS.map((r) => ({ v: r.id, label: r.label }))}
            onPick={(v) => answer('relationshipId', v, 'relationship')}
            onSkip={() => answer('relationshipId', null, 'relationship')}
          />
        ) : null}

        {step === 'flags' ? (
          <MultiChoice
            title="Was any of this part of it?"
            hint="Choose any that apply, or none."
            options={WEAPON_COERCION_FLAGS.map((f) => ({ v: f.id, label: f.label }))}
            selected={a.weaponCoercionFlags}
            onToggle={(v) => set('weaponCoercionFlags', a.weaponCoercionFlags.includes(v) ? a.weaponCoercionFlags.filter((x) => x !== v) : [...a.weaponCoercionFlags, v])}
            onContinue={() => setStep('injury')}
          />
        ) : null}

        {step === 'injury' ? (
          <Choice
            title="Were you hurt?"
            options={INJURY_OPTIONS.map((o) => ({ v: o.id, label: o.label }))}
            onPick={(v) => answer('injuryId', v, 'injury')}
            onSkip={() => answer('injuryId', null, 'injury')}
          />
        ) : null}

        {step === 'reported' ? (
          <Choice
            title="Was it reported to anyone official?"
            options={[{ v: 'yes', label: 'Yes' }, { v: 'no', label: 'No' }, { v: 'prefer_not_to_say', label: 'Prefer not to say' }]}
            onPick={(v) => answer('reportedToAuthorities', v as Answers['reportedToAuthorities'], 'reported')}
            onSkip={() => answer('reportedToAuthorities', null, 'reported')}
          />
        ) : null}

        {step === 'prior' ? (
          <Choice
            title="Has something like this happened before?"
            options={[{ v: 'yes', label: 'Yes' }, { v: 'no', label: 'No' }, { v: 'prefer_not_to_say', label: 'Prefer not to say' }]}
            onPick={(v) => answer('priorIncidents', v as Answers['priorIncidents'], 'prior')}
            onSkip={() => answer('priorIncidents', null, 'prior')}
          />
        ) : null}

        {step === 'narrative' ? (
          <div className="flex flex-1 flex-col">
            <h2 className="mb-2 font-serif text-2xl font-light">In your own words</h2>
            <p className="mb-1 text-[13px] leading-relaxed text-med-text/70">
              Whatever you remember, in any order. You don't have to be chronological.
            </p>
            <p className="mb-5 text-[12px] leading-relaxed text-med-text/50">
              What do you remember feeling? What did you hear, see, or sense? Only what you want to write.
            </p>
            <textarea
              value={a.narrative}
              onChange={(e) => set('narrative', e.target.value)}
              rows={8}
              placeholder="Take your time…"
              className="w-full flex-1 rounded-lg border border-med-text/25 bg-black/20 p-4 text-med-text outline-none placeholder:text-med-text/30 focus:border-med-text/50"
            />
            <div className="mt-5 space-y-3">
              <Primary onClick={() => setStep('review')}>Review my report</Primary>
              <Secondary onClick={() => setStep('review')}>Skip — I'd rather not write</Secondary>
            </div>
          </div>
        ) : null}

        {step === 'review' ? (
          <div className="flex flex-1 flex-col">
            <h2 className="mb-2 font-serif text-2xl font-light">Review before you file</h2>
            <p className="mb-5 text-[13px] leading-relaxed text-med-text/60">
              This is exactly what will be filed, encrypted, under your own key. Nothing here has been changed,
              scored, or interpreted — these are your answers. Edit anything by going back.
            </p>
            <div className="mb-4 space-y-1 rounded-lg border border-med-text/20 bg-black/20 p-4">
              <ReviewRow k="What happened" v={incidentLabel} onEdit={() => setStep('incident')} />
              <ReviewRow k="When" v={whenLabel} onEdit={() => setStep('when')} />
              <ReviewRow k="Where" v={REGIONS.find((r) => r.id === a.regionId)?.label} onEdit={() => setStep('where')} />
              <ReviewRow k="Relationship" v={relLabel} onEdit={() => setStep('relationship')} />
              <ReviewRow k="Injury" v={INJURY_OPTIONS.find((o) => o.id === a.injuryId)?.label} onEdit={() => setStep('injury')} />
              <ReviewRow k="Reported" v={a.reportedToAuthorities ?? undefined} onEdit={() => setStep('reported')} />
              <ReviewRow k="Happened before" v={a.priorIncidents ?? undefined} onEdit={() => setStep('prior')} />
            </div>
            {/* Labeled DRAFT summary — deterministic, from your answers, never the record of authority. */}
            <div className="mb-4 rounded-lg border border-dashed border-med-text/25 p-4">
              <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-med-text/45">Draft summary — you can edit</p>
              <p className="text-[13px] leading-relaxed text-med-text/75">
                {draftSummary(buildCaseFileRecord({ incidentTypeId: a.incidentTypeId, whenRange: a.whenRange, location: { granularity: 'none' }, relationshipId: a.relationshipId, weaponCoercionFlags: a.weaponCoercionFlags, injuryId: a.injuryId, reportedToAuthorities: a.reportedToAuthorities, priorIncidents: a.priorIncidents, narrative: a.narrative, classificationDraft: null, submissionMonth: nowMonth() }), { incidentType: incidentLabel, whenRange: whenLabel, relationship: relLabel })}
              </p>
            </div>
            {a.narrative ? (
              <div className="mb-4 rounded-lg border border-med-text/15 p-4">
                <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-med-text/45">Your words</p>
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-med-text/80">{a.narrative}</p>
                <button onClick={() => setStep('narrative')} className="mt-2 text-[12px] text-med-text/50 underline">Edit</button>
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => setReviewed(!reviewed)}
              className={`mb-4 flex w-full items-start gap-3 rounded-lg border p-3 text-left text-[12px] leading-relaxed transition-colors ${reviewed ? 'border-med-text/60 text-med-text' : 'border-med-text/25 text-med-text/60'}`}
            >
              <span aria-hidden className="font-mono">{reviewed ? '✓' : '○'}</span>
              I've read this and it's how I want it filed.
            </button>
            {error ? <p className="mb-3 text-sm text-med-warn">{error}</p> : null}
            {/* Filing cannot complete until reviewed (§3). */}
            <Primary disabled={!reviewed} onClick={() => void file()}>
              {reviewed ? 'File my report securely' : 'Review to continue'}
            </Primary>
            <Secondary onClick={() => void pauseAndClose()}>Pause &amp; finish later</Secondary>
          </div>
        ) : null}

        {step === 'filing' ? <Center><p className="text-med-text/60">Sealing and filing…</p></Center> : null}

        {step === 'done' ? (
          <Center>
            <h2 className="mb-2 font-serif text-2xl font-light">Filed securely</h2>
            <p className="mb-8 max-w-xs text-[13px] leading-relaxed text-med-text/60">
              Your report is stored encrypted under your own key. Only you can open it, and you can export it to
              legal aid or counsel whenever you choose.
            </p>
            <Primary onClick={onClose}>Done</Primary>
          </Center>
        ) : null}

        {step === 'blocked' ? (
          <Center>
            <h2 className="mb-2 font-serif text-2xl font-light">Secure storage isn't ready yet</h2>
            <p className="mb-8 max-w-xs text-[13px] leading-relaxed text-med-text/60">
              A report can only be filed once encrypted storage is enabled on your account — so it can never be
              stored where anyone but you could read it. Nothing you entered was saved anywhere unencrypted.
            </p>
            <Primary onClick={onClose}>Close</Primary>
          </Center>
        ) : null}
      </div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="flex flex-1 flex-col items-center justify-center text-center">{children}</div>;
}
function Primary({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return <button {...p} className="w-full rounded-full bg-med-text/90 py-4 font-sans text-base font-medium text-[#071416] disabled:opacity-40">{children}</button>;
}
function Secondary({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return <button {...p} className="mt-3 block w-full text-center text-sm text-med-text/50 underline">{children}</button>;
}

function Choice({ title, hint, options, onPick, onSkip }: {
  title: string; hint?: string; options: Array<{ v: string; label: string }>; onPick: (v: string) => void; onSkip: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-1 flex-col">
      <h2 className="mb-2 font-serif text-2xl font-light tracking-[0.02em]">{title}</h2>
      {hint ? <p className="mb-6 text-[13px] leading-relaxed text-med-text/55">{hint}</p> : <div className="mb-6" />}
      <div className="space-y-2.5">
        {options.map((o) => (
          <button key={o.v} onClick={() => onPick(o.v)} className="w-full rounded-lg border border-med-text/25 py-3.5 text-center text-med-text transition-colors hover:border-med-text/60 hover:bg-med-text/5">
            {o.label}
          </button>
        ))}
      </div>
      <button onClick={onSkip} className="mt-6 block w-full text-center text-sm text-med-text/45 underline">Skip this question</button>
    </div>
  );
}

function MultiChoice({ title, hint, options, selected, onToggle, onContinue }: {
  title: string; hint?: string; options: Array<{ v: string; label: string }>; selected: string[]; onToggle: (v: string) => void; onContinue: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-1 flex-col">
      <h2 className="mb-2 font-serif text-2xl font-light">{title}</h2>
      {hint ? <p className="mb-6 text-[13px] leading-relaxed text-med-text/55">{hint}</p> : <div className="mb-6" />}
      <div className="space-y-2.5">
        {options.map((o) => (
          <button key={o.v} onClick={() => onToggle(o.v)} className={`flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${selected.includes(o.v) ? 'border-med-text/70 bg-med-text/10 text-med-text' : 'border-med-text/25 text-med-text/70'}`}>
            <span aria-hidden className="font-mono text-xs">{selected.includes(o.v) ? '✓' : '○'}</span>
            {o.label}
          </button>
        ))}
      </div>
      <Primary onClick={onContinue}>Continue</Primary>
    </div>
  );
}

function ReviewRow({ k, v, onEdit }: { k: string; v?: string; onEdit: () => void }): JSX.Element {
  return (
    <div className="flex items-center justify-between border-b border-med-text/10 py-1.5 last:border-0">
      <span className="text-[12px] text-med-text/55">{k}</span>
      <span className="flex items-center gap-2">
        <span className="text-[12px] text-med-text">{v ?? 'Skipped'}</span>
        <button onClick={onEdit} className="text-[11px] text-med-text/40 underline">edit</button>
      </span>
    </div>
  );
}
