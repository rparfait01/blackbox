# BRIEF 56 §A1 — DIAGNOSIS. REPORTED BEFORE ANY FIX.

Read-only: production D1 `SELECT`s and the repo. No writes, no Worker requests.

---

## THE ANSWER

**The halt is present, correct, and evaluated at dispatch time in all three drivers. It did not
fail. Every one of the nine events in the record behaved correctly.**

**What is broken is the CLAIM MODEL, not the halt.** In four of those events the coordinator had
the live dashboard **open in front of them** before the next contact was notified — by up to 5.4
seconds — and the cascade escalated anyway, because opening the dashboard is not claiming it. The
explicit claim lands 1.2–4.2 seconds after the view, and by then a 10-second cascade has usually
already fired.

So what you observed is real. The mechanism is not the one the brief assumed.

---

## §A1's questions, answered

### "Where is the halt supposed to happen? Is the check absent, or present and never true?"

**Present, in all three drivers, and evaluated immediately before each send — never at schedule
time.**

| Driver | Halt |
|---|---|
| In-request stagger (`notifyActivation`) | `advanceStep()` immediately before every `dispatchStep()` |
| **DO alarm** (`CascadeScheduler.alarm` → `cascadeTick`) | Re-reads `status` + `coordinatorClaimedAt` on every alarm fire, returns `null` to stop the schedule; then `advanceEventCascade` → `advanceStep` re-checks again |
| Cron backstop (`advanceCascades`) | `WHERE status='active' AND coordinatorClaimedAt IS NULL`, then `advanceStep` re-checks |

The halt itself is one atomic statement, and it is the same one for every driver:

```sql
UPDATE events SET cascadeStep = ? WHERE id = ? AND cascadeStep = ?
  AND status = 'active' AND coordinatorClaimedAt IS NULL
```

If the claim is recorded, the UPDATE matches zero rows, `advanceStep` returns false, and the step
does not send. **§A2's rule is already the shipped behaviour**, including "evaluated at dispatch
time, not at schedule time" — the brief's DO hypothesis is refuted below.

### "Does the alarm read claim state when it fires, or was it read once at scheduling time?"

**It reads it when it fires.** `cascadeTick` opens with a fresh `SELECT ... coordinatorClaimedAt
FROM events WHERE id = ?` on every alarm, and returns `null` — cancelling the whole schedule —
when the event is claimed or closed. The DO stores only `eventId` and `workerOrigin`; no claim
state is captured at arm time, so there is nothing stale to read.

### "Was the halt collateral to Brief 33 Fix B or to 07c4404? Bisect if not obvious."

**Neither, and no bisect is needed — the halt demonstrably fires on current production code.**
Three of the events below are post-`07c4404` and post-Brief-33-Fix-B, and in all three the second
contact was correctly **never notified**:

| Event | step 0 | claim | step 1 due | step 1 |
|---|---|---|---|---|
| `49be0e3f` | +1,169ms | **+7,959ms** | +10,000ms | **suppressed ✓** |
| `9682bd4d` | +984ms | **+8,169ms** | +10,000ms | **suppressed ✓** |
| `febff13d` | +1,213ms | **+9,297ms** | +10,000ms | **suppressed ✓** |

A halt that was absent, unwired, or never true could not have produced those three rows.

---

## THE FULL TIMELINE, ALL NINE EVENTS

`cascadeIntervalSeconds = 10` for every account. Two cascade steps exist on the test account
(contact → guardian), so step 0 fires at T+0 and step 1 at T+10s.

| Event | step 0 | **coordinator opened** | step 1 | claim | step 1 sent? | correct? |
|---|---|---|---|---|---|---|
| `49be0e3f` | 1,169 | 5,918 | — | 7,959 | **no** | ✓ halted |
| `9682bd4d` | 984 | 7,012 | — | 8,169 | **no** | ✓ halted |
| `febff13d` | 1,213 | 7,997 | — | 9,297 | **no** | ✓ halted |
| `88c088c8` | 585 | **6,143** | 10,024 | 10,340 | yes | ✓ fired 316ms before the claim |
| `75d4975f` | 608 | **7,621** | 10,022 | 11,012 | yes | ✓ fired 990ms before the claim |
| `2de8ccf1` | 1,166 | **8,819** | 10,017 | 11,788 | yes | ✓ fired 1,771ms before the claim |
| `e3a4e073` | 1,048 | 10,987 | 10,061 | 15,377 | yes | ✓ opened after the step |
| `9dd89523` | 1,013 | 33,087 | 10,023 | 33,371 | yes | ✓ opened 23s after the step |
| `26998dc8` | 559 | **4,650** | 10,028 | never | yes | ✓ never claimed at all |

### The narrowest case, proven rather than inferred

`88c088c8` looked like a genuine leak: the email delivery record is stamped +11,539ms and the claim
at +10,340ms — the send lands *after* the claim. The audit trail settles it:

```
   +585   cascade_fired            <- step 0
   +725   notification_delivered_line
  +6143   claimable_view           <- coordinator OPENS the dashboard
 +10024   cascade_fired            <- step 1 decision: advanceStep() SUCCEEDED
 +10340   coordinator_claimed      <- claim recorded, 316ms LATER
 +11539   notification_delivered_email
```

The decision preceded the claim by 316ms. The 1.2s that follows is email-send latency, not
indecision. **The halt was never given the chance to fire, and it was not supposed to.**

---

## THE ACTUAL DEFECT

### Being present is not the same as claiming, and only claiming counts

Four events — `88c088c8`, `75d4975f`, `2de8ccf1`, `26998dc8` — recorded `claimable_view` **before**
step 1 fired, by 3.9s, 2.4s, 1.2s and 5.4s. An authenticated coordinator had that event's live
dashboard open, and the survivor's second contact was notified anyway.

In `26998dc8` the coordinator opened it at +4.65s and **never claimed at all** — the escalation ran
its full course with a human watching the whole time.

### The race is unwinnable by design

Measured from the moment the first notification is delivered to the moment the claim is recorded:

```
6.6s   7.0s   7.8s   9.6s   10.3s   10.4s   13.9s        median ~9.6s
```

Step 1 fires ~9 seconds after that first notification lands. **The human claim latency and the
cascade window are the same number.** It is a coin flip, and the record shows exactly that — 3
halts, 6 escalations, no code defect anywhere in the split.

The view-to-claim gap alone is 1.2–4.2s (median ~2.7s): time spent after the coordinator is
already looking at the page, on a UI step that exists to establish intent.

---

## WHAT I RECOMMEND, AND WHAT I WILL NOT DECIDE ALONE

§A2's four rules are already shipped behaviour, so there is no P0 fix to write. The real question
is one the brief does not settle, and it trades directly against §A3:

**Should presence suppress escalation, or only commitment?**

| Option | Effect | Risk |
|---|---|---|
| **A. Leave it.** | Cascade reaches more contacts. | The thing you observed keeps happening. More people learn about an incident than needed to. |
| **B. Longer first interval** (e.g. 25–30s to step 1). | Gives a human time to claim. Nothing else changes. | Slower reach if the primary never responds — the exact cost §A3 warns about, paid on every event. |
| **C. A view DEFERS the next step** (e.g. +20s), never cancels it. | Someone demonstrably present gets time to commit; the cascade still runs if they do nothing. | A contact who opens and walks away delays reach. Bounded — one deferral, then it proceeds. |
| **D. A view CLAIMS.** | Halts immediately. | **Do not do this.** Opening a link is not agreeing to coordinate, and it would let a passive recipient silence the cascade for a survivor nobody is actually helping. |

**My recommendation is C, bounded to a single deferral, with B as the simpler alternative if you
want one lever instead of two.** C is the only option that distinguishes "a person is here" from
"a person has taken responsibility" without letting the first stand in for the second.

I am not building any of them without your ruling, because every one of them changes how fast a
survivor's second contact hears about an incident, and §A3 is explicit that under-notifying is the
worse failure.

### What I will build regardless, from §A2 and §A3

1. **The step count is stated.** "N of M contacts notified before a coordinator took this" on the
   coordinator surface and in the closure report. Not built today, unambiguously wanted.
2. **The fail-open guard.** §A3 requires that an unreadable claim state still SENDS. Today
   `advanceStep` returns false on a thrown D1 error, which **fails closed — it suppresses**. That
   is a real defect against the stated rule, it is invisible because it only appears when D1 is
   already failing, and no test covers it. This one I will fix.
3. **The no-claim regression**, proven both ways: no claim → all steps dispatch at
   T+0/+10/+20/+30/+40 under 60s.

Item 2 is the only genuine code defect §A turned up, and it is the opposite of the reported one:
not a halt that fails to fire, but a halt that fires when it cannot read the answer.
