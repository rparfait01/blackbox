import type { Env } from '../types';

/**
 * Append an audit row. Audit metadata lives in D1 (not console logs); console
 * logging stays limited to requestId / endpoint / status / latency. Never throws
 * into a request — a failed audit write is logged and swallowed.
 */
export async function audit(
  env: Env,
  eventId: string | null,
  action: string,
  actorHash: string | null,
  metadata: unknown,
): Promise<void> {
  try {
    await env.DB.prepare(
      // §C — attributed from the event when there is one. `eventId` is NULLABLE here (account-level
      // entries carry no event), and the subselect yields NULL for those rather than failing:
      // an audit entry with no event and no org is correctly unattributed, not broken.
      'INSERT INTO audit_log (id, eventId, action, actorHash, timestamp, metadataJson, orgId) VALUES (?, ?, ?, ?, ?, ?, (SELECT orgId FROM events WHERE id = ?))',
    )
      .bind(
        crypto.randomUUID(),
        eventId,
        action,
        actorHash,
        Date.now(),
        metadata ? JSON.stringify(metadata) : null,
        eventId,
      )
      .run();
  } catch {
    console.log(JSON.stringify({ level: 'error', message: 'audit_failed', action }));
  }
}
