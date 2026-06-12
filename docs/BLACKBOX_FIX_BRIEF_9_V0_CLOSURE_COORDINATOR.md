# BLACK BOX — Brief 9: v0 Closure & Coordinator Model

Implements the v0 protocol for pilot use (one household: user + contacts + guardian). Faithful to
the founder's design. v0 capture base is audio + location (see Constraints). Device-verify on a
clean build.

## Roles & account
- Account: opaque ID (e.g. `a1b2c3d4e5f6`). The pin and all roles attach to this record
  server-side.
- User: first + last name, nationality.
- Designated Contacts: up to three, in priority order (primary → secondary → tertiary).
- Guardian: exactly one. The zero-fail failsafe and coordinator of last resort.
- Guardian on/off: a user-controlled account setting (server-side toggle). Easy on a PWA — it is
  just stored state. Locked during an active alert (cannot be flipped mid-event; same 423 lock as
  contacts).
- A contact or guardian can oversee multiple users from one dashboard (see Caps).

## Activation & capture
- Trigger: covert / non-alerting voice code, or the existing covert screen gesture.
- On activation: start audio recording + location capture; stream to the coordinator
  (receive-only) via the account link. All capture is tamper-EVIDENT (existing hash chain) and
  write-once.
- The user CANNOT clear the alert. Activation is committal — only the coordinator secures it.

## Escalation chain (timed coordinator handoff)
- On activation, notify the primary contact. If no response within the window, escalate:
  - 0–15 min: primary contact (coordinator if they respond)
  - 15–30 min: secondary contact notified, becomes coordinator if primary hasn't
  - 30–45 min: tertiary contact notified, becomes coordinator
  - 45–55 min: GUARDIAN notified, becomes coordinator
  - after that: emergency services via SMS / LINE
- Windows must be user-configurable (store per account). [Note: 15 min to first escalation is long
  for an active threat — recommend a shorter default first hop. Your call.]
- First to respond holds primary coordinator duty.

## Coordinator access tiers
- Exactly ONE primary coordinator at a time (prevents confusion).
- Coordinator gets FULL access: audio, location (video when added), and the shareable link.
- Everyone else in the network: LOCATION ONLY — no audio/video. Keeps distressing capture from
  spreading across a network of devices.
- The share link is mintable ONLY by the current coordinator.
- [CONFIRM: the securer is the current coordinator — which may be a contact, not only the guardian.
  The guardian is the guaranteed coordinator of last resort. Your design said both "the guardian
  secures" and "first responder coordinates" — I encoded current-coordinator-secures with
  guardian-as-failsafe. Tell me if you want guardian-only securing.]

## Closure flow (user requests, coordinator secures)
- The user opens the app (dormant facade), invokes the hidden gesture, taps Request closure, and
  enters their 3-digit pin. The pin is an INTENT tool — evaluated on-device, NEVER transmitted.
  Only the resulting status is sent.
- On-device evaluation:
  - Correct pin → status SAT.
  - Last digit altered (any wrong value in the last position) → status UNSAT = DURESS.
  - Other wrong patterns → typo: "not recognized, try again," 3 attempts, then a brief lockout +
    notify coordinator "multiple failed attempts — use judgment."
- The coordinator's closure window shows:
  - PIN: sat / unsat
  - Threat status: active / inactive
  - Reason for securing: [the user's concise entry]
  - Action: Secure alert? → Yes
  - Confirmation: "Are you sure [user] is safe?" → Yes → *alert secured*
- DURESS (unsat): the coordinator is notified the threat is ONGOING — do not assume safe. The
  window makes the duress state unmistakable.
- The coordinator validates with judgment: are the words and tone the user's own? can they reach
  the user? Securing is never automatic — always the coordinator's deliberate act.

## Closure status report (the LT7 hard-fail item)
- Every secured session generates a write-once closure status report: situational summary, frozen
  origin snapshot, location/audio custody + timestamps, PIN sat/unsat, reason event triggered,
  reason event secured.
- It is the artifact the coordinator reviews in the closure window, and it is included in the
  closure notification.
- "Reason event triggered" is entered post-event (the user can't type during covert activation);
  "reason event secured" is entered at closure.

## Caps ("how do I cap safety")
- You don't cap safety with a number — you cap it with redundancy, which the chain already does.
- Guardian: cap LOW (recommend 1–3 users). A failsafe responsible for 20 isn't a failsafe.
- Contact: higher is fine (up to ~20) — lighter duty, location-only, and three back each other up.
- Surface the guardian's load to the user ("your guardian is also failsafe for N others") so they
  can judge reliability themselves. Redundancy + transparency.

## v0 constraints & non-goals (so the pilot isn't built on sand)
- Capture = audio + location. Solid and proven; build the pilot here.
- Front AND back camera simultaneously is NOT a web-platform capability (getUserMedia yields one
  camera at a time; dual-camera is barely supported even natively). Single-camera video is
  possible but carries the covert-facade tension (a meditation app requesting the camera is a
  tell). Treat dual-camera as hardware/v2 — do not architect v0 around it.
- No MAC-address linkage — phones don't expose MAC to web apps and randomize it. The account ID is
  the linkage.
- Tamper-EVIDENT, not tamper-proof: bytes are always alterable by someone with DB access; the hash
  chain makes any alteration detectable. Write-once + evident is the achievable standard.

## Acceptance criteria (device-verified, clean relaunch)
1. The user cannot self-close; only the coordinator secures.
2. Correct pin → coordinator window shows SAT; securing requires the explicit confirmation step.
3. Last-digit-altered pin → coordinator window shows UNSAT/DURESS + "threat ongoing"; it cannot be
   mistaken for a safe closure.
4. First responder becomes the sole coordinator with full access; all others see location only;
   the share link is coordinator-only.
5. No-response escalation hands the coordinator role down the chain on the configured timers,
   reaching the guardian, then emergency services.
6. Securing a session generates the closure status report and includes it in the closure
   notification.
EOF