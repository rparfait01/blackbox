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

interface ChannelMeta {
  label: string;
  hint: string;
  inputMode: 'tel' | 'email' | 'text';
  placeholder: string;
}

// Metadata for every channel (used to render whichever channel a contact is on).
const CHANNEL_META: Record<ContactChannel, ChannelMeta> = {
  email: { label: 'Email', hint: 'Email address', inputMode: 'email', placeholder: 'their@email.com' },
  line: { label: 'LINE', hint: 'LINE user ID', inputMode: 'text', placeholder: 'their LINE user ID' },
  sms: { label: 'Text', hint: 'Phone number', inputMode: 'tel', placeholder: '+1 555 123 4567' },
};

// Only channels that can ACTUALLY deliver are offered. SMS is omitted until the
// SMS channel is implemented — presenting it would let a contact be saved that
// silently never gets reached. Email is the default (the reliably-delivering
// channel for the pilot). The server also rejects a non-deliverable channel, so
// this is belt-and-suspenders, never the only guard.
const SELECTABLE_CHANNELS: ContactChannel[] = ['email', 'line'];

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
  const [channel, setChannel] = useState<ContactChannel>(initial?.channel ?? 'email');
  const [destination, setDestination] = useState(initial?.destination ?? '');

  const active = CHANNEL_META[channel];
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
          {SELECTABLE_CHANNELS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setChannel(key)}
              className={`flex-1 rounded-lg border py-3 font-mono text-xs uppercase tracking-[0.1em] transition-colors ${
                channel === key
                  ? 'border-med-text/80 bg-med-text/10 text-med-text'
                  : 'border-med-text/25 text-med-text/55'
              }`}
            >
              {CHANNEL_META[key].label}
            </button>
          ))}
        </div>
        {channel === 'line' ? (
          <p className="mt-2 text-[11px] leading-relaxed text-med-text/45">
            LINE needs their LINE <span className="text-med-text/70">user ID</span> (from following
            the bot), not their display name. If unsure, use Email.
          </p>
        ) : null}
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
