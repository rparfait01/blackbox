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
  contactName: string | null;
  channel: ContactChannel | null;
  destination: string | null;
}

interface ContactsData {
  slots: Slot[];
  guardianEnabled: boolean;
  guardianAlsoFailsafeFor: number;
}

const SLOT_LABEL: Record<SlotKey, string> = {
  primary: 'Primary',
  secondary: 'Secondary',
  tertiary: 'Tertiary',
  guardian: 'Guardian',
  emergency: 'Emergency',
};
const CHANNEL_LABEL: Record<ContactChannel, string> = { sms: 'Text', line: 'LINE', email: 'Email' };

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

  async function save(values: ContactValues): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await api<{ error?: string; message?: string }>(`/v1/me/contacts/${selected}`, {
      body: { contactName: values.name, channel: values.channel, destination: values.destination },
    });
    setBusy(false);
    if (res.ok) {
      setEditing(false);
      flash(`${SLOT_LABEL[selected]} saved`);
      load();
    } else if (res.status === 423) {
      setError('Locked during an active alert.');
    } else if (res.data?.error === 'channel_not_available') {
      // Never let a non-deliverable channel be saved silently.
      setError(res.data.message ?? 'That channel is not available yet.');
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

  async function toggleGuardian(enabled: boolean): Promise<void> {
    const res = await api('/v1/me/guardian-enabled', { body: { enabled } });
    if (res.ok) {
      flash(enabled ? 'Guardian enabled' : 'Guardian disabled');
      load();
    } else {
      flash('Could not change');
    }
  }

  return (
    <section className="mb-8">
      <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/45">
        Support roles
      </div>

      <div className="mb-4 grid grid-cols-5 gap-1.5">
        {(['primary', 'secondary', 'tertiary', 'guardian', 'emergency'] as SlotKey[]).map((key) => {
          const s = data?.slots.find((x) => x.slot === key);
          const active = selected === key;
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
              {SLOT_LABEL[key]}
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
                    }
                  : undefined
              }
              busy={busy}
              error={error}
              submitLabel={slot.filled ? `Save ${SLOT_LABEL[selected]}` : `Add ${SLOT_LABEL[selected]}`}
              onSubmit={(v) => void save(v)}
            />
          ) : (
            <>
              <div className="flex justify-between border-b border-med-text/15 py-2">
                <span className="text-med-text/60">{slot.contactName ?? 'Contact'}</span>
                <span className="text-med-text">
                  {slot.channel ? CHANNEL_LABEL[slot.channel] : '—'} · {slot.destination ?? '—'}
                </span>
              </div>
              <div className="mt-3 flex gap-4">
                <button onClick={() => setEditing(true)} className="text-sm text-med-text/70 underline">
                  Edit
                </button>
                <button onClick={() => void remove()} className="text-sm text-status-active/80 underline">
                  Remove
                </button>
              </div>
            </>
          )}

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
