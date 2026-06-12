import { useState } from 'react';

/**
 * Support-contact setup (Fix Brief 3 contact screen). The user names their
 * guardian, picks the preferred channel — Text (SMS) / LINE / Email — and enters
 * the destination (a phone number for Text). The chosen channel + destination is
 * stored as the priority-1 endpoint server-side. Used by onboarding and Settings.
 */

export type ContactChannel = 'sms' | 'line' | 'email';

export interface ContactValues {
  name: string;
  relationship: string;
  channel: ContactChannel;
  destination: string;
}

const CHANNELS: Array<{ key: ContactChannel; label: string; hint: string; inputMode: 'tel' | 'email' | 'text'; placeholder: string }> = [
  { key: 'sms', label: 'Text', hint: 'Phone number', inputMode: 'tel', placeholder: '+1 555 123 4567' },
  { key: 'line', label: 'LINE', hint: 'LINE ID', inputMode: 'text', placeholder: 'their LINE ID' },
  { key: 'email', label: 'Email', hint: 'Email address', inputMode: 'email', placeholder: 'their@email.com' },
];

export function ContactForm({
  initial,
  busy,
  error,
  submitLabel,
  onSubmit,
}: {
  initial?: Partial<ContactValues>;
  busy?: boolean;
  error?: string | null;
  submitLabel: string;
  onSubmit: (values: ContactValues) => void;
}): JSX.Element {
  const [name, setName] = useState(initial?.name ?? '');
  const [relationship, setRelationship] = useState(initial?.relationship ?? '');
  const [channel, setChannel] = useState<ContactChannel>(initial?.channel ?? 'sms');
  const [destination, setDestination] = useState(initial?.destination ?? '');

  const active = CHANNELS.find((ch) => ch.key === channel)!;
  const canSubmit = name.trim().length > 0 && destination.trim().length > 0 && !busy;

  return (
    <div className="space-y-5">
      <label className="block">
        <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/50">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Their name"
          className="w-full border-b border-med-text/25 bg-transparent py-2 font-sans text-lg text-med-text outline-none placeholder:text-med-text/30 focus:border-med-text/60"
        />
      </label>

      <div>
        <span className="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/50">
          Preferred channel
        </span>
        <div className="flex gap-2">
          {CHANNELS.map((ch) => (
            <button
              key={ch.key}
              type="button"
              onClick={() => setChannel(ch.key)}
              className={`flex-1 rounded-lg border py-3 font-mono text-xs uppercase tracking-[0.1em] transition-colors ${
                channel === ch.key
                  ? 'border-med-text/80 bg-med-text/10 text-med-text'
                  : 'border-med-text/25 text-med-text/55'
              }`}
            >
              {ch.label}
            </button>
          ))}
        </div>
      </div>

      <label className="block">
        <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/50">{active.hint}</span>
        <input
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          inputMode={active.inputMode}
          type={channel === 'email' ? 'email' : 'text'}
          placeholder={active.placeholder}
          className="w-full border-b border-med-text/25 bg-transparent py-2 font-sans text-lg text-med-text outline-none placeholder:text-med-text/30 focus:border-med-text/60"
        />
      </label>

      <label className="block">
        <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/50">Relationship</span>
        <input
          value={relationship}
          onChange={(e) => setRelationship(e.target.value)}
          placeholder="e.g. spouse, friend"
          className="w-full border-b border-med-text/25 bg-transparent py-2 font-sans text-lg text-med-text outline-none placeholder:text-med-text/30 focus:border-med-text/60"
        />
      </label>

      {error ? <p className="text-sm text-status-active">{error}</p> : null}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => onSubmit({ name: name.trim(), relationship: relationship.trim(), channel, destination: destination.trim() })}
        className="w-full rounded-full bg-med-text/90 py-4 font-sans text-base font-medium tracking-[0.04em] text-[#1a1f3a] transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {busy ? 'Saving…' : submitLabel}
      </button>
    </div>
  );
}
