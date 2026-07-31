# BLACK BOX — FIX BRIEF 18 — Visible trigger + Check-in ("I'm OK") down (client dispatch, not server)

**Floor:** current known-good. **Do not regress.**
**Mode:** prove on **deployed production**, **both** Present modes, **live event not row count.**
**Protected — reported WORKING, must still work after this fix:**
- **Hidden-screen trigger** fires a LIVE event (dashboard + cascade).
- **End session** (user-initiated) closes the event.
Break either of these and the fix is a failure regardless of what else it does.

---

## THE DIAGNOSIS THIS BRIEF IS BUILT ON — read before touching anything

Two user-initiated actions are dead: **Visible push-button trigger** and **check-in ("I'm OK")**. But
**Hidden trigger works.** That asymmetry is the whole tell:

- The Hidden facade hold-gesture creates a LIVE event → it runs through the shared server create/resolve
  path (`resolveSingleActive`, the single-active index, cascade). **That path is therefore proven alive.**
- In the Brief 15 trigger regression, BOTH modes were dead — *that* was the server path. **This is not that.**
  If the server create/resolve were broken, Hidden would be dead too. It isn't.
- Therefore the Visible break is **client-side**: the Visible instrument's activate control is not
  dispatching the same trigger the Hidden facade dispatches. Most likely cause: the Brief 15 pointer/hold
  fix (the one that made the facade hold "fire as a button") was applied to the **facade handler only** and
  never to the **instrument activate button** — so the two modes now call different code, one live, one dead.

**Hard constraint from this diagnosis:** **DO NOT touch `resolveSingleActive`, the single-active
index/migration, the cascade, or any Module 4 server create/resolve logic.** Hidden proves it works;
"fixing" it will re-break Hidden. This is a client convergence job unless §1 diagnosis *proves on a log*
that the Visible dispatch reaches the server and the server rejects it — in which case, STOP and surface it
to Royce before touching the server (naming the exact server response).

---

## SECTION 1 — Visible push-button trigger  `[A→L]`  *(P0 — core function down in Visible)*

**Diagnose first — do not rebuild the button.**
1. Locate the **Hidden facade** trigger handler (the working one) and the **Visible instrument** activate
   handler (the dead one). Put them side by side.
2. Identify where they diverge: does the Visible button (a) not bind to the trigger dispatch at all,
   (b) bind but call a stale/renamed handler after the Brief 15/16/17 settings rework, (c) use the old
   pointer/hold path the Brief 15 fix replaced only on the facade, or (d) sit behind a condition that is
   now always-false in Visible? Name which, on evidence, in the commit.
3. Confirm on a log that a Visible activate **does not** currently reach the server (proving it's client
   detachment, not server rejection). If it DOES reach the server and the server no-ops/rejects, STOP —
   surface to Royce, do not edit the server.

**Fix — client only:**
- **Converge both modes on the ONE trigger dispatch.** The Visible activate control must call the exact
  same trigger function the Hidden facade calls — same dispatch, same server request, same handling of the
  response. One trigger path, two entry surfaces (facade hold / instrument activate). No forked logic.
- Preserve the Visible activate UX already speced (hold-to-confirm commit). The gesture UX may differ; the
  **dispatch it lands on must be identical** to Hidden's.
- Single-active behavior is **(A) re-fire/escalate** (Royce's standing call): a Visible trigger while an
  event is already open re-fires the existing event, creates NO second event — same as Hidden.

**Acceptance:**
- `[L]` **Visible:** activate → a **LIVE event surfaces** (dashboard shows it / cascade fires), not a row
  insert. Screenshot/log the live event.
- `[L]` **Hidden still fires** a live event (protected path — re-verify, do not assume).
- `[L]` Single-active holds from Visible: trigger during a live event → still exactly one open event.
- `[A]` Visible activate and Hidden facade call the **same** trigger dispatch (grep/point to the one function).

---

## SECTION 2 — Check-in ("I'm OK")  `[A→L]`  *(P0 — silent no-op safety feature)*

Same blast radius as §1 (settings rework), but a **different fix depending on where it's severed.** Diagnose,
don't assume it's the same as §1.

**Diagnose first — one log tells you which fix:**
- Tap check-in on the deployed app and read the network + worker log. **Does the tap reach the server?**
  - **(a) Tap never reaches the server** → client handler is severed (button unbound / renamed handler /
    dead condition). Fix = rebind the check-in control to its send, client only. Same failure family as §1.
  - **(b) Tap reaches the server, no delivery** → the delivery path no-ops (collateral from the Brief 15/16
    notification/WebSocket rework). Fix = restore delivery. Do the minimum to restore delivery; do not
    reach into the alert cascade.
- Name which, on evidence, in the commit.

**Build (both cases converge on this contract):**
- Check-in is a **single button** (no location checkbox — Brief 17 §1). Location captured automatically on
  tap (current fix at moment of tap). This is the one user-initiated location.
- On tap → recipient is **notified** with **status + timestamp + location**; **user gets a delivered
  confirmation** (no silent success, no silent failure).
- **Recipient: guardian** (existing check-in default — already confirmed by Royce, do not change).
- **Dormant-only.** No capture session, no coordinator, no event, no cascade. A "still OK" heartbeat, not an
  alert. Never promotes to an event.

**Acceptance:**
- `[A]` No checkbox; check-in is a button; tap captures location without a prompt; tap reaches the send path
  (not a no-op — show the send/delivery log).
- `[L]` Real tap on deployed → **guardian receives status + time + location**; **user sees delivered
  confirmation**; account stays fully **dormant** (no event created).

---

## NO-REGRESSION GUARDS — re-verify ALL before "done"

- **Hidden trigger** still surfaces a live event (protected).
- **End session** (user-initiated) still closes (protected).
- **Single-active** still holds: second trigger re-fires, never forks a second open event.
- **§0a covert-active byte-identical:** in Hidden, an active event is byte-identical to dormant facade —
  no instrument, no indicator. This survives every pass.
- **Do not touch:** `resolveSingleActive` / single-active index / cascade / Module 4 server create-resolve
  (Hidden proves it works); capture; notification *content*; custody; facade visuals; Visible UI layout;
  closure logic. **Touch only:** the Visible trigger client dispatch (§1) and the check-in send/delivery
  path (§2).

---

## DEFINITION OF DONE
Both sections pass on the **deployed** production app in **both** Present modes; proof is a **live event
surfacing from a real trigger** (§1) and a **real received check-in with user confirmation** (§2) — not a
SELECT count, not "tests pass". Each check added to the acceptance suite; all previously-green still passes
(especially the two protected paths); committed **naming the actual cause of each break**. No `known-good`
tag until Royce confirms all four on the phone: Visible trigger fires, Hidden still fires, check-in
delivers, end-session still closes.

---

## ⚠ FLAG FOR ROYCE — OUT OF SCOPE FOR THIS FIX, YOUR CALL
You reported end-session as *"working one-way, user-initiated only."* Brief 16 §2 locked closure as
**symmetric, order-independent dual consent** (neither side closes alone). One-way user-initiated closure
is a **factual discrepancy against the locked architecture** — either an intentional v0-pilot simplification
or a regression. I did **not** touch it and this brief does **not** address it (it's outside the two things
you told me to fix). Tell me which it is and I'll write it up separately — I'm not folding it into this pass
and re-expanding scope.
