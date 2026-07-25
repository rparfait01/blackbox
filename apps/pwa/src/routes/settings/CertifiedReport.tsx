import { useEffect, useState } from 'react';

import { envelopeEncryptionEnabled } from '@/lib/env';
import {
  buildReportFile,
  generateCertifiedEvidence,
  listReportableEvents,
  type PopulateOptions,
  type ReportEventSummary,
} from '@/lib/report/generate';
import { renderEvidenceText, type EvidenceZone, type SignedAttestation } from '@blackbox/shared';

/**
 * Certified report (Brief 29) — the survivor generates her own evidence record, on her own
 * device, from her own decrypted capture, on her command.
 *
 * THE SHAPE OF THE FLOW IS THE ETHIC:
 *   - Nothing happens until she taps (§1.1). Auto-population is offered AFTER that tap and
 *     is opt-in per report, per section — never pre-filled, never blanket (§1 [A]).
 *   - The evidence zone is decrypted and assembled HERE, on the device. Only two hashes go
 *     to the server for signature; the content never leaves to be signed (§1.3, §2).
 *   - Her statement comes last, in her own words, at her pace — and is deliberately NOT
 *     signed, so she can revise her account without invalidating the certification (§0).
 *   - The custody caution is shown BEFORE the file is produced (§4). It informs; it never
 *     discourages. A downloadable report is her having power over her own evidence.
 *
 * Settings/Visible only — never reachable from the Hidden facade (§0a). Gated on
 * zero-knowledge custody: with the flag off there is no report path at all (§5).
 */

type Step = 'intro' | 'pick' | 'populate' | 'building' | 'statement' | 'caution' | 'done' | 'blocked';

/** Experiential prompts (Brief 27 §3 FETI): they invite an account, they never interrogate
 *  a chronology, and none of them is required. */
const STATEMENT_PROMPTS = [
  'What do you want someone reading this to understand?',
  'What stands out most to you when you think about it?',
  'What was happening for you at the time?',
  'Is there anything the record above does not capture?',
];

const FAILURE_COPY: Record<string, string> = {
  disabled: 'Secure storage is not enabled yet, so a certified report cannot be generated.',
  no_key: 'This device does not hold your encryption key, so your recording cannot be opened here.',
  no_event: 'That record could not be found.',
  no_commitments:
    'This recording has no capture-time record to certify against, so it cannot be certified. You can still write and keep your own statement.',
  not_certified: 'The certification step did not complete. Nothing was generated.',
  network: 'No connection. Nothing was generated.',
};

export function CertifiedReport({ onClose }: { onClose: () => void }): JSX.Element {
  const [step, setStep] = useState<Step>(envelopeEncryptionEnabled ? 'intro' : 'blocked');
  const [events, setEvents] = useState<ReportEventSummary[] | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  // Every opt-in defaults OFF — nothing is populated until she asks for it (§1 [A]).
  const [options, setOptions] = useState<PopulateOptions>({
    includeLocation: false,
    includeNotifications: false,
    includeCapture: false,
  });
  const [evidence, setEvidence] = useState<EvidenceZone | null>(null);
  const [signed, setSigned] = useState<SignedAttestation | null>(null);
  const [statement, setStatement] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (step !== 'pick' || events !== null) return;
    void listReportableEvents().then((list) => setEvents(list ?? []));
  }, [step, events]);

  async function build(): Promise<void> {
    if (!eventId) return;
    setError(null);
    setStep('building');
    const result = await generateCertifiedEvidence(eventId, options, Date.now());
    if (!result.ok) {
      setError(FAILURE_COPY[result.reason] ?? 'Nothing was generated.');
      setStep('populate');
      return;
    }
    setEvidence(result.evidence);
    setSigned(result.signed);
    setStep('statement');
  }

  /** Produce the file. Reached only THROUGH the custody caution — never around it (§4). */
  function download(): void {
    if (!evidence || !signed) return;
    const html = buildReportFile(evidence, signed, statement);
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `blackbox-certified-report-${signed.attestation.eventId}.html`;
    a.click();
    URL.revokeObjectURL(url);
    setStep('done');
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#071416]/97 text-med-text backdrop-blur-sm">
      {step !== 'intro' && step !== 'done' && step !== 'blocked' ? (
        <div className="flex shrink-0 items-center justify-between border-b border-med-text/15 px-6 pb-3 pt-safe-4">
          <button onClick={onClose} className="text-sm text-med-text/70 underline">
            Close
          </button>
          <span className="text-[11px] uppercase tracking-[0.18em] text-med-text/40">Certified report</span>
        </div>
      ) : null}

      <div className="mx-auto flex w-full max-w-md flex-1 flex-col overflow-y-auto px-6 pb-10 pt-safe-6">
        {step === 'blocked' ? (
          <Center>
            <h2 className="mb-3 font-serif text-2xl font-light">Not available yet</h2>
            <p className="mb-8 text-[13px] leading-relaxed text-med-text/60">
              Certified reports need secure storage to be switched on for your account. Nothing was generated.
            </p>
            <Secondary onClick={onClose}>Close</Secondary>
          </Center>
        ) : null}

        {step === 'intro' ? (
          <Center>
            <h2 className="mb-3 font-serif text-2xl font-light tracking-[0.03em]">Start a report</h2>
            <p className="mb-4 text-[13px] leading-relaxed text-med-text/70">
              A report you generate yourself, on this device, from your own recording. It carries a signature
              anyone can check — a court, an advocate, a police intake officer — without taking BLACK BOX&rsquo;s
              word for anything.
            </p>
            <p className="mb-8 text-[13px] leading-relaxed text-med-text/60">
              Your own words go in a separate section that stays yours: it is not signed, not judged, and you can
              change it whenever you like.
            </p>
            <Primary onClick={() => setStep('pick')}>Start a report</Primary>
            <Secondary onClick={onClose}>Not now</Secondary>
          </Center>
        ) : null}

        {step === 'pick' ? (
          <div className="flex flex-1 flex-col">
            <h2 className="mb-2 font-serif text-2xl font-light">Which record?</h2>
            <p className="mb-6 text-[13px] leading-relaxed text-med-text/55">Choose the one you want to report on.</p>
            {events === null ? <p className="text-[13px] text-med-text/50">Loading&hellip;</p> : null}
            {events !== null && events.length === 0 ? (
              <p className="text-[13px] leading-relaxed text-med-text/55">
                There are no records on your account to report on yet.
              </p>
            ) : null}
            <div className="space-y-2.5">
              {(events ?? []).map((e) => (
                <button
                  key={e.eventId}
                  onClick={() => {
                    setEventId(e.eventId);
                    setStep('populate');
                  }}
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
            <Secondary onClick={onClose}>Cancel</Secondary>
          </div>
        ) : null}

        {step === 'populate' ? (
          <div className="flex flex-1 flex-col">
            <h2 className="mb-2 font-serif text-2xl font-light">What should it include?</h2>
            <p className="mb-6 text-[13px] leading-relaxed text-med-text/55">
              Nothing is added unless you choose it. Everything you include is a factual record — no summary, no
              interpretation, nothing written about you by a machine.
            </p>
            <div className="space-y-2.5">
              <Toggle
                on={options.includeCapture}
                label="My recording"
                hint="Opened on this device with your key, and checked against what was recorded at the time."
                onToggle={() => setOptions((o) => ({ ...o, includeCapture: !o.includeCapture }))}
              />
              <Toggle
                on={options.includeLocation}
                label="Location"
                hint="Where the device was, as recorded."
                onToggle={() => setOptions((o) => ({ ...o, includeLocation: !o.includeLocation }))}
              />
              <Toggle
                on={options.includeNotifications}
                label="Who was notified"
                hint="What was sent, when, and whether it arrived."
                onToggle={() => setOptions((o) => ({ ...o, includeNotifications: !o.includeNotifications }))}
              />
            </div>
            {error ? <p className="mt-6 text-[13px] leading-relaxed text-med-warn/80">{error}</p> : null}
            <div className="mt-8">
              <Primary onClick={() => void build()}>Build my report</Primary>
              <Secondary onClick={() => setStep('pick')}>Back</Secondary>
            </div>
          </div>
        ) : null}

        {step === 'building' ? (
          <Center>
            <h2 className="mb-3 font-serif text-2xl font-light">Building your report</h2>
            <p className="text-[13px] leading-relaxed text-med-text/60">
              Opening your recording on this device and checking it against what was recorded at the time. This
              happens here, on your phone — not on a server.
            </p>
          </Center>
        ) : null}

        {step === 'statement' && evidence ? (
          <div className="flex flex-1 flex-col">
            <h2 className="mb-2 font-serif text-2xl font-light">Your own words</h2>
            <p className="mb-4 text-[13px] leading-relaxed text-med-text/55">
              This part is yours. It is not signed, not checked, and not judged — and you can leave it empty or
              change it later without affecting the certified section.
            </p>
            <ul className="mb-4 space-y-1.5">
              {STATEMENT_PROMPTS.map((p) => (
                <li key={p} className="text-[12px] leading-relaxed text-med-text/45">
                  · {p}
                </li>
              ))}
            </ul>
            <textarea
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
              rows={9}
              placeholder="Write as much or as little as you want."
              className="w-full rounded-lg border border-med-text/25 bg-transparent p-3 text-[14px] leading-relaxed text-med-text placeholder:text-med-text/30"
            />
            <details className="mt-5 text-[12px] text-med-text/50">
              <summary className="cursor-pointer">See the certified section</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-black/25 p-3 font-mono text-[10px] leading-relaxed">
                {renderEvidenceText(evidence)}
              </pre>
            </details>
            <div className="mt-8">
              <Primary onClick={() => setStep('caution')}>Continue</Primary>
              <Secondary onClick={onClose}>Close without downloading</Secondary>
            </div>
          </div>
        ) : null}

        {/* §4 — shown BEFORE the file is produced. Informs; never discourages. */}
        {step === 'caution' ? (
          <Center>
            <h2 className="mb-4 font-serif text-2xl font-light">Before you download</h2>
            <p className="mb-4 text-[14px] leading-relaxed text-med-text">
              Once you download this report, we can no longer protect its privacy.
            </p>
            <p className="mb-4 text-[13px] leading-relaxed text-med-text/70">
              On your device or sent to someone, it becomes a file you control — it can be seen by anyone with
              access to it, and it is no longer under BLACK BOX&rsquo;s sealed custody.
            </p>
            <p className="mb-8 text-[13px] leading-relaxed text-med-text/70">
              Its authenticity stays verifiable. Its privacy is now yours to manage.
            </p>
            <Primary onClick={download}>Download my report</Primary>
            <Secondary onClick={() => setStep('statement')}>Back</Secondary>
          </Center>
        ) : null}

        {step === 'done' ? (
          <Center>
            <h2 className="mb-3 font-serif text-2xl font-light">Your report is saved</h2>
            <p className="mb-4 text-[13px] leading-relaxed text-med-text/70">
              Anyone can check it at{' '}
              <span className="text-med-text">blackboxsentinel.com/verification</span> — or with the published key,
              using their own tools. They do not need an account, and they do not need to contact us.
            </p>
            <p className="mb-8 text-[13px] leading-relaxed text-med-text/55">
              Editing your own words never breaks the certification. Changing the certified section does — that is
              what makes it worth something.
            </p>
            <Primary onClick={onClose}>Done</Primary>
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
  return (
    <button
      {...p}
      className="w-full rounded-full bg-med-text/90 py-4 font-sans text-base font-medium text-[#071416] disabled:opacity-40"
    >
      {children}
    </button>
  );
}
function Secondary({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return <button {...p} className="mt-3 block w-full text-center text-sm text-med-text/50 underline">{children}</button>;
}

function Toggle({
  on,
  label,
  hint,
  onToggle,
}: {
  on: boolean;
  label: string;
  hint: string;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onToggle}
      className={`w-full rounded-lg border px-4 py-3.5 text-left transition-colors ${
        on ? 'border-med-text/60 bg-med-text/10' : 'border-med-text/25'
      }`}
    >
      <span className="block text-med-text">
        {on ? '✓ ' : ''}
        {label}
      </span>
      <span className="block text-[12px] leading-relaxed text-med-text/45">{hint}</span>
    </button>
  );
}
