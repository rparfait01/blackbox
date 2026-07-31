/**
 * Console UI primitives (Brief 33b), drawn from docs/BLACKBOX_dashboard_mockup.html.
 *
 * The mockup's palette is not invented — it is the `bb` / `status` instrument tokens
 * already in tailwind.config.ts, which is why this reads as the same product rather than
 * a second design language. Nothing here is survivor-facing: the console lives behind a
 * login on its own path and never renders in the Hidden facade (§0a).
 *
 * These are presentation only. Every one of them renders data the SERVER already decided
 * the caller may see — none of them is a permission check, and none should ever become
 * one. A hidden button is not a boundary.
 */
import type { ReactNode } from 'react';

export type PillTone = 'amber' | 'green' | 'red' | 'grey' | 'teal';

const PILL_TONE: Record<PillTone, string> = {
  amber: 'text-status-armed border-status-armed',
  green: 'text-status-ack border-status-ack',
  red: 'text-status-active border-status-active',
  grey: 'text-bb-text-tertiary border-bb-border-defined',
  teal: 'text-bb-teal border-bb-teal',
};

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }): JSX.Element {
  return (
    <span
      className={`inline-block whitespace-nowrap border px-2 py-[2px] font-mono text-[9px] uppercase tracking-[0.1em] ${PILL_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

export function Btn({
  variant = 'default',
  small,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger';
  small?: boolean;
}): JSX.Element {
  const tone =
    variant === 'primary'
      ? 'bg-status-armed text-bb-bg border-status-armed font-bold'
      : variant === 'danger'
        ? 'bg-transparent text-status-active border-status-active'
        : 'bg-bb-elevated text-bb-text border-bb-border-defined hover:border-bb-text-secondary';
  return (
    <button
      {...props}
      className={`whitespace-nowrap border font-mono uppercase tracking-[0.12em] disabled:cursor-not-allowed disabled:opacity-40 ${
        small ? 'px-[10px] py-1 text-[9px]' : 'px-[14px] py-[7px] text-[10px]'
      } ${tone} ${className}`}
    />
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-[5px]">
      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-bb-text-secondary">{label}</span>
      {children}
    </label>
  );
}

const INPUT =
  'min-w-[170px] border border-bb-border-defined bg-bb-elevated px-[10px] py-[7px] text-[13px] text-bb-text outline-none focus:border-status-armed';

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return <input {...props} className={`${INPUT} ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  return <select {...props} className={`${INPUT} ${props.className ?? ''}`} />;
}

/** A collapsible section, matching the mockup's <details> blocks. */
export function Section({
  title,
  count,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: string | number | null;
  defaultOpen?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <details open={defaultOpen} className="mb-4 border border-bb-border-subtle bg-bb-surface">
      <summary className="flex cursor-pointer select-none list-none items-center gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <span className="font-display text-[17px] font-semibold tracking-[0.01em]">{title}</span>
        {count != null && count !== '' ? (
          <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.1em] text-bb-text-tertiary">
            {count}
          </span>
        ) : null}
      </summary>
      <div className="px-5 pb-5">{children}</div>
    </details>
  );
}

/** A nested block inside a Section (the mockup's sub-details). */
export function SubSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <details open={defaultOpen} className="mb-3 border border-bb-border-subtle bg-bb-bg">
      <summary className="flex cursor-pointer select-none list-none items-center gap-[10px] px-[14px] py-3 [&::-webkit-details-marker]:hidden">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-bb-text-secondary">
          {title}
        </span>
      </summary>
      <div className="px-[14px] pb-[14px]">{children}</div>
    </details>
  );
}

/** The explanatory rail — states the rule the server is enforcing, in plain words. */
export function Wall({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="my-[14px] border border-bb-border-subtle border-l-2 border-l-bb-teal bg-[#0d0f0e] px-4 py-3 font-mono text-[10px] leading-[1.7] tracking-[0.06em] text-bb-text-secondary">
      {children}
    </div>
  );
}

/** A server refusal, shown verbatim. Never a paraphrase — the status and error are real. */
export function Deny({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-start gap-3 border border-status-active border-l-2 border-l-status-active bg-[#140a0a] px-4 py-[14px] font-mono text-[11px] leading-[1.7] tracking-[0.05em] text-status-active">
      <span className="text-base leading-none">✕</span>
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

export function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: 'warn' | 'hot' | 'ok';
}): JSX.Element {
  const color = tone === 'warn' ? 'text-status-armed' : tone === 'hot' ? 'text-status-active' : tone === 'ok' ? 'text-status-ack' : '';
  return (
    <div className="border border-bb-border-subtle bg-bb-surface p-4">
      <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.14em] text-bb-text-secondary">{label}</div>
      <div className={`font-display text-[34px] font-bold leading-none ${color}`}>{value}</div>
    </div>
  );
}

/** Tables scroll inside their own container so the page body never scrolls sideways. */
export function TableWrap({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">{children}</table>
    </div>
  );
}

export function Th({ children, numeric }: { children?: ReactNode; numeric?: boolean }): JSX.Element {
  return (
    <th
      className={`whitespace-nowrap border-b border-bb-border-defined px-[10px] py-[9px] font-mono text-[9px] uppercase tracking-[0.12em] text-bb-text-tertiary ${
        numeric ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  mono,
  muted,
  numeric,
}: {
  children?: ReactNode;
  mono?: boolean;
  muted?: boolean;
  numeric?: boolean;
}): JSX.Element {
  return (
    <td
      className={`border-b border-bb-border-subtle px-[10px] py-[11px] align-middle ${
        mono || numeric ? 'font-mono text-[12px] tracking-[0.04em]' : ''
      } ${muted ? 'text-bb-text-tertiary' : ''} ${numeric ? 'text-right' : ''}`}
    >
      {children}
    </td>
  );
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }): JSX.Element {
  return (
    <tr>
      <td colSpan={colSpan} className="px-[10px] py-5 font-mono text-[12px] text-bb-text-tertiary">
        {children}
      </td>
    </tr>
  );
}

/** A freshly minted code. Shown once, large, and copyable — it is delivered out of band. */
export function NewCode({ label, codes }: { label: string; codes: string[] }): JSX.Element {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 border border-dashed border-status-armed bg-[#14100a] px-[14px] py-3 font-mono text-[13px] tracking-[0.1em] text-status-armed">
      <span className="text-[9px] uppercase tracking-[0.14em] text-bb-text-secondary">{label}</span>
      {codes.map((c) => (
        <b key={c} className="select-all">
          {c}
        </b>
      ))}
    </div>
  );
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}
