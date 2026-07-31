/**
 * IntegrityChain Durable Object (Brief 37 §A) — the ONE serialization point for an event's
 * hash chain.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * §D — THE BOUNDARY. READ THIS BEFORE ADDING ANYTHING TO THIS FILE.
 *
 * This object owns EVENT-SCOPED CONCERNS ONLY:
 *     · integrity appends for its one event
 *     · replay / idempotency for those appends
 *     · event-scoped command ordering
 *
 * It does NOT own, mint, store, rotate, or revoke device or account identity. Credential
 * provisioning lives in the identity boundary (Brief 41). This object may VALIDATE an
 * event-scoped signed request; it may never be the source of the credential it validates.
 *
 * The reason is not tidiness. A per-event object that also holds identity becomes the one
 * component whose compromise yields both the record and the means to forge it, and it would
 * arrive there one reasonable-looking commit at a time. If a future brief needs identity
 * here, that is a signal the boundary is wrong, not that this comment is stale.
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY A DURABLE OBJECT RATHER THAN A CAS LOOP. Both were viable (§A offers either). The DO
 * makes serialization STRUCTURAL: there is exactly one instance per event id, so two
 * concurrent chunk uploads for one event cannot both read head seq=5. A compare-and-swap
 * loop would make it optimistic instead — correct, but it converts normal concurrency into
 * retries on the capture path, and the capture path is the one place this product cannot
 * afford added latency or added failure modes.
 *
 * THE HEAD LIVES IN THIS OBJECT'S OWN STORAGE, AND THAT IS THE WHOLE FIX.
 *
 * The first attempt kept the head in D1 and merely serialized the reads. It failed under the
 * very first concurrent run, and the trace showed exactly why: record seq 0 was written with
 * chainHash 0e16310a, and record seq 1 was written with prevHash a484174a — a head value no
 * stored record ever produced. Serializing the CALLS does not help when each call re-reads a
 * value from an eventually-consistent store: D1 serves reads from replicas, so an append can
 * be perfectly ordered behind its predecessor and still read the head as it was before that
 * predecessor wrote it.
 *
 * So the head is not re-read. This object holds `seq` and `chainHead` in Durable Object
 * storage, which is strongly consistent and single-threaded per instance, and it is the only
 * writer. D1 is bootstrapped from ONCE per instance (to adopt any chain that already exists)
 * and is written to thereafter — it becomes the durable record rather than the source of
 * truth for the next sequence. The in-memory state advances only AFTER the D1 write lands,
 * so a failed write can never leave this object claiming a sequence that was not stored.
 *
 * ALARM CONTENTION (§0), answered before this was built. Brief 36 §11 moved the cascade tail
 * onto CascadeScheduler's alarm; a second consumer of the same alarm would silently displace
 * it, which is exactly the truncation §11 just fixed. Two things keep them apart, and the
 * second is the load-bearing one:
 *
 *   1. Separate NAMESPACES. `CASCADE_DO.idFromName(eventId)` and
 *      `INTEGRITY_DO.idFromName(eventId)` are different objects with different storage and
 *      different alarms, even for the same event id.
 *   2. THIS OBJECT SETS NO ALARM AT ALL. It is pure request/response. `setAlarm` appears
 *      nowhere in this file, so there is no alarm here to contend with anything — the
 *      contention is impossible by construction rather than merely separated by convention.
 *
 * Both are proven under concurrent load rather than asserted; see the acceptance evidence.
 */

import type { DurableObjectState } from '@cloudflare/workers-types';
import { GENESIS, appendAtSequence, getChainHead, type AppendOutcome } from './lib/integrity';
import type { Env } from './types';

export interface AppendRequest {
  eventId: string;
  recordType: string;
  recordRef: string;
  recordHash: string;
  /** §C — optional replay key. A repeat returns the original result, appends nothing. */
  idempotencyKey?: string;
}

export class IntegrityChain {
  /**
   * An explicit in-memory queue. Durable Objects gate concurrent `fetch` invocations, but
   * that gating is a runtime property and this file's whole reason to exist is that the
   * ordering must be OBVIOUS to the next reader rather than inherited from platform
   * semantics. Every append chains onto the previous one's completion, so the read of the
   * head and the write that follows it are never interleaved.
   */
  private tail: Promise<unknown> = Promise.resolve();

  /** In-memory mirror of this object's durable head, so the hot path does no I/O to read it. */
  private head: { seq: number; chainHead: string } | null = null;
  private bootstrapped = false;

  // This object holds durable STORAGE (the chain head) but sets NO ALARM — see §0 above.
  // `setAlarm` appears nowhere in this file, so it cannot contend with the cascade tail.
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  /**
   * Adopt the existing chain ONCE per instance. An event whose chain was started before this
   * object existed (or before a restart) must continue from where it actually is, not from
   * genesis — starting over would orphan every earlier record. Read from D1 exactly once,
   * while this instance is the only writer, so a stale replica here is self-correcting: the
   * conditional insert below rejects a sequence that is already taken.
   */
  private async bootstrap(eventId: string): Promise<void> {
    if (this.bootstrapped) return;
    const stored = (await this.state.storage.get('head')) as { seq: number; chainHead: string } | undefined;
    if (stored) {
      this.head = stored;
    } else {
      const d1 = await getChainHead(this.env, eventId);
      this.head = d1 ? { seq: d1.seq, chainHead: d1.chainHead } : null;
      if (this.head) await this.state.storage.put('head', this.head);
    }
    this.bootstrapped = true;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    // Chain onto the tail, and make the tail unrejectable so one failed append can never
    // wedge every later one for this event.
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async fetch(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as Partial<AppendRequest>;
    if (!body.eventId || !body.recordType || !body.recordRef || !body.recordHash) {
      return Response.json({ ok: false, error: 'bad_request' }, { status: 400 });
    }
    const outcome: AppendOutcome = await this.serialize(async () => {
      const eventId = body.eventId!;
      await this.bootstrap(eventId);
      const seq = this.head ? this.head.seq + 1 : 0;
      const prevHash = this.head ? this.head.chainHead : GENESIS;
      const result = await appendAtSequence(this.env, {
        eventId,
        seq,
        prevHash,
        recordType: body.recordType!,
        recordRef: body.recordRef!,
        recordHash: body.recordHash!,
        idempotencyKey: body.idempotencyKey,
      });
      // Advance ONLY on a durable write. A replay appends nothing, so it must not move the
      // head either — otherwise a retried chunk would burn a sequence that no record fills.
      if (result.ok && !result.replayed && result.chainHash) {
        this.head = { seq, chainHead: result.chainHash };
        await this.state.storage.put('head', this.head);
      }
      return result;
    });
    // A collision is reported, never swallowed — but it is reported as a RESULT, not a 5xx,
    // because the caller's correct response is to record a gap and carry on uploading, not
    // to fail the capture.
    return Response.json(outcome, { status: outcome.ok ? 200 : 409 });
  }
}

export { GENESIS };
