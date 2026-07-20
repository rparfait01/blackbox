import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import { ContactForm, type ContactChannel, type ContactValues } from '@/components/ContactForm';

/**
 * Support-role tabs (Brief 8 P1 + Brief 9 roles model): three Contact slots
 * (primary / secondary / tertiary) + one Guardian slot. A filled slot is
 * selectable to view / edit / remove; an empty slot shows "+" to add. The
 * guardian slot also carries the on/off toggle and surfaces the guardian's load
 * ("also failsafe for N others"). All changes persist server-side and are locked
 * during an active alert (the Settings route itself is blocked then).
 */

type SlotKey = 'primary' | 'secondary' | 'tertiary' | 'guardian' | 'emergency';

interface Slot {
  slot: SlotKey;
  filled: boolean;
  id: string | null;
  contactName: string | null;
  channel: ContactChannel | null;
  destination: string | null;
  /** §2: the backup channel the dispatcher tries if the preferred one fails. */
  fallbackChannel: ContactChannel | null;
  fallbackDestination: string | null;
  /** §0: consent status. Only a 'confirmed' contact is ever notified. */
  status: 'pending' | 'confirmed' | 'declined' | null;
}

interface ContactsData {
  slots: Slot[];
  guardianEnabled: boolean;
  guardianAlsoFailsafeFor: number;
  /** Brief 19: the designated check-in contact id (null → primary is used). */
  checkinContactId: string | null;
  /** Brief 23 §2: true only when at least one recipient is on a channel that can
   *  actually deliver in this deployment. False → a config-time loud warning. */
  armable: boolean;
  /** Server truth: which channels can actually deliver right now. */
  deliverableChannels?: ContactChannel[];
}

// Contact Consent §0: the ceiling is now ONE contact + guardian (down from three).
// secondary/tertiary are retired from the UI — survivors in these circumstances
// typically have deliberately narrowed networks, and more slots does not serve them.
const CONTACT_SLOTS: SlotKey[] = ['primary'];

const SLOT_LABEL: Record<SlotKey, string> = {
  primary: 'Primary',
  secondary: 'Secondary',
  tertiary: 'Tertiary',
  guardian: 'Guardian',
  emergency: 'Emergency',
};
const CHANNEL_LABEL: Record<ContactChannel, string> = { sms: 'Text', line: 'LINE', email: 'Email' };

/** §1/§3: how a contact's consent status reads in the UI. Only 'confirmed' is live. */
const STATUS_META: Record<'pending' | 'confirmed' | 'declined', { label: string; tone: string }> = {
  confirmed: { label: 'Confirmed', tone: 'text-status-armed' },
  pending: { label: 'Pending — awaiting reply', tone: 'text-med-warn' },
  declined: { label: 'Declined', tone: 'text-med-warn' },
};

export function ContactTabs({ flash }: { flash: (msg: string) => void }): JSX.Element {
  const [data, setData] = useState<ContactsData | null>(null);
  const [selected, setSelected] = useState<SlotKey>('primary');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    void api<ContactsData>('/v1/me/contacts').then((r) => r.ok && r.data && setData(r.data));
  };
  useEffect(load, []);

  const slot = data?.slots.find((s) => s.slot === selected);
  // The effective check-in recipient: the explicit designation, or the primary
  // contact by default (Brief 19). Used to mark which contact currently holds it.
  const primaryId = data?.slots.find((s) => s.slot === 'primary')?.id ?? null;
  const effectiveCheckinId = data?.checkinContactId ?? primaryId;

  async function save(values: ContactValues): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await api<{ error?: string; message?: string }>(`/v1/me/contacts/${selected}`, {
      body: {
        contactName: values.name,
        channel: values.channel,
        destination: values.destination,
        // §2: the backup the dispatcher falls back to before reporting not-reached.
        fallbackChannel: values.fallbackChannel ?? null,
        fallbackDestination: values.fallbackDestination ?? null,
      },
    });
    setBusy(false);
    if (res.ok) {
      setEditing(false);
      flash(`${SLOT_LABEL[selected]} saved`);
      load();
    } else if (res.status === 423) {
      setError('Locked during an active alert.');
    } else if (res.data?.message) {
      // The server's message is the SPECIFIC one — "add the country code, starting
      // with +", "that is not a LINE user ID", "that channel is not available yet".
      // Surface it verbatim: a generic "check the destination" here would swallow
      // the only thing that tells the user how to fix it.
      setError(res.data.message);
    } else {
      setError('Could not save. Check the destination and try again.');
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm(`Are you sure you want to clear your ${SLOT_LABEL[selected]} contact?`)) {
      return;
    }
    const res = await api(`/v1/me/contacts/${selected}`, { method: 'DELETE' });
    flash(res.ok ? `${SLOT_LABEL[selected]} cleared` : 'Could not clear');
    load();
  }

  // Brief 19: designate this contact as the single check-in ("I'm OK") recipient.
  // Exactly one contact holds it; selecting reassigns instantly and persists.
  async function designateCheckin(contactId: string | null): Promise<void> {
    if (!contactId) {
      return;
    }
    const res = await api('/v1/me/checkin-contact', { body: { contactId } });
    if (res.ok) {
      flash('Check-in contact set');
      load();
    } else {
      flash('Could not set check-in contact');
    }
  }

  async function toggleGuardian(enabled: boolean): Promise<void> {
    const res = await api('/v1/me/guardian-enabled', { body: { enabled } });
    if (res.ok) {
      flash(enabled ? 'Guardian enabled' : 'Guardian disabled');
      load();
    } else {
      flash('Could not change');
    }
  }

  // §3: Armed requires at least one CONFIRMED contact. `armable` is server truth
  // (behind the consent-gate flag it already means "has a confirmed recipient").
  // Shown in Settings/Visible only — never in the covert facade (§0a).
  const armed = data?.armable === true;

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/45">Support roles</span>
        {data ? (
          <span
            className={`font-mono text-[11px] uppercase tracking-[0.12em] ${armed ? 'text-status-armed' : 'text-med-warn'}`}
          >
            {armed ? 'Armed' : 'Not ready'}
          </span>
        ) : null}
      </div>

      {/* §3 (+ Brief 23 §2): the standing zero-contact/unreachable warning. Settings
          is the ONLY place a Hidden-primary user can be warned — the covert facade
          shows nothing (§0a: a warning banner there would be a tell), so this must
          state the consequence plainly rather than only the technical cause.
          It never blocks the trigger: the alert still fires and still records. */}
      {/* Email is being retired from the alert path (notification brief §1): a
          single-vendor daily cap has silently taken alerts down twice. It still
          DELIVERS for now — pulling it before SMS exists would leave these accounts
          with no path at all, which is the outcome the brief forbids. So: tell them
          plainly, don't nag, don't block, and don't pretend it's already broken.
          This notice retires itself once the contact has a non-email channel. */}
      {data?.armable &&
      data.slots.some((s) => s.filled && s.channel === 'email' && !s.fallbackChannel) ? (
        <div className="mb-4 rounded-lg border border-med-text/25 bg-black/20 p-3">
          <p className="text-[12px] font-medium leading-relaxed text-med-text">
            Email is being retired for alerts.
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-med-text/60">
            It still works today, but it&apos;s the least reliable way to reach someone. Add LINE — or a
            backup channel — to any email-only contact below so an alert always has a second way through.
          </p>
        </div>
      ) : null}

      {data && !data.armable ? (
        <div className="mb-4 rounded-lg border border-med-warn/50 bg-med-warn/10 p-3">
          <p className="text-[12px] font-medium leading-relaxed text-med-warn">
            No one will be notified if you trigger.
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-med-text/70">
            Add a contact on a working channel (LINE or SMS) so your messages can actually be delivered —
            an email‑only contact may not go through. Your alert will still record if you trigger.
          </p>
        </div>
      ) : null}

      {/* §0: one contact + guardian (+ the emergency-services slot). secondary/
          tertiary are retired. A filled slot shows a consent dot: green = confirmed,
          amber = pending/declined (not yet live). */}
      <div className="mb-4 grid grid-cols-3 gap-1.5">
        {([...CONTACT_SLOTS, 'guardian', 'emergency'] as SlotKey[]).map((key) => {
          const s = data?.slots.find((x) => x.slot === key);
          const active = selected === key;
          const st = s?.filled ? (s.status ?? 'confirmed') : null;
          return (
            <button
              key={key}
              onClick={() => {
                setSelected(key);
                setEditing(false);
                setError(null);
              }}
              className={`flex-1 rounded-lg border py-2 font-mono text-[10px] uppercase tracking-[0.08em] ${
                active ? 'border-med-text/80 bg-med-text/10 text-med-text' : 'border-med-text/25 text-med-text/55'
              }`}
            >
              <span className="inline-flex items-center gap-1">
                {SLOT_LABEL[key]}
                {st ? (
                  <span
                    aria-hidden
                    className={`inline-block h-1.5 w-1.5 rounded-full ${st === 'confirmed' ? 'bg-status-armed' : 'bg-med-warn'}`}
                  />
                ) : null}
              </span>
              <div className="mt-1 text-[11px] normal-case tracking-normal">
                {s?.filled ? (s.contactName ?? '—') : <span className="text-med-text/40">+</span>}
              </div>
            </button>
          );
        })}
      </div>

      {slot ? (
        <div className="rounded-lg border border-med-text/20 bg-black/20 p-4">
          {editing || !slot.filled ? (
            <ContactForm
              initial={
                slot.filled
                  ? {
                      name: slot.contactName ?? '',
                      relationship: '',
                      channel: slot.channel ?? 'sms',
                      destination: slot.destination ?? '',
                      // Carry the existing backup in, or editing the contact would
                      // silently DELETE it (upsertSlot rewrites every endpoint).
                      fallbackChannel: slot.fallbackChannel,
                      fallbackDestination: slot.fallbackDestination,
                    }
                  : undefined
              }
              busy={busy}
              error={error}
              submitLabel={slot.filled ? `Save ${SLOT_LABEL[selected]}` : `Add ${SLOT_LABEL[selected]}`}
              onSubmit={(v) => void save(v)}
              slot={selected}
              onLineConnected={() => {
                setEditing(false);
                flash(`${SLOT_LABEL[selected]} connected on LINE`);
                load();
              }}
            />
          ) : (
            <>
              <div className="flex justify-between border-b border-med-text/15 py-2">
                <span className="text-med-text/60">{slot.contactName ?? 'Contact'}</span>
                <span className="text-med-text">
                  {slot.channel ? CHANNEL_LABEL[slot.channel] : '—'} · {slot.destination ?? '—'}
                </span>
              </div>
              {/* §1: consent status, stated plainly. A pending contact is not yet a
                  live recipient — no ambiguity about who would actually be reached. */}
              {slot.status && slot.status !== 'confirmed' ? (
                <p className={`mt-2 text-[12px] leading-relaxed ${STATUS_META[slot.status].tone}`}>
                  {STATUS_META[slot.status].label}.{' '}
                  {slot.status === 'pending'
                    ? 'They’ve been texted to confirm — they won’t be notified until they reply YES.'
                    : 'They opted out and will not be notified.'}
                </p>
              ) : slot.status === 'confirmed' ? (
                <p className="mt-2 text-[12px] leading-relaxed text-status-armed">Confirmed — they’ll be notified if you trigger.</p>
              ) : null}
              <div className="mt-3 flex gap-4">
                <button onClick={() => setEditing(true)} className="text-sm text-med-text/70 underline">
                  Edit
                </button>
                <button onClick={() => void remove()} className="text-sm text-med-warn/80 underline">
                  Remove
                </button>
              </div>
            </>
          )}

          {/* Brief 19: designate this contact as the single check-in ("I'm OK")
              recipient. Only on the three contact slots (never guardian/emergency).
              Exactly one contact holds it — the marked one; tap another to move it. */}
          {CONTACT_SLOTS.includes(selected) && slot.filled && !editing ? (
            <div className="mt-4 border-t border-med-text/15 pt-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-med-text/70">Check-in partner</span>
                {slot.id && slot.id === effectiveCheckinId ? (
                  <span className="rounded-full border border-[#34c759]/50 bg-[#13301a] px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-[#34c759]">
                    This contact ✓
                  </span>
                ) : (
                  <button
                    onClick={() => void designateCheckin(slot.id)}
                    className="rounded-full border border-med-text/25 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-med-text/70"
                  >
                    Check in here
                  </button>
                )}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-med-text/45">
                Your “I’m OK” check-in goes to this one contact. Choose a different contact to move it.
              </p>
            </div>
          ) : null}

          {selected === 'emergency' ? (
            <p className="mt-3 border-t border-med-text/15 pt-3 text-[11px] leading-relaxed text-med-text/45">
              Emergency fallback. Notified only if the whole cascade — every contact and your
              guardian — passes without anyone taking coordination. Not part of the normal cascade.
              For testing, use a number you control, not a live emergency line.
            </p>
          ) : null}
          {selected === 'guardian' ? (
            <div className="mt-4 border-t border-med-text/15 pt-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-med-text/70">Guardian failsafe</span>
                <button
                  onClick={() => void toggleGuardian(!(data?.guardianEnabled ?? true))}
                  className={`rounded-full border px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] ${
                    data?.guardianEnabled
                      ? 'border-med-text/80 bg-med-text/10 text-med-text'
                      : 'border-med-text/25 text-med-text/50'
                  }`}
                >
                  {data?.guardianEnabled ? 'On' : 'Off'}
                </button>
              </div>
              {data && data.guardianAlsoFailsafeFor > 0 ? (
                <p className="mt-2 text-[11px] leading-relaxed text-med-text/45">
                  Your guardian is also the failsafe for {data.guardianAlsoFailsafeFor} other
                  {data.guardianAlsoFailsafeFor === 1 ? ' person' : ' people'}. A failsafe responsible
                  for many is a weaker failsafe — keep this low.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
