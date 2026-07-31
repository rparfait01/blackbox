import { useState } from 'react';

import { api } from '@/lib/api';
import { REGIONS } from '@/lib/regions';

/**
 * Anonymous Incident Tally (Brief 25). A four-tap, under-a-minute acknowledgment that
 * an incident occurred — NOT a report of what happened. It records only THAT something
 * happened and whether it was ever officially reported; nothing about the person.
 *
 * This is severed from identity server-side: the session authenticates the send (for a
 * per-account rate limit only) and is never written to the record. There is no free-text
 * field anywhere in this flow — every answer is a closed choice, and every question is
 * skippable. Consent is per-submission (§5): the survivor sees the literal payload and
 * is told plainly it cannot be withdrawn, before anything is sent.
 *
 * Rendered only from Settings (Visible), which is itself unreachable during an active
 * alert — so this calm, deliberate act can never be surfaced under duress (§7).
 */

type Answer = string | null;
interface Draft {
  kind: Answer;
  roughlyWhen: Answer;
  regionId: Answer;
  reportedOfficial: Answer;
}

const KIND_OPTS: Array<{ v: string; label: string }> = [
  { v: 'sexual_assault', label: 'Sexual assault' },
  { v: 'sexual_harassment', label: 'Sexual harassment' },
  { v: 'domestic_violence', label: 'Domestic violence' },
  { v: 'other', label: 'Other' },
  { v: 'prefer_not_to_say', label: 'Prefer not to say' },
];
const WHEN_OPTS: Array<{ v: string; label: string }> = [
  { v: 'this_month', label: 'This month' },
  { v: 'past_3_months', label: 'Past 3 months' },
  { v: 'past_year', label: 'Past year' },
  { v: 'longer_ago', label: 'Longer ago' },
  { v: 'prefer_not_to_say', label: 'Prefer not to say' },
];
const REPORTED_OPTS: Array<{ v: string; label: string }> = [
  { v: 'yes', label: 'Yes' },
  { v: 'no', label: 'No' },
  { v: 'prefer_not_to_say', label: 'Prefer not to say' },
];

// Human labels for the literal-payload consent view — never send anything the survivor
// hasn't seen spelled out.
const LABELS: Record<string, string> = {
  ...Object.fromEntries(KIND_OPTS.map((o) => [o.v, o.label])),
  ...Object.fromEntries(WHEN_OPTS.map((o) => [o.v, o.label])),
  yes: 'Yes',
  no: 'No',
  prefer_not_to_say: 'Prefer not to say',
};
const labelFor = (v: Answer, region = false): string => {
  if (v == null) return 'Skipped';
  if (region) return REGIONS.find((r) => r.id === v)?.label ?? v;
  return LABELS[v] ?? v;
};

type Step = 'kind' | 'when' | 'where' | 'reported' | 'consent' | 'sending' | 'done' | 'limited';
const QUESTION_ORDER: Step[] = ['kind', 'when', 'where', 'reported'];

export function AnonymousTally({ onClose }: { onClose: () => void }): JSX.Element {
  const [step, setStep] = useState<Step>('kind');
  const [draft, setDraft] = useState<Draft>({ kind: null, roughlyWhen: null, regionId: null, reportedOfficial: null });
  const [limit, setLimit] = useState<{ used: number; limit: number } | null>(null);

  const next = (from: Step): void => {
    const i = QUESTION_ORDER.indexOf(from);
    setStep(i >= 0 && i < QUESTION_ORDER.length - 1 ? QUESTION_ORDER[i + 1]! : 'consent');
  };

  // Answering a question IS the tap that advances — four taps to the consent screen.
  const answer = (field: keyof Draft, value: Answer, from: Step): void => {
    setDraft((d) => ({ ...d, [field]: value }));
    next(from);
  };

  async function submit(): Promise<void> {
    setStep('sending');
    const res = await api<{ error?: string; used?: number; limit?: number }>('/v1/me/tally', {
      body: {
        kind: draft.kind,
        roughlyWhen: draft.roughlyWhen,
        regionId: draft.regionId,
        reportedOfficial: draft.reportedOfficial,
      },
    });
    if (res.ok) {
      setStep('done');
      return;
    }
    // Honest status (§4): never pretend it counted. A rate limit is stated plainly.
    if (res.status === 429) {
      setLimit({ used: res.data?.used ?? 0, limit: res.data?.limit ?? 0 });
      setStep('limited');
      return;
    }
    setLimit({ used: 0, limit: 0 });
    setStep('limited');
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#071416]/95 px-6 pb-8 pt-safe-6 text-med-text backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col">
        {/* Cancel is available at every step (§5). */}
        <div className="mb-6 flex justify-end">
          <button onClick={onClose} className="text-sm text-med-text/50 underline">
            Cancel
          </button>
        </div>

        {step === 'kind' ? (
          <Question
            title="What kind?"
            hint="This helps count where reporting gaps are. You can skip any question."
            opts={KIND_OPTS}
            onPick={(v) => answer('kind', v, 'kind')}
            onSkip={() => answer('kind', null, 'kind')}
          />
        ) : null}

        {step === 'when' ? (
          <Question
            title="Roughly when?"
            opts={WHEN_OPTS}
            onPick={(v) => answer('roughlyWhen', v, 'when')}
            onSkip={() => answer('roughlyWhen', null, 'when')}
          />
        ) : null}

        {step === 'where' ? (
          <Question
            title="Roughly where?"
            hint="Region only — never anything finer."
            opts={REGIONS.map((r) => ({ v: r.id, label: r.label }))}
            onPick={(v) => answer('regionId', v, 'where')}
            onSkip={() => answer('regionId', null, 'where')}
          />
        ) : null}

        {step === 'reported' ? (
          <Question
            title="Was it reported to anyone official?"
            hint="This is the whole point: it measures what never gets reported."
            opts={REPORTED_OPTS}
            onPick={(v) => answer('reportedOfficial', v, 'reported')}
            onSkip={() => answer('reportedOfficial', null, 'reported')}
          />
        ) : null}

        {step === 'consent' ? (
          <div className="flex flex-1 flex-col">
            <h2 className="mb-3 font-serif text-2xl font-light tracking-[0.04em]">This is anonymous.</h2>
            <p className="mb-4 text-[13px] leading-relaxed text-med-text/70">
              It records only that something happened — not what happened, and nothing about you. Because it
              can’t be traced to you, it also <span className="text-med-text">can’t be taken back.</span> It may
              be published as part of public statistics on unreported violence.
            </p>

            {/* The literal payload — exactly the four values that will be sent (§5). */}
            <div className="mb-5 rounded-lg border border-med-text/20 bg-black/25 p-4">
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-med-text/45">
                Exactly what will be sent
              </p>
              <PayloadRow k="What kind" v={labelFor(draft.kind)} />
              <PayloadRow k="Roughly when" v={labelFor(draft.roughlyWhen)} />
              <PayloadRow k="Roughly where" v={labelFor(draft.regionId, true)} />
              <PayloadRow k="Reported to anyone official?" v={labelFor(draft.reportedOfficial)} />
              <p className="mt-2 font-mono text-[10px] text-med-text/35">Nothing else. No identity, no free text.</p>
            </div>

            <div className="mt-auto space-y-3">
              <button
                onClick={() => void submit()}
                className="w-full rounded-full bg-med-text/90 py-4 font-sans text-base font-medium text-[#071416]"
              >
                Submit anonymously
              </button>
              <button onClick={onClose} className="block w-full text-center text-sm text-med-text/50 underline">
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {step === 'sending' ? <p className="mt-8 text-med-text/60">Sending…</p> : null}

        {step === 'done' ? (
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <h2 className="mb-2 font-serif text-2xl font-light tracking-[0.04em]">Counted.</h2>
            <p className="mb-8 max-w-xs text-[13px] leading-relaxed text-med-text/60">
              It happened, and now it’s part of the count of what usually goes unrecorded. Thank you.
            </p>
            <button onClick={onClose} className="rounded-full border border-med-text/40 px-6 py-3 text-sm text-med-text">
              Done
            </button>
          </div>
        ) : null}

        {step === 'limited' ? (
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <h2 className="mb-2 font-serif text-2xl font-light tracking-[0.04em]">Not counted</h2>
            <p className="mb-8 max-w-xs text-[13px] leading-relaxed text-med-text/60">
              {limit && limit.limit > 0
                ? `You’ve reached this month’s limit (${limit.limit}). Nothing was discarded silently — this one was not counted. You can add another next month.`
                : 'Something went wrong and this was not counted. Please try again.'}
            </p>
            <button onClick={onClose} className="rounded-full border border-med-text/40 px-6 py-3 text-sm text-med-text">
              Close
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Question({
  title,
  hint,
  opts,
  onPick,
  onSkip,
}: {
  title: string;
  hint?: string;
  opts: Array<{ v: string; label: string }>;
  onPick: (v: string) => void;
  onSkip: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-1 flex-col">
      <h2 className="mb-2 font-serif text-2xl font-light tracking-[0.04em]">{title}</h2>
      {hint ? <p className="mb-6 text-[13px] leading-relaxed text-med-text/55">{hint}</p> : <div className="mb-6" />}
      <div className="space-y-2.5">
        {opts.map((o) => (
          <button
            key={o.v}
            onClick={() => onPick(o.v)}
            className="w-full rounded-lg border border-med-text/25 py-3.5 text-center text-med-text transition-colors hover:border-med-text/60 hover:bg-med-text/5"
          >
            {o.label}
          </button>
        ))}
      </div>
      <button onClick={onSkip} className="mt-6 block w-full text-center text-sm text-med-text/45 underline">
        Skip this question
      </button>
    </div>
  );
}

function PayloadRow({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="flex justify-between border-b border-med-text/10 py-1.5 last:border-0">
      <span className="text-[12px] text-med-text/55">{k}</span>
      <span className="text-[12px] text-med-text">{v}</span>
    </div>
  );
}
