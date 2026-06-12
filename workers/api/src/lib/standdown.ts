/**
 * Server-authoritative stand-down (Fix Brief 1 #4, shared by the PWA HMAC path
 * and the coordinator dashboard path in Fix Brief 3 R2). The raw lock code is
 * verified against the account's lock/duress hash:
 *   - lock code   → close the event (closedBy)
 *   - duress code → ESCALATE (duress alert), do NOT close; recording continues
 *   - anything else → rejected; nothing changes
 */

import type { Env } from '../types';
import { audit } from './audit';
import { dispatch } from '../channels/router';
import { getContactForEvent } from './contacts';
import { verifySecret } from './crypto';
import { mintMagicToken } from './magic-link';
import { getUserById } from './users';

export type StandDownOutcome =
  | 'closed'
  | 'duress'
  | 'wrong'
  | 'no_lock_code'
  | 'not_found'
  | 'already_closed';

export async function attemptStandDown(
  env: Env,
  eventId: string,
  code: string,
  workerOrigin: string,
  closedBy: string,
): Promise<StandDownOutcome> {
  const event = await env.DB.prepare(
    'SELECT userId, userHash, status, locale FROM events WHERE id = ?',
  )
    .bind(eventId)
    .first<{ userId: string | null; userHash: string | null; status: string; locale: string | null }>();
  if (!event) {
    return 'not_found';
  }
  if (event.status === 'closed') {
    return 'already_closed';
  }
  const user = event.userId ? await getUserById(env, event.userId) : null;
  if (!user?.lockCodeHash) {
    return 'no_lock_code';
  }

  let kind: 'normal' | 'duress' | 'wrong' = 'wrong';
  if (await verifySecret(code, user.lockCodeHash)) {
    kind = 'normal';
  } else if (user.duressCodeHash && (await verifySecret(code, user.duressCodeHash))) {
    kind = 'duress';
  }

  const contact = await getContactForEvent(env, event);

  if (kind === 'wrong') {
    await audit(env, eventId, 'standdown_rejected', null, { closedBy });
    return 'wrong';
  }

  if (kind === 'duress') {
    // Escalate; never close. Recording continues no matter what.
    await audit(env, eventId, 'standdown_duress', null, { closedBy });
    if (contact && env.MAGIC_LINK_SECRET) {
      const token = await mintMagicToken(env.MAGIC_LINK_SECRET, eventId);
      const dashboardUrl = `${workerOrigin}/c/${eventId}?t=${token}`;
      await dispatch(env, contact.id, {
        kind: 'duress',
        eventId,
        payload: { userDisplayName: contact.displayName, dashboardUrl },
      });
    }
    return 'duress';
  }

  // Normal lock code → server-authoritative close.
  await env.DB.prepare(
    'UPDATE events SET status = ?, closedAt = ?, closedBy = ? WHERE id = ? AND status = ?',
  )
    .bind('closed', Date.now(), closedBy, eventId, 'active')
    .run();
  await audit(env, eventId, 'standdown_closed', null, { closedBy });
  if (contact) {
    await dispatch(env, contact.id, {
      kind: 'closureConfirmation',
      eventId,
      payload: { userDisplayName: contact.displayName },
    });
  }
  return 'closed';
}
