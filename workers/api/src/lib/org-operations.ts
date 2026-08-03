import type { Env } from '../types';

/**
 * Brief 23 Fix A §C/§E — PER-ORG INVENTORY, EXPORT, AND TERMINATION DELETION.
 *
 * ═══ THE PROBLEM THESE SOLVE IS OPERATIONS, NOT ACCESS ════════════════════════════════════════
 *
 * Nobody can reach another org's data — Brief 23's server-side scoping holds. What nobody could do
 * is ACCOUNT for an org's data. "What of ours do you hold?", "give it to us", and "delete it, we
 * are terminating" are the three questions an institutional buyer's counsel asks, a DPA commits
 * to answering, and this file is the answer to.
 *
 * ═══ NULL IS NOT A TENANT (§F1) — THE DEFECT THIS FILE IS BUILT TO AVOID ══════════════════════
 *
 * Every query here matches `orgId = ?` and NEVER anything shaped like "not the other org".
 * That distinction is the whole risk of a nullable tenant column, and it fails in both directions:
 *
 *   `WHERE orgId != 'orgB'`   — in SQL this is NULL for unaffiliated rows, so the comparison is
 *                               not true and they vanish from a report that claims to be complete.
 *   `WHERE orgId IS NOT 'orgB'` (or a NULL-tolerant equivalent, or a JS filter on `!== 'orgB'`)
 *                             — sweeps in EVERY unaffiliated consumer on the platform. In an
 *                               inventory that is a privacy breach; in a deletion it is
 *                               catastrophic and irreversible.
 *
 * So: positive match only. An unaffiliated survivor is invisible to every function here, which is
 * exactly right — she belongs to no org, so no org may inventory, export, or delete her.
 *
 * ═══ §E — WHAT DELETION TOUCHES, DECIDED UP FRONT ═════════════════════════════════════════════
 *
 * Two buckets with different rules, and the deletion routine is scoped to the right one from the
 * outset rather than discovering the lock at acceptance:
 *
 *   blackbox-media  — recordings. Deletable. REMOVED by termination.
 *   blackbox-vault  — signed custody manifests under a 1096-day retention lock (Brief 40). A
 *                     bucket cannot be emptied while lock rules are configured, and that is
 *                     CORRECT rather than an obstacle: the custody chain is never purged, only
 *                     the objects it attests to. RETAINED.
 *
 * The customer-facing commitment says exactly this: recordings and records are deleted; the
 * signed proof that they existed is retained for the stated period. Export reads
 * PURGED_BY_CONSENT afterwards, the same recorded path as an owner-consented purge.
 */

/** Tables carrying org attribution, and how each reaches its rows. */
const ATTRIBUTED_TABLES = [
  'chunks_index',
  'integrity_records',
  'integrity_heads',
  'vault_objects',
  'custody_transfers',
  'delivery_records',
  'wrapped_keys',
  'plaintext_commitments',
  'audit_log',
  'contacts',
] as const;

export interface OrgInventory {
  orgId: string;
  orgName: string | null;
  accounts: number;
  events: number;
  tables: Record<string, number>;
  mediaObjects: number;
  vaultObjects: number;
  totalRows: number;
  /** Stated so a reader never mistakes this for a platform-wide count. */
  scope: string;
}

/**
 * What do we hold for this org?
 *
 * Counts only. No name, no number, no location, no content — the roster rule from Brief 33 applies
 * here too: an inventory is for accounting, and an accounting surface that leaks survivor content
 * is a worse breach than the gap it closed.
 */
export async function orgInventory(env: Env, orgId: string): Promise<OrgInventory> {
  const org = await env.DB.prepare('SELECT name FROM organizations WHERE id = ?')
    .bind(orgId)
    .first<{ name: string }>();

  const tables: Record<string, number> = {};
  let totalRows = 0;
  for (const table of ATTRIBUTED_TABLES) {
    try {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE orgId = ?`)
        .bind(orgId)
        .first<{ n: number }>();
      const n = Number(row?.n ?? 0);
      tables[table] = n;
      totalRows += n;
    } catch {
      // A table that does not exist in this environment is reported as absent rather than
      // silently counted as zero — those are different facts.
      tables[table] = -1;
    }
  }

  const accounts = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE orgId = ?')
    .bind(orgId)
    .first<{ n: number }>();
  const events = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE orgId = ?')
    .bind(orgId)
    .first<{ n: number }>();
  const media = await env.DB.prepare('SELECT COUNT(*) AS n FROM chunks_index WHERE orgId = ?')
    .bind(orgId)
    .first<{ n: number }>();
  const vault = await env.DB.prepare('SELECT COUNT(*) AS n FROM vault_objects WHERE orgId = ?')
    .bind(orgId)
    .first<{ n: number }>();

  return {
    orgId,
    orgName: org?.name ?? null,
    accounts: Number(accounts?.n ?? 0),
    events: Number(events?.n ?? 0),
    tables,
    mediaObjects: Number(media?.n ?? 0),
    vaultObjects: Number(vault?.n ?? 0),
    totalRows,
    scope:
      `Rows matching orgId = '${orgId}' only. Unaffiliated accounts (orgId NULL) are NOT included ` +
      'and are not this org’s data; neither are any other org’s rows.',
  };
}

export interface OrgDeletion {
  orgId: string;
  dryRun: boolean;
  /** Rows deleted per table (or that WOULD be, on a dry run). */
  deleted: Record<string, number>;
  mediaObjectsDeleted: number;
  /** Always retained. Named explicitly so the caller cannot read silence as removal. */
  vaultObjectsRetained: number;
  vaultRetentionNote: string;
  accountsUnbound: number;
  eventsDeleted: number;
  errors: string[];
}

/**
 * Contract-termination deletion for ONE org.
 *
 * DRY RUN BY DEFAULT, following the existing maintenance routines: `confirm: true` is required to
 * remove anything. Media bytes go BEFORE the index rows that name them — deleting the rows first
 * is how ~10,700 orphaned recordings were created once, because nothing was left pointing at the
 * objects.
 */
export async function deleteOrgData(
  env: Env,
  orgId: string,
  opts: { confirm?: boolean; maxObjects?: number } = {},
): Promise<OrgDeletion> {
  const dryRun = opts.confirm !== true;
  const maxObjects = Math.min(Math.max(opts.maxObjects ?? 1000, 1), 5000);
  const errors: string[] = [];
  const deleted: Record<string, number> = {};

  // Guard the input before it reaches a DELETE. An empty or non-string orgId in a `WHERE orgId = ?`
  // matches nothing rather than everything, but relying on that is one refactor away from disaster.
  if (typeof orgId !== 'string' || orgId.trim().length === 0) {
    return {
      orgId: String(orgId),
      dryRun: true,
      deleted: {},
      mediaObjectsDeleted: 0,
      vaultObjectsRetained: 0,
      vaultRetentionNote: 'no deletion attempted — orgId was empty',
      accountsUnbound: 0,
      eventsDeleted: 0,
      errors: ['refused: empty orgId'],
    };
  }

  const vaultCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM vault_objects WHERE orgId = ?')
    .bind(orgId)
    .first<{ n: number }>();

  // ── 1. MEDIA BYTES FIRST ───────────────────────────────────────────────────────────────────
  const chunkRows = await env.DB.prepare(
    'SELECT r2Key FROM chunks_index WHERE orgId = ? AND r2Key IS NOT NULL LIMIT ?',
  )
    .bind(orgId, maxObjects)
    .all<{ r2Key: string }>();
  let mediaObjectsDeleted = 0;
  if (!dryRun) {
    for (const row of chunkRows.results ?? []) {
      try {
        await env.MEDIA.delete(row.r2Key);
        mediaObjectsDeleted += 1;
      } catch (err) {
        errors.push(`media ${row.r2Key}: ${String(err).slice(0, 80)}`);
      }
    }
  } else {
    mediaObjectsDeleted = (chunkRows.results ?? []).length;
  }

  // ── 2. THE D1 ROWS ─────────────────────────────────────────────────────────────────────────
  //
  // vault_objects rows are RETAINED alongside their objects. Deleting the index while the sealed
  // manifest survives under the retention lock would leave a manifest nothing can find — the
  // orphan shape again, in the one bucket that cannot be swept.
  for (const table of ATTRIBUTED_TABLES) {
    if (table === 'vault_objects') continue;
    try {
      const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE orgId = ?`)
        .bind(orgId)
        .first<{ n: number }>();
      deleted[table] = Number(count?.n ?? 0);
      if (!dryRun && deleted[table] > 0) {
        await env.DB.prepare(`DELETE FROM ${table} WHERE orgId = ?`).bind(orgId).run();
      }
    } catch (err) {
      errors.push(`${table}: ${String(err).slice(0, 80)}`);
      deleted[table] = -1;
    }
  }

  // ── 3. EVENTS AND ACCOUNT BINDING ──────────────────────────────────────────────────────────
  //
  // Accounts are UNBOUND (orgId set to NULL), never deleted. Terminating a shelter's contract must
  // not delete a survivor's account out from under her — she keeps her app, her contacts and her
  // ability to trigger, and simply belongs to no organization again. That is the same supported
  // unaffiliated state every consumer is in.
  const eventCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE orgId = ?')
    .bind(orgId)
    .first<{ n: number }>();
  const accountCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE orgId = ?')
    .bind(orgId)
    .first<{ n: number }>();
  const eventsDeleted = Number(eventCount?.n ?? 0);
  const accountsUnbound = Number(accountCount?.n ?? 0);
  if (!dryRun) {
    await env.DB.prepare('DELETE FROM events WHERE orgId = ?').bind(orgId).run();
    await env.DB.prepare('UPDATE users SET orgId = NULL WHERE orgId = ?').bind(orgId).run();
    await env.DB.prepare("UPDATE org_members SET status = 'revoked' WHERE orgId = ?").bind(orgId).run();
  }

  return {
    orgId,
    dryRun,
    deleted,
    mediaObjectsDeleted,
    vaultObjectsRetained: Number(vaultCount?.n ?? 0),
    vaultRetentionNote:
      'Signed custody manifests in blackbox-vault are RETAINED under the 1096-day retention lock ' +
      '(Brief 40). The custody chain is never purged — only the objects it attests to. Export ' +
      'of these events reads PURGED_BY_CONSENT.',
    accountsUnbound,
    eventsDeleted,
    errors,
  };
}

/**
 * Per-org export: the grant-audit answer to "what did you hold for us, and under whose custody".
 *
 * Attribution is FROZEN AT CREATION (§F2), so this reports events under the org that held custody
 * AT THE TIME, not the org their owners belong to now. A survivor who left the shelter last month
 * does not retroactively remove last year's incident from the shelter's audit, and one who joined
 * does not retroactively add her history to it. That is what makes the export truthful.
 */
export async function orgExport(env: Env, orgId: string) {
  const inventory = await orgInventory(env, orgId);
  const events = await env.DB.prepare(
    'SELECT id, status, createdAt, closedAt, tzOffsetMinutes FROM events WHERE orgId = ? ORDER BY createdAt DESC LIMIT 1000',
  )
    .bind(orgId)
    .all<{ id: string; status: string; createdAt: number; closedAt: number | null }>();

  return {
    orgId,
    orgName: inventory.orgName,
    generatedAt: new Date().toISOString(),
    inventory,
    events: events.results ?? [],
    attributionNote:
      'Attribution is frozen at creation. These are the events this organization held custody of ' +
      'when they occurred — not the current membership of their owners.',
    contentNote:
      'Counts and identifiers only. No recording, transcript, classification, location or contact ' +
      'detail is included; those are the survivor’s, released through her own consented export.',
  };
}
