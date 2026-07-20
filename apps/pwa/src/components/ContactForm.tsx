import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import { LineConnect } from '@/components/LineConnect';

/**
 * Support-contact setup (Fix Brief 3 contact screen). The user names their
 * guardian, picks the preferred channel — Text (SMS) / LINE / Email — and enters
 * the destination (a phone number for Text). The chosen channel + destination is
 * stored as the priority-1 endpoint server-side. Used by onboarding and Settings.
 *
 * LINE is special (Brief 18): a LINE id is NEVER typed or looked up. Picking LINE
 * swaps the destination field for the QR-connect flow (LineConnect), which binds
 * the contact's captured userId to the slot. So LINE needs the slot + a
 * connected callback from the parent; without them, LINE can't be saved here.
 */

export type ContactChannel = 'sms' | 'line' | 'email';

export interface ContactValues {
  name: string;
  relationship: string;
  channel: ContactChannel;
  destination: string;
  /** Optional BACKUP channel — the dispatcher tries it only if the preferred one
   *  fails, before ever reporting this contact as not reached. */
  fallbackChannel?: ContactChannel | null;
  fallbackDestination?: string | null;
}

interface ChannelMeta {
  label: string;
  hint: string;
  inputMode: 'tel' | 'email' | 'text';
  placeholder: string;
}

// Metadata for every channel (used to render whichever channel a contact is on).
// LINE has no destination field — it is connected by QR, never typed.
const CHANNEL_META: Record<ContactChannel, ChannelMeta> = {
  email: { label: 'Email', hint: 'Email address', inputMode: 'email', placeholder: 'their@email.com' },
  line: { label: 'LINE', hint: '', inputMode: 'text', placeholder: '' },
  sms: { label: 'Text', hint: 'Phone number', inputMode: 'tel', placeholder: '+1 555 123 4567' },
};

// Which channels are offered is SERVER TRUTH, not a list maintained here. It comes
// from /v1/me/contacts.deliverableChannels, derived from the same isChannelDeliverable
// the dispatcher uses — so SMS appears by itself the day Twilio is provisioned, and
// email vanishes the day it is retired, with no client change and no list to forget.
// A hardcoded list is how a channel ends up offered that silently never delivers.
// Falls back to Email only while the fetch is in flight — the conservative choice:
// the server rejects a non-deliverable channel anyway, so this can never be the
// only guard.
const FALLBACK_WHILE_LOADING: ContactChannel[] = ['email'];

export function ContactForm({
  initial,
  busy,
  error,
  submitLabel,
  onSubmit,
  slot,
  onLineConnected,
}: {
  initial?: Partial<ContactValues>;
  busy?: boolean;
  error?: string | null;
  submitLabel: string;
  onSubmit: (values: ContactValues) => void;
  /** The slot this form edits — required to offer LINE QR-connect (Brief 18). */
  slot?: string;
  /** Called when a LINE contact finishes the QR-connect (the slot is already
   *  saved server-side by the webhook bind). */
  onLineConnected?: () => void;
}): JSX.Element {
  const [name, setName] = useState(initial?.name ?? '');
  const [relationship, setRelationship] = useState(initial?.relationship ?? '');
  const [channel, setChannel] = useState<ContactChannel>(initial?.channel ?? 'email');
  const [destination, setDestination] = useState(initial?.destination ?? '');
  const [fallbackChannel, setFallbackChannel] = useState<ContactChannel | null>(
    initial?.fallbackChannel ?? null,
  );
  const [fallbackDestination, setFallbackDestination] = useState(initial?.fallbackDestination ?? '');
  const [deliverable, setDeliverable] = useState<ContactChannel[]>(FALLBACK_WHILE_LOADING);
  const [typeable, setTypeable] = useState<ContactChannel[]>(FALLBACK_WHILE_LOADING);

  useEffect(() => {
    void api<{ deliverableChannels?: ContactChannel[]; typeableChannels?: ContactChannel[] }>(
      '/v1/me/contacts',
    ).then((r) => {
      if (r.ok && r.data?.deliverableChannels?.length) {
        setDeliverable(r.data.deliverableChannels);
        setTypeable(r.data.typeableChannels ?? []);
      }
    });
  }, []);

  const active = CHANNEL_META[channel];
  const isLine = channel === 'line';
  const lineConnectable = isLine && !!slot && !!onLineConnected;
  // A usable BACKUP must be deliverable, typeable (LINE is QR-only, so it can never
  // be a typed backup), and different from the preferred channel — the same vendor
  // twice is the same failure twice. Today that set is usually empty: with Twilio
  // unprovisioned the only typeable channel is Email, which is normally already the
  // preferred one. So the backup UI stays HIDDEN rather than offering a choice that
  // cannot work, and appears on its own the day SMS goes live.
  const backupOptions = typeable.filter((ch) => ch !== channel && deliverable.includes(ch));
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
          {deliverable.map((key) => (
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
        {isLine ? (
          <p className="mt-2 text-[11px] leading-relaxed text-med-text/45">
            LINE connects by <span className="text-med-text/70">scanning a code</span> — no IDs to
            type or look up. If you&apos;d rather not, use Email.
          </p>
        ) : null}
      </div>

      {isLine ? (
        lineConnectable ? (
          <LineConnect slot={slot!} contactName={name} onConnected={onLineConnected!} />
        ) : (
          <p className="text-[12px] leading-relaxed text-med-text/50">
            LINE is connected from the contact&apos;s slot in Settings. Use Email here for now.
          </p>
        )
      ) : (
        <>
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

          {/* §2 BACKUP channel — only rendered when a genuinely usable one exists.
              If the preferred channel fails, the alert is retried here BEFORE this
              contact is ever reported as not reached. Optional by design: pressing
              a survivor to fill a second address is not worth blocking setup over. */}
          {backupOptions.length > 0 ? (
            <div>
              <span className="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/50">
                Backup channel (optional)
              </span>
              <div className="mb-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setFallbackChannel(null);
                    setFallbackDestination('');
                  }}
                  className={`flex-1 rounded-lg border py-2.5 font-mono text-xs uppercase tracking-[0.1em] transition-colors ${
                    fallbackChannel === null
                      ? 'border-med-text/80 bg-med-text/10 text-med-text'
                      : 'border-med-text/25 text-med-text/55'
                  }`}
                >
                  None
                </button>
                {backupOptions.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setFallbackChannel(key)}
                    className={`flex-1 rounded-lg border py-2.5 font-mono text-xs uppercase tracking-[0.1em] transition-colors ${
                      fallbackChannel === key
                        ? 'border-med-text/80 bg-med-text/10 text-med-text'
                        : 'border-med-text/25 text-med-text/55'
                    }`}
                  >
                    {CHANNEL_META[key].label}
                  </button>
                ))}
              </div>
              {fallbackChannel ? (
                <input
                  value={fallbackDestination}
                  onChange={(e) => setFallbackDestination(e.target.value)}
                  inputMode={CHANNEL_META[fallbackChannel].inputMode}
                  type={fallbackChannel === 'email' ? 'email' : 'text'}
                  placeholder={CHANNEL_META[fallbackChannel].placeholder}
                  className="w-full border-b border-med-text/25 bg-transparent py-2 font-sans text-lg text-med-text outline-none placeholder:text-med-text/30 focus:border-med-text/60"
                />
              ) : (
                <p className="text-[11px] leading-relaxed text-med-text/45">
                  If their {active.label.toLowerCase()} fails, we&apos;ll try the backup before telling you
                  they couldn&apos;t be reached.
                </p>
              )}
            </div>
          ) : null}

          {/* §6 CTA (A2P Call-to-Action evidence): the add screen states, in plain
              language, exactly what happens — the contact is asked to confirm by
              text before they can ever be notified. For SMS this is literally true;
              LINE contacts consent by connecting, so the copy adapts. This screen is
              the artifact attached to the Twilio campaign resubmission. */}
          {channel === 'sms' ? (
            <p className="text-[12px] leading-relaxed text-med-text/55">
              This person will receive a text asking them to confirm before they can be notified in an
              emergency. They can reply STOP at any time to opt out. Msg &amp; data rates may apply.
            </p>
          ) : null}

          {error ? <p className="text-sm text-med-warn">{error}</p> : null}

          <button
            type="button"
            disabled={!canSubmit}
            onClick={() =>
              onSubmit({
                name: name.trim(),
                relationship: relationship.trim(),
                channel,
                destination: destination.trim(),
                // Only send a backup when it is actually complete — a half-filled
                // backup would be refused server-side and block the save.
                fallbackChannel: fallbackChannel && fallbackDestination.trim() ? fallbackChannel : null,
                fallbackDestination: fallbackChannel && fallbackDestination.trim() ? fallbackDestination.trim() : null,
              })
            }
            className="w-full rounded-full bg-med-text/90 py-4 font-sans text-base font-medium tracking-[0.04em] text-[#071416] transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Saving…' : submitLabel}
          </button>
        </>
      )}
    </div>
  );
}
