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
      'INSERT INTO audit_log (id, eventId, action, actorHash, timestamp, metadataJson) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        crypto.randomUUID(),
        eventId,
        action,
        actorHash,
        Date.now(),
        metadata ? JSON.stringify(metadata) : null,
      )
      .run();
  } catch {
    console.log(JSON.stringify({ level: 'error', message: 'audit_failed', action }));
  }
}
