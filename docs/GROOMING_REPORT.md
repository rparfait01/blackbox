# BLACK BOX — Grooming Report

*End-to-end review reconciling fix briefs 5 through 12 against the specs, with the open design questions resolved and the v1 acceptance list pulled into one place. June 2026.*

> **Revision note (briefs 9–12).** Brief 11 reverses the dispatch model: the alert no longer fans out to everyone at once — it cascades sequentially, one contact at a time. Brief 9 also pins down what v0 actually captures (audio + location, not video), the account/roles/caps model, and the closure status report. Brief 12 unifies the closure pin: Settings now edits the single three-digit on-device pin — the one source of truth for both SAT and duress — and the legacy four-digit/server pin and defunct backup code are retired. Those changes are folded in below, and the affected punch-list lines are rewritten rather than appended.

---

## The shape of the cleanup

Going through the project end to end, the fat was not in the feature set — it was in the fact that the same decision lived in several documents at slightly different settings, and a builder reading them in the wrong order would have implemented the wrong one. The grooming work was mostly reconciliation: deciding which version of each contested decision is canonical, writing it down once, and making the mockup and framework reflect only that version. Four contradictions mattered enough to call out explicitly.

The dispatch is a **sequential cascade, not a simultaneous fan-out.** This is the one that flipped. Brief 10 fixed a real bug — a second contact was getting nothing — and in fixing it deployed an immediate fan-out to everyone at once. Brief 11 corrects that: the fan-out overrode the intended priority order, so the model is now a staggered cascade, one contact every fifteen seconds in priority order. The part of Brief 10 that survives is *whether* a contact is included (always, resolved fresh, newly added ones too); what changes is *when* each one fires. Anything still describing an all-at-once blast is now wrong.

The closure code is **three digits, not four.** Brief 9 supersedes the older V0 pilot prompt, which still described a four-digit PIN. Everywhere downstream — the keypad, the duress logic, the acceptance tests — now assumes three. Brief 12 finishes the job: the legacy four-digit/server pin is retired from the closure path entirely and the Settings control now edits the three-digit pin, so "four" is no longer merely stale — it is gone. Anything still saying four is wrong.

There is **one engine, two faces.** Covert (the Stillpoint meditation facade) and overt (the open instrument) were drifting toward being described as two products. They are not. Capture, classifier, cascade, the closure-and-duress code, the awaiting screen, and check-in are byte-for-byte identical underneath. The only differences are what the user sees and whether activation is silent. Keeping that in your head prevents a whole class of "but in covert mode does X still…" questions — the answer is always yes, because X is in the shared engine.

The **dashboard is one surface.** Contact, coordinator, and dispatch/authority are the same screen. The authority version simply adds fields (agency, dispatch summary, multi-format coordinates, CAD-copy). We are not building three dashboards. This was implied across the briefs but never stated as a single rule, so it is stated now.

---

## The closure and duress logic, settled

The code is an intent tool, evaluated entirely on-device. The code itself is **never transmitted** — only the resulting status leaves the handset. That property is what makes the duress path safe, so it is non-negotiable.

Correct code → status `SAT` → user screen shows *awaiting approval*. A wrong **last digit** with the first two correct → status `UNSAT-DURESS` → coercion flag raised silently. Any other wrong entry is treated as a fat-finger typo: retry, and after three failures lock out and notify the coordinator. Submission is always an explicit press; there is no auto-submit that could fire on a number a coercer is watching get typed.

There is exactly **one pin**, and Brief 12 made Settings honor it. The control in Settings edits that three-digit on-device pin and nothing else — the legacy four-digit server pin is gone from the closure path, and the old "backup code" is removed. This is load-bearing, not housekeeping. The duress test is defined *against the registered pin* — SAT is that pin, duress is that pin with the last digit altered — so both must read from a single source of truth. A Settings control that quietly edited a different pin than closure evaluated would have left the user setting a code the duress logic never measured against, breaking the signal with no visible sign. One pin: set where the user expects, used at closure, and serving as the duress baseline.

The single most important visual property: **the awaiting screen looks identical whether the code was SAT or duress.** An onlooker shoulder-surfing the handset cannot tell which path was taken. The signal goes to the dashboard, never to the screen in the room.

And there is **one close door.** The user cannot self-close. Refreshing the page is not a close. Only a coordinator securing the event on the server ends it, and the server is authoritative. This removes the failure mode where a coerced user is forced to "turn it off" — there is no off switch in their hands to be forced.

What the coordinator actually sees in the closure window is small and deliberate: PIN sat/unsat, threat active/inactive, the user's concise reason for securing, then a two-step act — *Secure alert?* and a hard confirmation, *Are you sure [user] is safe?* Under duress the window makes the ongoing-threat state unmistakable and tells the coordinator not to assume safety. Securing is never automatic; it is always the coordinator's judgment about whether the words and tone are the user's own.

---

## The closure status report

Brief 9 makes this the artifact that closes the LT7 hard-fail. Every secured session generates a write-once closure status report, and it is both what the coordinator reviews in the closure window and what rides along in the closure notification. It carries the situational summary, the frozen origin snapshot, the location and audio custody with timestamps, the PIN sat/unsat result, the reason the event triggered, and the reason it was secured. The two "reason" fields are filled at different moments by necessity — the trigger reason is entered after the fact, because the user can't type during a covert activation, and the secure reason is entered at closure. The report is the durable, human-readable record that an event happened, what it was, and how it ended.

---

## The coordinator model, settled

Per Brief 7, the coordinator role is claimed **only on a deliberate POST** — the responder presses "Take coordination." It is never claimed by passively loading the dashboard, because a passive claim would let the first person who happened to open the link silently lock everyone else out. The claim is sticky and idempotent. Once claimed, the coordinator has full access and everyone else drops to location-only with the existing verbiage about another responder already coordinating. That wording is already correct in the briefs and was left untouched.

There is one access rule worth stating alongside this, because it shapes the whole dashboard: the coordinator gets full capture — audio, location, and the shareable link — while **everyone else in the network sees location only.** That is not a permissions afterthought; it is there to keep distressing audio and video from spreading across a network of devices. The share link, too, is mintable only by the current coordinator.

---

## Roles, account, and caps

The account is an opaque ID, and the PIN and every role attach to that record server-side. The user is identified by name and nationality. Around them sit up to **three designated contacts in priority order** (primary, secondary, tertiary) and **exactly one guardian** — the zero-fail failsafe and coordinator of last resort. The guardian can be toggled on or off by the user as an account setting, but that toggle is locked during an active alert under the same lock that freezes the contact list mid-event; you cannot change who is responsible while a responsibility is live.

On the question of how to "cap safety": you don't cap it with a number, you cap it with redundancy, which the chain already provides. The guardian cap should be *low* — one to three users — because a failsafe responsible for twenty people is not a failsafe. Contacts can run higher, up to around twenty, since their duty is lighter, they are location-only, and three of them back each other up. The one thing the system should surface is the guardian's load to the user ("your guardian is also failsafe for N others"), so reliability is something the user can judge for themselves. Redundancy plus transparency, not a hard ceiling.

---

## The notification cascade, settled

This is the section Brief 11 rewrote, so read it as the canonical version and discard the fan-out description.

On activation, contacts are notified **one at a time, in priority order, fifteen seconds apart** — primary at T+0, secondary at T+15s, tertiary at T+30s, guardian at T+45s (when enabled), and the emergency-services fallback after the configured window if the chain runs dry. The first contact gets a fifteen-second head start precisely so they have first claim on the coordinator role; the stagger is what makes the priority order mean something. The first to claim owns coordination with full access; everyone notified after that gets the location-only informed view. Once a coordinator is claimed the cascade stops firing — the responsibility is owned, so the rest of the chain isn't alarmed. If no one claims, it runs to the end and escalates to emergency services.

The intervals are user-configurable per account, stored server-side. The fifteen-second default directly resolves the concern Brief 9 had flagged about its own older timing — that model staggered notifications across fifteen-*minute* windows, which is far too slow for an active threat. Seconds, not minutes, is the settled answer.

Two things from Brief 10 are explicitly preserved and must not regress. Recipients are resolved **fresh on every dispatch**, so a newly added contact is always included — the original "second contact gets nothing" bug cannot come back. The cascade staggers *when* each recipient fires, never *whether* they are included. And per-channel delivery logging plus the single whole-cascade retry stay in place.

Note this cascade is the *initial dispatch* layer. The coordinator-handoff concept from Brief 9 (if the current coordinator goes dark, the role can pass down the chain and ultimately to the guardian as failsafe) still holds as a separate, slower layer operating after the fast cascade has done its job.

---

## What v0 actually captures — and what it doesn't

Brief 9 draws a hard line here that keeps the pilot from being built on sand, and it is a genuine trim: **v0 capture is audio plus location. Not video.** This is not a feature being deferred for taste; it is a platform fact. Simultaneous front-and-back camera is not a web capability — `getUserMedia` hands you one camera at a time, and dual-camera is barely supported even natively. Single-camera video is technically possible but collides with the covert facade: a meditation app asking for the camera is a tell, and the tell defeats the point. So video is hardware/v2, full stop, and v0 must not be architected around it. The pricing and portfolio already place video at the v1/v2 hardware tier, which is consistent — this just makes the software pilot's scope explicit so no one wastes a build cycle on it.

Two smaller scope facts belong with this. There is no MAC-address linkage anywhere — phones don't expose MAC to web apps and randomize it regardless; the account ID is the linkage. And capture is **tamper-evident, not tamper-proof.** Anyone with database access can alter bytes; what the hash chain guarantees is that any alteration is *detectable*. Write-once plus evident is the honest, achievable standard, and it is exactly the standard the evidence-custody process below is built on. Claiming "tamper-proof" would be the kind of overpromise the brand is supposed to refuse.

---

## Authorities evidence acquisition — the concrete process

This was the open item flagged as critical and unvetted, so here is the concrete version. The principle established earlier was *ownership and authority*; what was missing was *how the handoff actually happens.* It is a recorded four-step custody process, deliberately not a download button.

**One distinction underpins all of it: the live feed and the evidence package are different things on different lanes.** The live feed is ephemeral and view-only — a token link to act on right now, expiring on its own (default six hours). The evidence package is durable — the thing a court or inquiry stands on later. Conflating them is the mistake; keeping them apart is the design.

**Step one, identity gate.** Before any access, the recipient registers name, agency, badge, and a verified contact, confirmed by OTP. There is no anonymous access. This mints an immutable recipient ID (`RCP-{uuid}`) that every later action is bound to.

**Step two, authorization.** Access has to be authorized by one of three routes, each tied to that recipient ID: a coordinator release, the user's own e-signature (over SMS or LINE), or a recorded legal-process assertion such as a court order. The route taken is part of the record.

**Step three, assemble and seal.** The package — full transcript, captured media (audio and location in v0; video where hardware adds it), location trail, scenario summary, classification, and the share history — is hash-chained with SHA-256 into a single server-signed manifest. The original is sealed write-once in the operator vault with a 36-month retention.

**Step four, custody transfer.** The transfer is recorded against the recipient ID plus a date-time group plus the package hash. The recipient receives a verifiable copy and a standalone verifier tool. Change a single byte of the package afterward and verification fails.

**Honest scope, stated plainly.** This makes tampering with the record provable. It does not, and cannot, compel anyone to cooperate. BLACK BOX produces trustworthy evidence; it does not replace due process, and the portfolio says so rather than overclaiming.

---

## Check-in, settled

Per Brief 10, check-in is a deliberate button, separate from the alert system, present on both covert and overt displays. One tap sends "[User] checked in — I'm OK" with a timestamp to the recipients (guardian by default). It carries no location unless the user opts in on that specific tap, and it starts no capture, no session, and no coordinator. The recipient simply sees "Last check-in: [time]." It is the low-stakes, user-driven counterpart to the alert — the thing you press when everything is fine and you just want someone to know.

---

## Contact-initiated alerts — criteria and the missing-person number

The brief was: reasonable but strict, user-driven and trust-based, **not** a guardian-control surface except in genuine life-and-death. Here is where that landed, and it preserves the no-surveillance principle deliberately.

A contact-raised alert **escalates the network and surfaces last-known location and last check-in.** It does **not** silently switch on the user's camera or microphone. Remote capture only ever happens under a mode the user pre-consented to (a companion ETA or check-in watch) or a logged, user-revocable guardian override reserved for life-and-death. The default behaviour of a worried contact is to rally people and reveal what is already known — not to start watching the user. That line is what keeps this from becoming the stalking tool the whole product is meant to be the opposite of.

On thresholds: a missed scheduled check-in or a blown companion ETA escalates immediately, because the user already set that expectation. An **unscheduled** welfare concern runs on a configurable unreachable window.

On the eight-hour figure you weren't sure about — the research says eight hours is **conservative, probably too long for a default.** The widely believed "you must wait 24 hours to report someone missing" rule is a myth; no US federal or state law imposes a waiting period, and for at-risk people the guidance is explicitly to act immediately. Delay is what harms outcomes. So the recommendation is to treat eight hours as a sensible *ceiling* for a low-concern case, not the default, and set the default shorter — around four hours — with a configurable range of roughly one to twelve. For a known high-risk individual the window should collapse toward immediate. **This is the one number I'd ask you to confirm before it's locked**, since it's a policy judgment as much as a technical one.

---

## v1 acceptance punch-list

Pulled from briefs 5 through 12 into one checklist. This is what "v1 is done" means.

1. Three-digit closure code, set in Settings as the single source of truth — no legacy four-digit/server pin, no backup code; last-digit-altered = duress; three typos = lockout + coordinator notice. *(Briefs 9, 12)*
2. Code evaluated on-device; only status transmitted, never the code itself. *(Brief 9)*
3. Awaiting screen visually identical under SAT and duress. *(Brief 9)*
4. One close door: only a coordinator securing on the server ends the event; refresh is not a close. *(Briefs 6, 9)*
5. Explicit submit on the keypad; no auto-submit. *(Brief 9)*
6. Securing requires the two-step confirm; duress window shows threat ongoing and cannot be mistaken for a safe closure. *(Brief 9)*
7. Every secured session generates the write-once closure status report and includes it in the closure notification. *(Brief 9)*
8. Coordinator claimed only on deliberate POST; sticky and idempotent; coordinator gets full capture, everyone else location-only; share link is coordinator-only. *(Briefs 7, 9)*
9. **Dispatch is a sequential cascade** — contacts notified in priority order at ~15s intervals (primary T+0, secondary T+15s, tertiary T+30s, guardian T+45s), not all at once; intervals configurable per account. *(Brief 11)*
10. Recipients resolved fresh each dispatch — every configured contact including a newly added one is reached; none dropped. The stagger changes timing, never inclusion. *(Briefs 10, 11)*
11. Cascade halts once a coordinator claims; if no one claims, it completes to the emergency-services fallback. *(Brief 11 — pending the confirms below)*
12. v0 capture is audio + location only; no video in v0; account ID is the linkage (no MAC); capture is tamper-evident (hash-chained, write-once), not tamper-proof. *(Brief 9)*
13. Account model: opaque ID, up to three priority-ordered contacts, exactly one guardian, user-toggleable guardian locked during an active alert. *(Brief 9)*
14. Dashboard is one surface; authority view adds dispatch summary, CAD-copy, multi-format coordinates. *(Brief 10, Authority View Spec)*
15. Dashboard order: map → frozen origin (t=0) → latched situation → camera → transcript. *(Brief 6)*
16. Live feed and evidence package separated; live token expires (default 6h). *(Brief 2, Custody)*
17. Evidence acquisition runs the four-step custody process; transfer recorded against recipient ID. *(Custody)*
18. Check-in button on both modes; user-driven; no location unless opted in per tap; no session started. *(Brief 10)*
19. Contact-initiated alert escalates and reveals last-known state; no silent remote capture outside pre-consented mode or logged life-and-death override. *(this report)*

---

## What's still open

A handful of things genuinely need your call rather than mine. Three are explicit confirm-flags the briefs left for you:

**Who can secure an alert.** Brief 9 encoded *current-coordinator-secures*, with the guardian as the guaranteed last-resort coordinator — because your design said both "the guardian secures" and "first responder coordinates," and those aren't the same rule. If you want guardian-only securing instead, say so and it changes.

**When the guardian gets pinged.** Brief 11 has the guardian firing last in the cascade, at T+45s. If you'd rather the failsafe be pinged immediately in parallel — on the logic that a true last-resort should never wait — that's a one-line change.

**Whether the cascade halts on claim.** Brief 11 stops further notifications once a coordinator claims, so the rest of the chain isn't alarmed for a situation already owned. If you'd rather everyone be notified regardless, that's the alternative.

Two more are mine to flag. The **default unreachable window** for contact-initiated alerts — I've recommended four hours with eight as a ceiling, but it's a policy decision. And in the mockup, the covert "request closure" path opens the keypad directly over the facade as a simplification; the real flow is reveal-gesture first, *then* keypad — fine for demonstrating the data flow, but not the production interaction. Everything else on the punch-list is reconciled and reflected in the framework and the interactive mockup.
