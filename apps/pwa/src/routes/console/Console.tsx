import { useCallback, useEffect, useState } from 'react';

import { api } from '@/lib/api';
import { clearSession, getSessionToken, setSession, type DisplayMode } from '@/lib/auth';
import { loginWithPasskey, passkeySupported } from '@/lib/passkey';
import {
  Btn,
  Deny,
  EmptyRow,
  Field,
  formatDate,
  Metric,
  NewCode,
  Pill,
  Section,
  Select,
  SubSection,
  TableWrap,
  Td,
  TextInput,
  Th,
  Wall,
  type PillTone,
} from './ui';

/**
 * THE CONSOLE (Brief 33b + 33c) — one shell, four levels, all decided by the server.
 *
 * This file renders. It does not authorise. Every list below is whatever
 * /v1/console/* returned for THIS session, and every control is an action the server
 * will re-check when it is pressed. If this file were rewritten to show every panel to
 * everyone, a coordinator would still get 403s — that is the difference between a
 * boundary and a hidden button, and it is the whole point of the brief.
 *
 * NOT part of the Hidden facade (§0a): reachable only by typing /console. Nothing in the
 * survivor skin links here, and no console word appears in the covert app.
 */

// ---------- server-decided identity ----------

type Level = 'operator' | 'admin' | 'coordinator' | 'unmarked';

interface ConsoleMe {
  userId: string;
  displayName: string | null;
  level: Level;
  levelLabel: string;
  orgId: string | null;
  orgName: string | null;
  may: {
    orgs: boolean;
    accounts: boolean;
    maintenance: boolean;
    seats: boolean;
    codes: boolean;
    roster: boolean;
    issueRoles: Array<'survivor' | 'coordinator'>;
  };
}

interface Overview {
  scope: string;
  metrics: Record<string, number>;
}

// ---------- shared helpers ----------

const CODE_STATUS_TONE: Record<string, PillTone> = {
  active: 'amber',
  redeemed: 'grey',
  exhausted: 'grey',
  expired: 'grey',
  revoked: 'red',
};

const READINESS: Record<string, { tone: PillTone; label: string }> = {
  armed: { tone: 'green', label: 'Armed' },
  not_ready: { tone: 'red', label: 'Not ready' },
  not_redeemed: { tone: 'grey', label: 'Not redeemed' },
};

const LEVEL_TONE: Record<string, PillTone> = {
  DEV: 'amber',
  ADMIN: 'teal',
  COORD: 'grey',
  UNMARKED: 'grey',
};

/** Load-on-mount + refresh, the one data pattern every panel uses. */
function useLoader<T>(path: string, enabled = true): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void api<T>(path).then((res) => {
      if (!live) return;
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else {
        // Honest failure: say what the server said, never an empty table that reads as
        // "there is nothing here" when the truth is "you were refused".
        setError(res.status === 0 ? 'No connection.' : `Server refused (${res.status}).`);
      }
    });
    return () => {
      live = false;
    };
  }, [path, enabled, nonce]);
  return { data, error, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

function Toast({ message }: { message: string | null }): JSX.Element | null {
  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 border border-status-armed bg-bb-elevated px-[18px] py-[10px] font-mono text-[11px] tracking-[0.06em] text-bb-text"
    >
      {message}
    </div>
  );
}

// =====================================================================
// OPERATOR — organisations
// =====================================================================

interface OrgRow {
  orgId: string;
  name: string;
  lane: string;
  status: string;
  seatsTotal: number;
  seatsUsed: number;
  enrolled: number;
  activations30d: number;
  adminCount: number;
  seatsLocked: boolean;
}

function OrgsPanel({ notify }: { notify: (m: string) => void }): JSX.Element {
  const { data, error, reload } = useLoader<{ orgs: OrgRow[] }>('/v1/console/orgs');
  const [name, setName] = useState('');
  const [lane, setLane] = useState('zero_fee');
  const [seats, setSeats] = useState('100');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const orgs = data?.orgs ?? [];

  async function createOrg(): Promise<void> {
    setFailure(null);
    setBusy(true);
    const res = await api<{ registrationCode: string; error?: string; message?: string }>('/v1/console/orgs', {
      body: { name: name.trim(), lane, seatsTotal: Number(seats) || 0 },
    });
    setBusy(false);
    if (!res.ok || !res.data?.registrationCode) {
      setFailure(res.data?.message ?? `Refused (${res.status}).`);
      return;
    }
    setIssued([res.data.registrationCode]);
    setName('');
    notify('Organisation created. Admin registration code issued.');
    reload();
  }

  async function reissue(orgId: string): Promise<void> {
    const reason = window.prompt('Reason for re-issuing this org’s admin code (logged):');
    if (!reason?.trim()) return;
    const res = await api<{ registrationCode: string; message?: string }>(`/v1/console/orgs/${orgId}/admin-code`, {
      body: { reason: reason.trim() },
    });
    if (!res.ok || !res.data?.registrationCode) {
      notify(res.data?.message ?? `Re-issue refused (${res.status}).`);
      return;
    }
    setIssued([res.data.registrationCode]);
    notify('Fresh admin code issued. Any previous unredeemed code is now dead.');
  }

  return (
    <Section title="Organizations" count={`${orgs.length} ORGS`}>
      <SubSection title="Vet & create organization" defaultOpen={false}>
        <Wall>
          <b className="text-bb-teal">OPERATOR ONLY.</b> Orgs are never self-serve. You vet out of band, create the
          record, and issue a one-time admin registration code. A stolen code can only claim admin on this
          pre-created org — it cannot create one, and it can never confer a seat.
        </Wall>
        <div className="flex flex-wrap items-end gap-[10px] pt-1">
          <Field label="Organization name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kanto Campus Safety" />
          </Field>
          <Field label="Lane">
            <Select value={lane} onChange={(e) => setLane(e.target.value)}>
              <option value="zero_fee">DV shelter / coalition — zero fee</option>
              <option value="paid">Funded institution</option>
            </Select>
          </Field>
          <Field label="Seat cap">
            <TextInput type="number" min={0} value={seats} onChange={(e) => setSeats(e.target.value)} />
          </Field>
          <Btn variant="primary" disabled={busy || !name.trim()} onClick={() => void createOrg()}>
            {busy ? 'Creating…' : 'Create + issue admin code'}
          </Btn>
        </div>
        {failure ? <div className="mt-3"><Deny>{failure}</Deny></div> : null}
        {issued ? <NewCode label="One-time admin registration code" codes={issued} /> : null}
      </SubSection>

      <SubSection title="All organizations">
        {error ? <Deny>{error}</Deny> : null}
        <TableWrap>
          <thead>
            <tr>
              <Th>Org</Th>
              <Th>Lane</Th>
              <Th>Seats</Th>
              <Th numeric>Enrolled</Th>
              <Th numeric>Act·30d</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {orgs.length === 0 ? (
              <EmptyRow colSpan={7}>No organizations yet.</EmptyRow>
            ) : (
              orgs.map((o) => (
                <tr key={o.orgId} className="hover:bg-bb-elevated">
                  <Td>{o.name}</Td>
                  <Td mono muted>
                    {o.lane === 'zero_fee' ? 'zero fee' : 'funded'}
                  </Td>
                  <Td mono muted>
                    {o.seatsUsed}/{o.seatsTotal}
                  </Td>
                  <Td numeric>{o.enrolled}</Td>
                  <Td numeric>{o.activations30d}</Td>
                  <Td>
                    {o.seatsLocked ? (
                      <Pill tone="amber">Needs {2 - o.adminCount} admin</Pill>
                    ) : (
                      <Pill tone={o.status === 'active' ? 'green' : 'grey'}>{o.status}</Pill>
                    )}
                  </Td>
                  <Td>
                    <Btn small onClick={() => void reissue(o.orgId)}>
                      Re-issue admin code
                    </Btn>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </TableWrap>
      </SubSection>
    </Section>
  );
}

// =====================================================================
// OPERATOR — §1 account level indicators
// =====================================================================

interface AccountRow {
  userId: string;
  email: string | null;
  name: string | null;
  orgName: string | null;
  activated: boolean;
  level: string;
  createdAt: number;
}

function AccountsPanel(): JSX.Element {
  const { data, error } = useLoader<{ accounts: AccountRow[] }>('/v1/console/accounts');
  const accounts = data?.accounts ?? [];
  return (
    <Section title="Accounts" count={`${accounts.length}`}>
      <Wall>
        <b className="text-bb-teal">LEVEL INDICATOR.</b> Every account’s level is DERIVED, not stored as a label:
        DEV from users.platform_role, ADMIN / COORD from an active org membership, UNMARKED from neither. The same
        derivation decides what each account may do, so what you see here and what the server enforces cannot
        disagree.
      </Wall>
      {error ? <Deny>{error}</Deny> : null}
      <TableWrap>
        <thead>
          <tr>
            <Th>Account</Th>
            <Th>Level</Th>
            <Th>Organization</Th>
            <Th>Activated</Th>
            <Th>Created</Th>
          </tr>
        </thead>
        <tbody>
          {accounts.length === 0 ? (
            <EmptyRow colSpan={5}>No accounts.</EmptyRow>
          ) : (
            accounts.map((a) => (
              <tr key={a.userId} className="hover:bg-bb-elevated">
                <Td mono>{a.email ?? a.name ?? a.userId}</Td>
                <Td>
                  <Pill tone={LEVEL_TONE[a.level] ?? 'grey'}>{a.level}</Pill>
                </Td>
                <Td mono muted>
                  {a.orgName ?? '—'}
                </Td>
                <Td mono muted>
                  {a.activated ? 'yes' : 'no'}
                </Td>
                <Td mono muted>
                  {formatDate(a.createdAt)}
                </Td>
              </tr>
            ))
          )}
        </tbody>
      </TableWrap>
    </Section>
  );
}

// =====================================================================
// ALL LEVELS — codes, scoped by the server
// =====================================================================

interface CodeRow {
  code: string;
  role: string;
  orgId: string | null;
  orgName: string | null;
  issuedBy: string | null;
  usedCount: number;
  maxUses: number;
  expiresAt: number | null;
  status: string;
}

function CodesPanel({ me, notify }: { me: ConsoleMe; notify: (m: string) => void }): JSX.Element {
  const { data, error, reload } = useLoader<{ scope: string; codes: CodeRow[] }>('/v1/console/codes');
  const orgsLoader = useLoader<{ orgs: OrgRow[] }>('/v1/console/orgs', me.may.orgs);
  const [role, setRole] = useState<string>(me.may.issueRoles[0] ?? 'survivor');
  const [count, setCount] = useState('1');
  const [expiresInHours, setExpiresInHours] = useState('');
  const [orgId, setOrgId] = useState('');
  const [issued, setIssued] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codes = data?.codes ?? [];

  const title = me.level === 'operator' ? 'All access codes' : me.level === 'admin' ? 'Your org’s codes' : 'Codes you issued';

  async function issue(): Promise<void> {
    setFailure(null);
    setBusy(true);
    const res = await api<{ codes: string[]; message?: string }>('/v1/console/codes', {
      body: {
        role,
        count: Math.max(1, Math.min(25, Number(count) || 1)),
        // Omitted entirely when blank — the server reads "no expiry" from an absent
        // field, and sending 0 would be a different (and wrong) instruction.
        ...(Number(expiresInHours) > 0 ? { expiresInHours: Number(expiresInHours) } : {}),
        ...(me.level === 'operator' ? { orgId } : {}),
      },
    });
    setBusy(false);
    if (!res.ok || !res.data?.codes) {
      setFailure(res.data?.message ?? `Refused (${res.status}).`);
      return;
    }
    setIssued(res.data.codes);
    notify(`${res.data.codes.length} code${res.data.codes.length > 1 ? 's' : ''} issued.`);
    reload();
  }

  async function revoke(code: string): Promise<void> {
    const res = await api<{ revoked: boolean }>(`/v1/console/codes/${encodeURIComponent(code)}/revoke`, { body: {} });
    if (!res.ok) {
      notify(`Revoke refused (${res.status}).`);
      return;
    }
    notify(`${code} revoked. It can never be redeemed.`);
    reload();
  }

  return (
    <Section title={title} count={`${codes.length}`}>
      <SubSection title="Issue a code">
        <Wall>
          The role you may mint is authorised on the SERVER against your level — a coordinator asking for a
          coordinator code is refused, not hidden. <b className="text-bb-teal">Admin is never an enrollment code</b>{' '}
          for anyone, including DEV: admin exists only through the registration ceremony.
        </Wall>
        <div className="flex flex-wrap items-end gap-[10px] pt-1">
          {me.may.issueRoles.length > 1 ? (
            <Field label="Code type">
              <Select value={role} onChange={(e) => setRole(e.target.value)}>
                {me.may.issueRoles.map((r) => (
                  <option key={r} value={r}>
                    {r === 'survivor' ? 'Enrollment (survivor)' : 'Coordinator'}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {me.level === 'operator' ? (
            <Field label="Organization">
              <Select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                <option value="">Choose…</option>
                {(orgsLoader.data?.orgs ?? []).map((o) => (
                  <option key={o.orgId} value={o.orgId}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Quantity">
            <TextInput type="number" min={1} max={25} value={count} onChange={(e) => setCount(e.target.value)} />
          </Field>
          <Field label="Expires in (hours)">
            <TextInput
              type="number"
              min={1}
              value={expiresInHours}
              placeholder="never"
              onChange={(e) => setExpiresInHours(e.target.value)}
            />
          </Field>
          <Btn variant="primary" disabled={busy} onClick={() => void issue()}>
            {busy ? 'Issuing…' : 'Issue'}
          </Btn>
        </div>
        {failure ? <div className="mt-3"><Deny>{failure}</Deny></div> : null}
        {issued ? <NewCode label={`${issued.length} ${role} code${issued.length > 1 ? 's' : ''}`} codes={issued} /> : null}
      </SubSection>

      <SubSection title={me.level === 'coordinator' ? 'Only the codes you issued' : 'Code list'}>
        {error ? <Deny>{error}</Deny> : null}
        <TableWrap>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Type</Th>
              {me.level === 'operator' ? <Th>Org</Th> : null}
              <Th>Issued by</Th>
              <Th>Uses</Th>
              <Th>Expires</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {codes.length === 0 ? (
              <EmptyRow colSpan={me.level === 'operator' ? 8 : 7}>No codes yet.</EmptyRow>
            ) : (
              codes.map((c) => (
                <tr key={c.code} className="hover:bg-bb-elevated">
                  <Td>
                    <span className="select-all font-mono text-[13px] tracking-[0.08em] text-status-armed">{c.code}</span>
                  </Td>
                  <Td mono muted>
                    {c.role}
                  </Td>
                  {me.level === 'operator' ? (
                    <Td mono muted>
                      {c.orgName ?? '—'}
                    </Td>
                  ) : null}
                  <Td mono muted>
                    {c.issuedBy ?? '—'}
                  </Td>
                  <Td mono muted>
                    {c.usedCount} / {c.maxUses}
                  </Td>
                  {/* "Never" is the honest word for a null expiry — an em dash would read
                      as "unknown", and these codes genuinely do not expire unless asked to. */}
                  <Td mono muted>
                    {c.expiresAt ? formatDate(c.expiresAt) : 'never'}
                  </Td>
                  <Td>
                    <Pill tone={CODE_STATUS_TONE[c.status] ?? 'grey'}>{c.status}</Pill>
                  </Td>
                  <Td>
                    {c.status === 'active' ? (
                      <Btn small variant="danger" onClick={() => void revoke(c.code)}>
                        Revoke
                      </Btn>
                    ) : null}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </TableWrap>
      </SubSection>
    </Section>
  );
}

// =====================================================================
// ADMIN — seats
// =====================================================================

interface SeatRow {
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  status: string;
  level: string;
  removable: boolean;
}

function SeatsPanel({ notify }: { notify: (m: string) => void }): JSX.Element {
  const { data, error, reload } = useLoader<{ seats: SeatRow[]; adminCount: number; minAdmins: number }>(
    '/v1/console/seats',
  );
  const [invited, setInvited] = useState<string[] | null>(null);
  const seats = data?.seats ?? [];

  async function invite(): Promise<void> {
    const res = await api<{ registrationCode: string }>('/v1/console/seats/invite-admin', { body: {} });
    if (!res.ok || !res.data?.registrationCode) {
      notify(`Invite refused (${res.status}).`);
      return;
    }
    setInvited([res.data.registrationCode]);
    notify('Admin registration code issued. Deliver it out of band.');
  }

  async function setRole(userId: string, role: string): Promise<void> {
    const res = await api<{ message?: string }>(`/v1/console/seats/${userId}/role`, { body: { role } });
    notify(res.ok ? `Role changed to ${role}.` : (res.data?.message ?? `Refused (${res.status}).`));
    reload();
  }

  async function remove(userId: string): Promise<void> {
    const res = await api<{ message?: string }>(`/v1/console/seats/${userId}/remove`, { body: {} });
    notify(res.ok ? 'Seat removed. Access is revoked immediately.' : (res.data?.message ?? `Refused (${res.status}).`));
    reload();
  }

  return (
    <Section title="Seats & coordinators" count={`${seats.length} SEATS`}>
      <Wall>
        <b className="text-bb-teal">MINIMUM TWO ADMINS, ENFORCED SERVER-SIDE.</b> The server refuses to drop below
        two — by removal or by demotion, which are the same danger — so a departing admin can never strand the org.
        Removing a seat revokes access immediately: the next request from that account sees no membership.
      </Wall>
      <div className="mb-3 flex flex-wrap gap-[10px]">
        <Btn onClick={() => void invite()}>Invite an admin</Btn>
      </div>
      {invited ? <NewCode label="Admin registration code" codes={invited} /> : null}
      {error ? <Deny>{error}</Deny> : null}
      <TableWrap>
        <thead>
          <tr>
            <Th>Member</Th>
            <Th>Level</Th>
            <Th>Status</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {seats.length === 0 ? (
            <EmptyRow colSpan={4}>No seats yet.</EmptyRow>
          ) : (
            seats.map((s) => (
              <tr key={s.userId} className="hover:bg-bb-elevated">
                <Td mono>{s.name ?? s.email ?? s.userId}</Td>
                <Td>
                  <Pill tone={LEVEL_TONE[s.level] ?? 'grey'}>{s.level}</Pill>
                </Td>
                <Td>
                  <Pill tone={s.status === 'active' ? 'green' : 'grey'}>{s.status}</Pill>
                </Td>
                <Td>
                  <div className="flex justify-end gap-2">
                    <Btn small onClick={() => void setRole(s.userId, s.role === 'admin' ? 'coordinator' : 'admin')}>
                      Make {s.role === 'admin' ? 'coordinator' : 'admin'}
                    </Btn>
                    {s.removable ? (
                      <Btn small variant="danger" onClick={() => void remove(s.userId)}>
                        Remove
                      </Btn>
                    ) : (
                      <span
                        title="Minimum two admins enforced by the server"
                        className="self-center font-mono text-[9px] uppercase tracking-[0.1em] text-bb-text-tertiary"
                      >
                        Locked · min 2
                      </span>
                    )}
                  </div>
                </Td>
              </tr>
            ))
          )}
        </tbody>
      </TableWrap>
    </Section>
  );
}

// =====================================================================
// ADMIN + COORDINATOR — readiness roster
// =====================================================================

interface RosterRow {
  code: string;
  redeemedAt: number | null;
  state: string;
  confirmedContacts: number;
  activations30d: number;
}

function RosterPanel({ level }: { level: Level }): JSX.Element {
  const { data, error } = useLoader<{ roster: RosterRow[] }>('/v1/console/roster');
  const roster = data?.roster ?? [];
  return (
    <Section
      title={level === 'admin' ? 'Enrollments — org-wide' : 'Your enrollments'}
      count={`${roster.length}`}
    >
      <Wall>
        <b className="text-bb-teal">READINESS ONLY.</b> Enrollment code, redemption date, app state and confirmed
        contact count — the operational signals someone needs to help a person reach <i>Armed</i>. No name, no
        number, no location, no incident content. The server does not return them, so this page cannot show them.
      </Wall>
      {error ? <Deny>{error}</Deny> : null}
      <TableWrap>
        <thead>
          <tr>
            <Th>Enrollment code</Th>
            <Th>Redeemed</Th>
            <Th>App state</Th>
            <Th numeric>Confirmed contacts</Th>
            <Th numeric>Act·30d</Th>
          </tr>
        </thead>
        <tbody>
          {roster.length === 0 ? (
            <EmptyRow colSpan={5}>No enrollments yet.</EmptyRow>
          ) : (
            roster.map((r) => {
              const state = READINESS[r.state] ?? { tone: 'grey' as PillTone, label: r.state };
              return (
                <tr key={r.code} className="hover:bg-bb-elevated">
                  <Td>
                    <span className="font-mono text-[13px] tracking-[0.08em] text-status-armed">{r.code}</span>
                  </Td>
                  <Td mono muted>
                    {formatDate(r.redeemedAt)}
                  </Td>
                  <Td>
                    <Pill tone={state.tone}>{state.label}</Pill>
                  </Td>
                  <Td numeric>{r.confirmedContacts}</Td>
                  <Td numeric>{r.activations30d}</Td>
                </tr>
              );
            })
          )}
        </tbody>
      </TableWrap>
    </Section>
  );
}

// =====================================================================
// §3 MAINTENANCE — operator only
// =====================================================================

interface Health {
  ok: boolean;
  d1: { ok: boolean; ms: number; accounts: number | null; detail: string | null };
  r2: { ok: boolean; ms: number; detail: string | null };
  currency: { worker: string; pwa: string | null; matched: boolean };
  migrations: { ok: boolean; appliedCount: number | null; latestApplied: string | null; expectedCount: number; pending: string[]; detail: string | null };
}

function HealthRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }): JSX.Element {
  return (
    <tr className="hover:bg-bb-elevated">
      <Td mono>{label}</Td>
      <Td>
        <Pill tone={ok ? 'green' : 'red'}>{ok ? 'OK' : 'FAIL'}</Pill>
      </Td>
      <Td mono muted>
        {detail}
      </Td>
    </tr>
  );
}

function MaintenancePanel({ notify }: { notify: (m: string) => void }): JSX.Element {
  const health = useLoader<Health>('/v1/console/maintenance/health');
  const audit = useLoader<{ entries: Array<{ action: string; at: number; actor: string | null; metadata: string | null }> }>(
    '/v1/console/maintenance/audit',
  );
  const [purge, setPurge] = useState<Record<string, unknown> | null>(null);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [target, setTarget] = useState('');
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const h = health.data;

  async function runPurge(confirm: boolean): Promise<void> {
    setPurgeBusy(true);
    const res = await api<Record<string, unknown>>('/v1/console/maintenance/purge-media', { body: { confirm } });
    setPurgeBusy(false);
    setPurge(res.data);
    notify(confirm ? 'Purge executed.' : 'Dry run complete — nothing was deleted.');
    if (confirm) audit.reload();
  }

  async function previewDelete(): Promise<void> {
    const res = await api<Record<string, unknown>>('/v1/console/maintenance/delete-account', {
      body: { email: target.trim() },
    });
    setPreview(res.ok ? res.data : { error: `Refused (${res.status})` });
  }

  async function confirmDelete(): Promise<void> {
    const reason = window.prompt('Reason for deleting this account (required, logged, irreversible):');
    if (!reason?.trim()) return;
    const res = await api<Record<string, unknown>>('/v1/console/maintenance/delete-account', {
      body: { email: target.trim(), confirm: true, reason: reason.trim() },
    });
    setPreview(res.data);
    notify(res.ok ? 'Account deleted, including its R2 captures.' : `Refused (${res.status}).`);
    audit.reload();
  }

  return (
    <Section title="Maintenance" count="DEV ONLY">
      <Wall>
        <b className="text-bb-teal">EVERY ACTION AUDITED TO A PERSON.</b> Operator is an identity, not a token, so
        “who purged R2?” has an answer. Destructive actions are dry-run by default: you see the count first and the
        deletion is a second, explicit press.
      </Wall>

      <SubSection title="System health">
        {health.error ? <Deny>{health.error}</Deny> : null}
        {h ? (
          <TableWrap>
            <thead>
              <tr>
                <Th>Check</Th>
                <Th>State</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              <HealthRow label="D1" ok={h.d1.ok} detail={h.d1.detail ?? `${h.d1.accounts} accounts · ${h.d1.ms}ms`} />
              <HealthRow label="R2 (media)" ok={h.r2.ok} detail={h.r2.detail ?? `reachable · ${h.r2.ms}ms`} />
              <HealthRow
                label="Currency (Pages == Worker)"
                ok={h.currency.matched}
                detail={`worker ${h.currency.worker} · pwa ${h.currency.pwa ?? 'unreachable'}`}
              />
              <HealthRow
                label="Migrations"
                ok={h.migrations.ok}
                detail={
                  h.migrations.detail ??
                  (h.migrations.pending.length
                    ? `PENDING: ${h.migrations.pending.join(', ')}`
                    : `${h.migrations.appliedCount}/${h.migrations.expectedCount} applied · latest ${h.migrations.latestApplied}`)
                }
              />
            </tbody>
          </TableWrap>
        ) : (
          <p className="font-mono text-[11px] text-bb-text-tertiary">Checking…</p>
        )}
        <div className="mt-3">
          <Btn small onClick={health.reload}>
            Re-check
          </Btn>
        </div>
      </SubSection>

      <SubSection title="R2 orphan purge" defaultOpen={false}>
        <Wall>
          Deletes only objects that are BOTH older than the cutoff taken at invocation AND unreferenced by the chunk
          index. It leaves nothing scheduled: when it finishes, no rule anywhere is set to delete anything later.
        </Wall>
        <div className="flex flex-wrap gap-[10px]">
          <Btn disabled={purgeBusy} onClick={() => void runPurge(false)}>
            {purgeBusy ? 'Working…' : 'Dry run'}
          </Btn>
          <Btn variant="danger" disabled={purgeBusy || !purge} onClick={() => void runPurge(true)}>
            Confirm delete
          </Btn>
        </div>
        {purge ? (
          <pre className="mt-3 overflow-x-auto border border-bb-border-subtle bg-bb-bg p-3 font-mono text-[11px] text-bb-text-secondary">
            {JSON.stringify(purge, null, 2)}
          </pre>
        ) : null}
      </SubSection>

      <SubSection title="Account deletion" defaultOpen={false}>
        <Wall>
          The cascading delete: the R2 bytes go BEFORE the index rows that name them. Reversing that order is how
          ~10,700 recordings were stranded — un-enumerable because the only thing naming them had been removed.
        </Wall>
        <div className="flex flex-wrap items-end gap-[10px]">
          <Field label="Account email">
            <TextInput value={target} onChange={(e) => setTarget(e.target.value)} placeholder="someone@example.com" />
          </Field>
          <Btn disabled={!target.trim()} onClick={() => void previewDelete()}>
            Preview
          </Btn>
          <Btn variant="danger" disabled={!preview} onClick={() => void confirmDelete()}>
            Confirm delete
          </Btn>
        </div>
        {preview ? (
          <pre className="mt-3 overflow-x-auto border border-bb-border-subtle bg-bb-bg p-3 font-mono text-[11px] text-bb-text-secondary">
            {JSON.stringify(preview, null, 2)}
          </pre>
        ) : null}
      </SubSection>

      <SubSection title="Audit — who did what, when" defaultOpen={false}>
        <TableWrap>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Action</Th>
              <Th>Actor</Th>
              <Th>Detail</Th>
            </tr>
          </thead>
          <tbody>
            {(audit.data?.entries ?? []).length === 0 ? (
              <EmptyRow colSpan={4}>No console actions recorded yet.</EmptyRow>
            ) : (
              (audit.data?.entries ?? []).map((e, i) => (
                <tr key={`${e.at}-${i}`} className="hover:bg-bb-elevated">
                  <Td mono muted>
                    {new Date(e.at).toISOString().replace('T', ' ').slice(0, 19)}
                  </Td>
                  <Td mono>{e.action.replace('console.', '')}</Td>
                  <Td mono muted>
                    {e.actor ?? '—'}
                  </Td>
                  <Td mono muted>
                    {e.metadata ?? '—'}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </TableWrap>
      </SubSection>
    </Section>
  );
}

// =====================================================================
// THE WALL — real probes, real refusals. Not a screenshot.
// =====================================================================

interface Probe {
  label: string;
  request: string;
  run: () => Promise<{ status: number; body: unknown }>;
  expectation: string;
}

function BoundaryPanel({ me }: { me: ConsoleMe }): JSX.Element {
  const [result, setResult] = useState<{ probe: Probe; status: number; body: unknown } | null>(null);

  const probes: Probe[] = [
    {
      label: 'Any level → mint an admin code',
      request: 'POST /v1/console/codes { role: "admin" }',
      expectation:
        'Refused for every level, DEV included. Admin is not an enrollment code — it exists only through the registration ceremony.',
      run: async () => {
        const res = await api('/v1/console/codes', { body: { role: 'admin' } });
        return { status: res.status, body: res.data };
      },
    },
    {
      label: 'Any level → open incident content',
      request: 'GET /v1/console/incidents/content',
      expectation:
        'There is no such route. No console level — DEV included — has any endpoint that returns a capture, a transcript, a location or a case file.',
      run: async () => {
        const res = await api('/v1/console/incidents/content');
        return { status: res.status, body: res.data };
      },
    },
    {
      label: 'Reach an organization outside your scope',
      request: 'GET /v1/console/orgs/00000000-0000-0000-0000-000000000000/admin-codes',
      expectation:
        me.level === 'operator'
          ? 'You are DEV — the one level that crosses org boundaries by design. This answers, and returns nothing, because that org does not exist.'
          : 'Refused. Your org comes from your session; an operator route is not reachable at all, whatever id is in the URL.',
      run: async () => {
        const res = await api('/v1/console/orgs/00000000-0000-0000-0000-000000000000/admin-codes');
        return { status: res.status, body: res.data };
      },
    },
  ];

  return (
    <Section title="The wall" count="TRY IT" defaultOpen={false}>
      <p className="mb-[14px] max-w-[74ch] text-[13px] text-bb-text-secondary">
        The separation is enforced on the server, not by hiding controls. These buttons send REAL requests from your
        real session and print the REAL answer — status and body, unedited.
      </p>
      <div className="mb-[14px] flex flex-wrap gap-[10px]">
        {probes.map((p) => (
          <Btn
            key={p.request}
            onClick={() => void p.run().then((r) => setResult({ probe: p, ...r }))}
          >
            {p.label}
          </Btn>
        ))}
      </div>
      {result ? (
        result.status >= 400 ? (
          <Deny>
            <b>{result.probe.request}</b>
            <br />
            <span className="text-bb-text-secondary">{result.probe.expectation}</span>
            <br />
            <br />
            {result.status} — {JSON.stringify(result.body)}
          </Deny>
        ) : (
          <div className="border border-bb-border-subtle border-l-2 border-l-bb-teal bg-[#0d0f0e] px-4 py-3 font-mono text-[11px] leading-[1.7] text-bb-text-secondary">
            <b className="text-bb-teal">{result.probe.request}</b>
            <br />
            {result.probe.expectation}
            <br />
            <br />
            {result.status} — {JSON.stringify(result.body)}
          </div>
        )
      ) : null}
    </Section>
  );
}

// =====================================================================
// THE SHELL
// =====================================================================

const METRIC_LABEL: Record<string, string> = {
  organizations: 'Organizations',
  enrolled: 'Total enrolled',
  activations30d: 'Activations · 30d',
  openCodes: 'Open codes',
  seatsUsed: 'Seats used',
  seatsTotal: 'Seat cap',
  coordinators: 'Coordinators',
  codesIssued: 'Codes issued by you',
  enrollments: 'Your enrollments',
  notReady: 'Not ready',
};

function ConsoleShell({ me, onSignOut }: { me: ConsoleMe; onSignOut: () => void }): JSX.Element {
  const { data: overview } = useLoader<Overview>('/v1/console/overview');
  const [toast, setToast] = useState<string | null>(null);
  const notify = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const metrics = Object.entries(overview?.metrics ?? {})
    .filter(([k]) => k !== 'seatsTotal')
    .slice(0, 4);

  return (
    <div className="min-h-full bg-bb-bg text-bb-text">
      <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-4 border-b border-bb-border-subtle bg-bb-bg px-6 py-[14px]">
        <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-bb-text-secondary">
          <b className="text-bb-text">BLACK BOX</b> <span className="text-status-armed">■</span> CONSOLE
        </div>
        <div className="flex items-center gap-4">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-bb-text-tertiary">
            Signed in as <b className="font-medium text-bb-text-secondary">{me.displayName ?? me.userId}</b> ·{' '}
            <b className="font-medium text-status-armed">{me.levelLabel}</b>
          </span>
          <Btn small onClick={onSignOut}>
            Sign out
          </Btn>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3 border-b border-bb-border-subtle bg-bb-surface px-6 py-[10px] font-mono text-[10px] uppercase tracking-[0.14em] text-bb-text-secondary">
        <span className="h-[7px] w-[7px] flex-none rounded-full bg-status-armed" />
        <span>Scope</span>
        <span className="text-bb-text">
          {me.level === 'operator' ? 'System-wide — all organizations' : `Org — ${me.orgName ?? me.orgId ?? 'none'}`}
        </span>
        <span className="ml-auto text-bb-teal">
          🔒 {me.level === 'operator' ? 'DEV — full scope' : 'Scoped to your org — server-enforced'}
        </span>
      </div>

      <main className="mx-auto max-w-[1180px] px-6 pb-20 pt-7">
        <h1 className="mb-1 font-display text-[30px] font-bold tracking-[-0.01em]">{me.levelLabel}</h1>
        <p className="mb-6 max-w-[74ch] text-[13px] text-bb-text-secondary">
          {me.level === 'operator'
            ? 'Full system view. Vet and create organizations, issue admin codes, and watch platform health. The only level that crosses org boundaries — and it still cannot read incident content.'
            : me.level === 'admin'
              ? 'Your organization only. Manage seats, issue coordinator and enrollment codes, and see every code and enrollment under your org.'
              : 'Your organization only. Issue enrollment codes and track the enrollments you personally issued.'}
        </p>

        {metrics.length > 0 ? (
          <div className="mb-7 grid grid-cols-2 gap-3 md:grid-cols-4">
            {metrics.map(([k, v]) => (
              <Metric
                key={k}
                label={METRIC_LABEL[k] ?? k}
                value={
                  k === 'seatsUsed' && overview?.metrics.seatsTotal != null ? (
                    <>
                      {v}
                      <small className="text-base font-medium text-bb-text-tertiary"> / {overview.metrics.seatsTotal}</small>
                    </>
                  ) : (
                    v
                  )
                }
                tone={k === 'activations30d' ? 'warn' : k === 'notReady' ? (v > 0 ? 'hot' : 'ok') : undefined}
              />
            ))}
          </div>
        ) : null}

        {me.may.orgs ? <OrgsPanel notify={notify} /> : null}
        {me.may.seats ? <SeatsPanel notify={notify} /> : null}
        {me.may.codes ? <CodesPanel me={me} notify={notify} /> : null}
        {me.may.roster ? <RosterPanel level={me.level} /> : null}
        {me.may.accounts ? <AccountsPanel /> : null}
        {me.may.maintenance ? <MaintenancePanel notify={notify} /> : null}
        <BoundaryPanel me={me} />

        <div className="mt-11 border-t border-bb-border-subtle pt-4 font-mono text-[10px] uppercase leading-[1.9] tracking-[0.08em] text-bb-text-tertiary">
          <b className="font-medium text-bb-teal">Data custody.</b> This console shows operational counters only —
          enrollments, code status, activation counts.
          <br />
          Incident records belong to the survivor. No level here — DEV included — can view, unlock or export incident
          content.
          <br />
          Enrollees appear as an enrollment code only. No names, no numbers, no locations.
        </div>
      </main>
      <Toast message={toast} />
    </div>
  );
}

// =====================================================================
// ENTRY — passwordless sign-in, then the server decides what this is
// =====================================================================

function SignInShell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }): JSX.Element {
  return (
    <main className="flex min-h-full w-full flex-col items-center justify-center bg-bb-bg p-8 text-bb-text">
      <div className="w-full max-w-sm">
        <div className="mb-6 font-mono text-[11px] uppercase tracking-[0.18em] text-bb-text-secondary">
          <b className="text-bb-text">BLACK BOX</b> <span className="text-status-armed">■</span> CONSOLE
        </div>
        <h1 className="mb-2 font-display text-[24px] font-bold">{title}</h1>
        {subtitle ? <p className="mb-6 text-[13px] text-bb-text-secondary">{subtitle}</p> : null}
        {children}
      </div>
    </main>
  );
}

type Phase = 'loading' | 'signin' | 'console' | 'no-access';
type Pane = 'choose' | 'email-link' | 'sent' | 'recovery';

export function Console(): JSX.Element {
  const [phase, setPhase] = useState<Phase>(getSessionToken() ? 'loading' : 'signin');
  const [me, setMe] = useState<ConsoleMe | null>(null);
  const [pane, setPane] = useState<Pane>('choose');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = passkeySupported();

  const checkLevel = useCallback(async (): Promise<void> => {
    const res = await api<ConsoleMe>('/v1/console/me');
    // UNMARKED is not a console user. The server still answers /me — it must, or nobody
    // could be told why they are not here — but every other route refuses them.
    if (res.ok && res.data && res.data.level !== 'unmarked') {
      setMe(res.data);
      setPhase('console');
    } else {
      setPhase(res.status === 401 ? 'signin' : 'no-access');
    }
  }, []);

  useEffect(() => {
    if (getSessionToken()) void checkLevel();
  }, [checkLevel]);

  async function land(sessionToken: string, displayMode: DisplayMode): Promise<void> {
    setSession(sessionToken, displayMode, { name: '', email: email.trim() });
    setPhase('loading');
    await checkLevel();
  }

  async function signInWithPasskey(): Promise<void> {
    setError(null);
    setBusy(true);
    const result = await loginWithPasskey();
    setBusy(false);
    if (result.ok) {
      await land(result.data.sessionToken, result.data.displayMode);
      return;
    }
    if (result.reason === 'cancelled') return;
    setError(
      result.reason === 'unsupported'
        ? 'This device can’t use a passkey. Use an email link instead.'
        : 'That didn’t work. Try again, or use an email link.',
    );
  }

  async function sendLink(): Promise<void> {
    setError(null);
    setBusy(true);
    await api('/v1/auth/magic/start', { auth: false, body: { email: email.trim() } });
    setBusy(false);
    setPane('sent');
  }

  async function redeemRecoveryCode(): Promise<void> {
    setError(null);
    setBusy(true);
    const res = await api<{ sessionToken: string; displayMode: DisplayMode }>('/v1/auth/recovery/consume', {
      auth: false,
      body: { email: email.trim(), code },
    });
    setBusy(false);
    if (!res.ok || !res.data?.sessionToken) {
      setError(res.status === 0 ? 'No connection — check your signal and try again.' : 'That code didn’t work. Each code can be used once.');
      return;
    }
    await land(res.data.sessionToken, res.data.displayMode);
  }

  function signOut(): void {
    clearSession();
    setMe(null);
    setPane('choose');
    setPhase('signin');
  }

  if (phase === 'loading') {
    return (
      <SignInShell title="Console">
        <p className="font-mono text-[11px] text-bb-text-tertiary">Checking access…</p>
      </SignInShell>
    );
  }

  if (phase === 'console' && me) {
    return <ConsoleShell me={me} onSignOut={signOut} />;
  }

  if (phase === 'no-access') {
    return (
      <SignInShell title="No console access" subtitle="This account holds no console level.">
        <p className="mb-6 text-[13px] leading-relaxed text-bb-text-secondary">
          The console is for operators and for organisation staff. If your organisation is part of the pilot, ask your
          admin for a coordinator code and redeem it in your own account first.
        </p>
        <Btn onClick={signOut}>Sign out</Btn>
      </SignInShell>
    );
  }

  if (pane === 'sent') {
    return (
      <SignInShell title="Check your email" subtitle="If that address has an account, a sign-in link is on its way.">
        <p className="mb-6 text-[13px] leading-relaxed text-bb-text-secondary">
          The link works once and expires in 15 minutes. After it signs you in, return to /console.
        </p>
        <Btn onClick={() => setPane('choose')}>Back</Btn>
      </SignInShell>
    );
  }

  if (pane === 'email-link' || pane === 'recovery') {
    const recovery = pane === 'recovery';
    return (
      <SignInShell
        title={recovery ? 'Use a recovery code' : 'Sign in by email'}
        subtitle={recovery ? 'The code you saved when you set up.' : 'We’ll send a one-tap link. No password.'}
      >
        <div className="mb-4">
          <TextInput
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            className="w-full"
          />
        </div>
        {recovery ? (
          <div className="mb-4">
            <TextInput
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoCapitalize="characters"
              placeholder="XXXX-XXXX-XXXX"
              className="w-full tracking-[0.1em]"
            />
          </div>
        ) : null}
        {error ? <p className="mb-3 font-mono text-[11px] text-status-active">{error}</p> : null}
        <Btn
          variant="primary"
          className="w-full py-3"
          disabled={busy || !email.includes('@') || (recovery && code.trim().length < 8)}
          onClick={() => void (recovery ? redeemRecoveryCode() : sendLink())}
        >
          {busy ? 'Working…' : recovery ? 'Sign in' : 'Send me a link'}
        </Btn>
        <button
          onClick={() => setPane('choose')}
          className="mt-4 block w-full text-center font-mono text-[11px] text-bb-text-tertiary underline"
        >
          Back
        </button>
      </SignInShell>
    );
  }

  return (
    <SignInShell title="Console sign-in" subtitle="For operators and organisation staff.">
      <Btn
        variant="primary"
        className="w-full py-3"
        disabled={busy}
        onClick={() => void (supported ? signInWithPasskey() : setPane('email-link'))}
      >
        {busy ? 'Waiting…' : supported ? 'Sign in with passkey' : 'Sign in by email'}
      </Btn>
      {error ? <p className="mt-3 font-mono text-[11px] text-status-active">{error}</p> : null}
      {supported ? (
        <button
          onClick={() => setPane('email-link')}
          className="mt-4 block w-full text-center font-mono text-[11px] text-bb-text-tertiary underline"
        >
          Use an email link instead
        </button>
      ) : null}
      <button
        onClick={() => setPane('recovery')}
        className="mt-3 block w-full text-center font-mono text-[11px] text-bb-text-tertiary underline"
      >
        Use a recovery code
      </button>
    </SignInShell>
  );
}
