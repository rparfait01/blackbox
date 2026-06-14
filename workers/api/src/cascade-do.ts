/**
 * CascadeScheduler Durable Object (Brief 17). Fires each contact-cascade step at
 * its EXACT wall-clock window (T+0/+10/+20/+30/+40) using durable alarms — timing
 * that does not depend on the activation request's `waitUntil` surviving (it is
 * reclaimed ~35s, too early for the +40 emergency step) or on a device heartbeat.
 *
 * One instance per event (id = idFromName(eventId)). `arm` stores the event id and
 * bootstraps an immediate alarm; each `alarm()` advances any due step via
 * `cascadeTick` and re-arms for the next window, stopping when the chain is done or
 * a coordinator claims / the event closes. Every step claim is atomic in D1, so the
 * DO never double-notifies alongside the in-request stagger / heartbeat / cron.
 */

import type { DurableObjectState } from '@cloudflare/workers-types';
import { cascadeTick } from './lib/notify';
import type { Env } from './types';

export class CascadeScheduler {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { eventId?: string; workerOrigin?: string };
    if (!body.eventId) {
      return new Response('bad request', { status: 400 });
    }
    await this.state.storage.put({ eventId: body.eventId, workerOrigin: body.workerOrigin ?? '' });
    // Bootstrap: a near-immediate alarm runs the first tick, which advances any due
    // step and sets the alarm for the next window. Self-scheduling from there.
    await this.state.storage.setAlarm(Date.now() + 200);
    return new Response('armed');
  }

  async alarm(): Promise<void> {
    const eventId = (await this.state.storage.get('eventId')) as string | undefined;
    if (!eventId) {
      return;
    }
    const stored = (await this.state.storage.get('workerOrigin')) as string | undefined;
    const workerOrigin = stored || this.env.WORKER_ORIGIN || '';
    const next = await cascadeTick(this.env, eventId, workerOrigin);
    if (next != null) {
      // Never schedule in the past; honour the exact window otherwise.
      await this.state.storage.setAlarm(Math.max(Date.now() + 500, next));
    }
  }
}
