# BLACK BOX — STATUS SNAPSHOT · 2026-06-14
Previous → New, side by side. Generated after **Section 6 (Closure & Duress, P0) went GREEN** — acceptance suite **18/18 on the deployed app**, tagged `known-good-2026-06-14-sec6` (new floor).

Legend: 🟢 green/locked · 🟡 works-or-fixed, not locked · 🔴 broken · ⚫ not built · ⬜ build pending

---

## ✅ WHAT CHANGED THIS PASS — SECTION 6 · CLOSURE & DURESS
| Row | Prev | New | Proof on deployed |
|---|---|---|---|
| Safe close gate (P0) | 🔴 | 🟢 | #10 — contact can't secure with no pending request (409) |
| Pin not transmitted | 🟡 | 🟢 | PWA unit test — entered digits never posted (status only) |
| Pin not wired to login | 🟡 | 🟢 | #16 — login is password-only; legacy pin fallback retired |
| Duress | 🟡 | 🟢* | #13 — flagged to coordinator; screen-identity accepted code-level (*on-device eyeball = release-checklist MANUAL) |
| Typo lockout → coordinator | 🟡 | 🟢 | #17 — 3 wrong → lockout → dashboard warning, pin never sent |
| One-close-door | 🟡 | 🟢 | #18 — refresh during active event never closes |
| Operator force-close | 🟡 | 🟢 | #15 — force-close + audit |

**Section 6 = GREEN, committed, tagged, pushed.** Pre-push hook actually blocked the first attempt when #8 flaked, then #8 was made deterministic (asserts 5 fires at 0/10/20/30/40 + channel delivers, not SendGrid completeness). That's the tripwire working as designed.

---

## WHOLE BOARD — Prev → New
| § | Row | Prev | New |
|---|---|---|---|
| 1 Account | Edit account | 🟡 | 🟡 |
| 1 Account | Login password (free-form) | ⬜ | ⬜ build |
| 1 Account | Forgot password (reset link) | ⬜ | ⬜ build |
| 1 Account | Guardian slot | 🟡 | 🟡 |
| 1 Account | Closure pin (closure-only) | 🟡 | 🟢 (confirmed via §6 #16) |
| 2 Contacts | Router priority | 🟡 | 🟡 |
| 3 Trigger | Mandatory recipient | 🟡 | 🟡 |
| 3 Trigger | Arm | 🟡 | 🟡 |
| 3 Trigger | Activate + capture (audio+loc) | 🟡 | 🟡 (determine first) |
| 3 Trigger | One active event | 🟡 | 🟡 |
| 4 Cascade | Timing (DO alarm) | 🟢 | 🟢 (check strengthened via #8) |
| 4 Cascade | Slot collapse | 🟡 | 🟡 |
| 4 Cascade | Fail-advance | 🟢 | 🟢 |
| 4 Cascade | Delivery + audit | 🟢 | 🟢 (now deterministic) |
| 5 Coordinator | Claim / halts cascade | 🟢 | 🟢 |
| 5 Coordinator | Access tiers | 🟡 | 🟡 |
| 5 Coordinator | Coordinator ≠ pin | 🟡 | 🟡 |
| 6 Closure | Safe close gate | 🔴 | 🟢 |
| 6 Closure | Pin not transmitted | 🟡 | 🟢 |
| 6 Closure | Pin not wired to login | 🟡 | 🟢 |
| 6 Closure | Duress | 🟡 | 🟢* |
| 6 Closure | Typo lockout | 🟡 | 🟢 |
| 6 Closure | One-close-door | 🟡 | 🟢 |
| 6 Closure | Operator force-close | 🟡 | 🟢 |
| 7 Dashboard | Render order | 🟡 | 🟡 |
| 7 Dashboard | Frozen origin t=0 | 🟡 | 🟡 |
| 7 Dashboard | Emergency locale | 🟡 | 🟡 |
| 7 Dashboard | DTG + timer | 🟡 | 🟡 |
| 8 Check-in | Location link | 🔴 | 🔴 |
| 8 Check-in | Reassurance ping | 🟡 | 🟡 |
| 9 Evidence | Recipient gate / grants | ⚫ | ⚫ defined, not built |
| 10 Platform | Safe-area gear (eyeball) | 🟡 | 🟡 awaiting your eyeball |
| 11 Governance | Acceptance suite | 🔴 | 🟢* (18/18 on deployed; pre-push hook gates; *confirm CI secret store) |
| 11 Governance | Suite's own rule | 🟢 | 🟢 |

---

## CUMULATIVE REPORT

### PART A — LOGGED REMAINDERS (open, with reason)
- **Duress screen-identity (MANUAL · needs device):** accepted at code level (both paths → awaiting, same render; unit-confirmed). On-device eyeball is a release-checklist item.
- **Second close door (FINDING · needs decision):** user `POST /v1/events/:id/standdown` still closes on the lock code — inconsistent with coordinator-secures-only. PWA does NOT call it; latent. Left untouched (zero-regression). *Recommend retiring it like the coordinator /standdown in a directed step.*
- **Legacy-account note (needs §1):** retiring pin-as-login strands any password-less legacy account. Signup now always sets a password; recovery = Forgot Password (§1). §1 build backstops this.

### PART B — DECISIONS (resolved, applied)
Password login · single permanent closure pin never transmitted · shape rejected · recovery = reset link · capture audio+location only · evidence recipient gate · known-good tag gated on manual sign-off · reason+call-first parked.

---

## NEXT
- **Logical next section: §1 Account Management** — it builds password-login + Forgot-password, which backstops the legacy-account remainder above.
- **One decision waiting:** the **second close door** finding — say "retire the user standdown lock-code close" and it folds into §6's model in a directed step, or leave it logged.
- Floor to fall back to anytime: `known-good-2026-06-14-sec6`.
