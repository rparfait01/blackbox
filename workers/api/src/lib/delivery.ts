/**
 * Per-channel delivery records (Fix Brief 1 #5). Every notification ATTEMPT —
 * delivered, failed, or skipped — writes one row, so delivery is observable in
 * D1 instead of inferred from logs. `providerMessageId` ties a row back to the
 * provider's own activity feed (SendGrid X-Message-Id, LINE x-line-request-id).
 *
 * Canonical time is UTC ms + tz offset (Fix Brief 2 #C6); render is done at read
 * time by the DTG/local formatter.
 */

import type { Env } from '../types';

export interface DeliveryRecordInput {
  eventId: string;
  messageKind: string;
  channel: string;
  status: 'delivered' | 'failed' | 'skipped';
  providerMessageId?: string | null;
  detail?: string | null;
}

export interface DeliveryRecordRow extends DeliveryRecordInput {
  id: string;
  createdAt: number;
  tzOffsetMinutes: number | null;
}

export async function recordDelivery(env: Env, input: DeliveryRecordInput): Promise<void> {
  try {
    await env.DB.prepare(
      'INSERT INTO delivery_records (id, eventId, messageKind, channel, status, providerMessageId, detail, createdAt, tzOffsetMinutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        crypto.randomUUID(),
        input.eventId,
        input.messageKind,
        input.channel,
        input.status,
        input.providerMessageId ?? null,
        input.detail ?? null,
        Date.now(),
        // The server runs in UTC; offset is 0. Render uses the event's offset.
        0,
      )
      .run();
  } catch (error) {
    console.log(
      JSON.stringify({ level: 'error', message: 'recordDelivery failed', detail: String(error) }),
    );
  }
}

export async function listDeliveries(env: Env, eventId: string): Promise<DeliveryRecordRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, eventId, messageKind, channel, status, providerMessageId, detail, createdAt, tzOffsetMinutes FROM delivery_records WHERE eventId = ? ORDER BY createdAt ASC',
  )
    .bind(eventId)
    .all<DeliveryRecordRow>();
  return results ?? [];
}
