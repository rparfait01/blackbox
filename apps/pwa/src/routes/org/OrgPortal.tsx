import { useCallback, useEffect, useState } from 'react';

import { api } from '@/lib/api';

/**
 * Org portal — the AUTHENTICATED coordinator/admin surface (Brief 23 §5). A separate
 * world from the survivor app: reached only via /org, never linked from the survivor
 * skin, and it renders only for an org staff member. Every view reads org-scoped
 * endpoints (/v1/org/*) that the server filters by the caller's own org — this UI
 * never sees another org, and shows NO price or fee anywhere (§6).
 *
 * Least privilege: coordinators get Track / Correlate / Enroll; admins additionally
 * get Seats (+ the license record). Role gating here is a courtesy — the server is
 * the authority and refuses an under-privileged call regardless.
 */

export interface OrgMember {
  orgId: string;
  role: 'admin' | 'coordinator';
  orgName: string;
  lane: string;
}

interface Survivor {
  userId: string;
  name: string | null;
  enrolledAt: number;
  setupComplete: boolean;
  contactsConfigured: number;
  activeEvent: boolean;
  role: string;
}

interface OrgEvent {
  id: string;
  createdAt: number;
  status: string;
  userId: string | null;
  cascadeStep: number;
  survivorName: string | null;
}

interface License {
  seatsTotal: number;
  seatsUsed: number;
  termStart: number | null;
  termEnd: number | null;
  status: string;
}

type Tab = 'track' | 'correlate' | 'enroll' | 'seats';

function when(ts: number | null | undefined): string {
  if (!ts) return '—';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'muted'; children: React.ReactNode }): JSX.Element {
  const cls =
    tone === 'ok'
      ? 'border-emerald-400/40 text-emerald-300/90'
      : tone === 'warn'
        ? 'border-med-warn/50 text-med-warn/90'
        : 'border-med-text/25 text-med-text/50';
  return (
    <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] ${cls}`}>
      {children}
    </span>
  );
}

export function OrgPortal({ member, onSignOut }: { member: OrgMember; onSignOut: () => void }): JSX.Element {
  const isAdmin = member.role === 'admin';
  const [tab, setTab] = useState<Tab>('track');
  const tabs: Array<{ key: Tab; label: string; admin?: boolean }> = [
    { key: 'track', label: 'Track' },
    { key: 'correlate', label: 'Correlate' },
    { key: 'enroll', label: 'Enroll' },
    { key: 'seats', label: 'Seats', admin: true },
  ];

  return (
    <main className="stillpoint-bg min-h-full w-full overflow-y-auto px-6 pb-10 pt-safe-6 text-med-text">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-baseline justify-between">
          <div>
            <h1 className="font-serif text-2xl font-light tracking-[0.04em]">{member.orgName}</h1>
            <p className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.14em] text-med-text/45">
              {member.role} · organisation portal
            </p>
          </div>
          <button onClick={onSignOut} className="text-sm text-med-text/50 underline">
            Sign out
          </button>
        </div>

        <div className="mb-6 flex gap-2 border-b border-med-text/15 pb-3">
          {tabs
            .filter((t) => !t.admin || isAdmin)
            .map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`rounded-full px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
                  tab === t.key ? 'bg-med-text/10 text-med-text' : 'text-med-text/50'
                }`}
              >
                {t.label}
              </button>
            ))}
        </div>

        {tab === 'track' ? <TrackView /> : null}
        {tab === 'correlate' ? <CorrelateView /> : null}
        {tab === 'enroll' ? <EnrollView isAdmin={isAdmin} /> : null}
        {tab === 'seats' && isAdmin ? <SeatsView /> : null}
      </div>
    </main>
  );
}

function TrackView(): JSX.Element {
  const [rows, setRows] = useState<Survivor[] | null>(null);
  useEffect(() => {
    void api<{ survivors: Survivor[] }>('/v1/org/survivors').then((r) => setRows(r.data?.survivors ?? []));
  }, []);
  if (!rows) return <p className="text-sm text-med-text/50">Loading…</p>;
  if (rows.length === 0) return <p className="text-sm text-med-text/50">No one enrolled yet.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((s) => (
        <li key={s.userId} className="flex items-center justify-between rounded-lg border border-med-text/15 bg-black/20 px-4 py-3">
          <div>
            <p className="text-med-text">{s.name ?? 'Unnamed'}</p>
            <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-med-text/40">
              {s.role} · enrolled {when(s.enrolledAt)}
            </p>
          </div>
          <div className="flex gap-1.5">
            {s.activeEvent ? <Badge tone="warn">active alert</Badge> : null}
            <Badge tone={s.setupComplete ? 'ok' : 'muted'}>
              {s.setupComplete ? `${s.contactsConfigured} contact${s.contactsConfigured === 1 ? '' : 's'}` : 'setup incomplete'}
            </Badge>
          </div>
        </li>
      ))}
    </ul>
  );
}

function CorrelateView(): JSX.Element {
  const [rows, setRows] = useState<OrgEvent[] | null>(null);
  useEffect(() => {
    void api<{ events: OrgEvent[] }>('/v1/org/events').then((r) => setRows(r.data?.events ?? []));
  }, []);
  if (!rows) return <p className="text-sm text-med-text/50">Loading…</p>;
  if (rows.length === 0) return <p className="text-sm text-med-text/50">No active alerts in your organisation.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((e) => (
        <li key={e.id} className="rounded-lg border border-med-warn/30 bg-med-warn/5 px-4 py-3">
          <div className="flex items-center justify-between">
            <p className="text-med-text">{e.survivorName ?? 'Unattributed'}</p>
            <Badge tone="warn">step {e.cascadeStep}</Badge>
          </div>
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-med-text/40">
            opened {when(e.createdAt)} · event {e.id.slice(0, 8)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function EnrollView({ isAdmin }: { isAdmin: boolean }): JSX.Element {
  const [role, setRole] = useState<'survivor' | 'coordinator'>('survivor');
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function issue(): Promise<void> {
    setBusy(true);
    setError(null);
    setCode(null);
    const res = await api<{ code: string }>('/v1/org/codes', { body: { role, maxUses: 1 } });
    setBusy(false);
    if (!res.ok || !res.data?.code) {
      setError(res.status === 403 ? 'Only an admin can issue staff codes.' : 'Could not issue a code. Try again.');
      return;
    }
    setCode(res.data.code);
  }

  return (
    <div className="space-y-5">
      <p className="text-[13px] leading-relaxed text-med-text/70">
        Issue a one-time enrollment code, then share it with the person. They enter it in their own BLACK BOX
        app to join your organisation — their account stays theirs.
      </p>
      {isAdmin ? (
        <div className="flex gap-2">
          {(['survivor', 'coordinator'] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRole(r)}
              className={`flex-1 rounded-lg border py-2.5 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
                role === r ? 'border-med-text/80 bg-med-text/10 text-med-text' : 'border-med-text/25 text-med-text/55'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      ) : null}
      <button
        onClick={() => void issue()}
        disabled={busy}
        className="w-full rounded-full bg-med-text/90 py-3.5 font-sans text-base font-medium text-[#071416] disabled:opacity-40"
      >
        {busy ? 'Issuing…' : `Issue a ${role} code`}
      </button>
      {error ? <p className="text-sm text-med-warn">{error}</p> : null}
      {code ? (
        <div className="rounded-lg border border-med-text/20 bg-black/20 p-4 text-center">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-med-text/45">Enrollment code (one use)</p>
          <p className="select-all break-all font-mono text-lg tracking-[0.08em] text-med-text">{code}</p>
        </div>
      ) : null}
    </div>
  );
}

function SeatsView(): JSX.Element {
  const [license, setLicense] = useState<License | null>(null);
  const [org, setOrg] = useState<{ name: string; lane: string; status: string } | null>(null);
  const [rows, setRows] = useState<Survivor[] | null>(null);
  const [seats, setSeats] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback((): void => {
    void api<{ org: { name: string; lane: string; status: string } | null; license: License | null }>(
      '/v1/org/license',
    ).then((r) => {
      setLicense(r.data?.license ?? null);
      setOrg(r.data?.org ?? null);
      if (r.data?.license) setSeats(String(r.data.license.seatsTotal));
    });
    void api<{ survivors: Survivor[] }>('/v1/org/survivors').then((r) => setRows(r.data?.survivors ?? []));
  }, []);
  useEffect(load, [load]);

  async function saveSeats(): Promise<void> {
    setMsg(null);
    const n = Number(seats);
    const res = await api<{ error?: string; message?: string }>('/v1/org/seats', { body: { seatsTotal: n } });
    if (!res.ok) {
      setMsg(res.data?.message ?? 'Could not update seats.');
      return;
    }
    setMsg('Seats updated.');
    load();
  }

  async function remove(userId: string): Promise<void> {
    const res = await api('/v1/org/survivors/' + userId + '/remove', { method: 'POST' });
    if (res.ok) {
      setMsg('Access revoked.');
      load();
    }
  }

  if (!license) {
    return <p className="text-sm text-med-text/50">{org === null ? 'Loading…' : 'No license on record.'}</p>;
  }
  const survivors = (rows ?? []).filter((s) => s.role === 'survivor');
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-med-text/20 bg-black/20 p-4">
        <div className="flex items-baseline justify-between">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-med-text/45">License</p>
          <Badge tone="muted">{org?.lane === 'zero_fee' ? 'zero-fee' : org?.lane}</Badge>
        </div>
        <p className="mt-2 text-2xl font-light text-med-text">
          {license.seatsUsed}
          <span className="text-med-text/40"> / {license.seatsTotal} seats</span>
        </p>
        <div className="mt-3 flex items-center gap-2">
          <input
            value={seats}
            onChange={(e) => setSeats(e.target.value)}
            inputMode="numeric"
            className="w-24 border-b border-med-text/25 bg-transparent py-1.5 text-lg text-med-text outline-none"
          />
          <button onClick={() => void saveSeats()} className="rounded-full border border-med-text/40 px-4 py-1.5 text-sm text-med-text">
            Set seats
          </button>
        </div>
      </div>

      <div>
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.12em] text-med-text/45">Enrolled survivors</p>
        {survivors.length === 0 ? (
          <p className="text-sm text-med-text/50">None enrolled.</p>
        ) : (
          <ul className="space-y-2">
            {survivors.map((s) => (
              <li key={s.userId} className="flex items-center justify-between rounded-lg border border-med-text/15 px-4 py-2.5">
                <span className="text-med-text">{s.name ?? 'Unnamed'}</span>
                <button
                  onClick={() => void remove(s.userId)}
                  className="text-[12px] text-med-warn/80 underline"
                >
                  Remove seat
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {msg ? <p className="text-sm text-med-text/70">{msg}</p> : null}
    </div>
  );
}
