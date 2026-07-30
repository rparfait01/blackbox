# CONSOLE BUILD — DEDICATED SESSION (33b + level indicators + 33c)

**This is the whole job. Nothing else rides alongside it. Build against docs/BLACKBOX_dashboard_mockup.html
in one pass. Do not trim to fit other work — this has been deferred four times by bundling.**

Standing constraints apply. Re-assert deploy currency at start. Migration→deploy order. Both halves
currency-asserted. Safety floor untouched. §0a Hidden byte-identical. Prove every [L] on the real surface,
not curl. Close every gap; no orphan flags.

---

## THE BOUNDARY (the point of the whole thing — server-side, not UI)
- Role + org_id come from the authenticated session, SERVER-SIDE, per request. The client only renders what
  the server already decided it may see. A hidden button is not a boundary.
- [A] Operator (DEV) is the ONLY role that crosses org boundaries. Every org-level view hard-scoped to that org.
- [A] No role — including operator — can read incident CONTENT. Counters and metadata only, never captures.

## ROLES — one shell, server-decided
| UI label | Field | Scope | Sees |
|---|---|---|---|
| DEV | platform_role='operator' | all orgs | everything + maintenance panel |
| ADMIN | org_members.role='admin' | their org | seats, all org codes, enrollments/readiness, org metrics |
| COORD | org_members.role='coordinator' | their org | issue enrollment codes, their own roster |
| UNMARKED | null + no org row | self only | (consumer/survivor — not a console user) |

- Fields unchanged (platform_role is CHECK-constrained; keep it). "DEV" is display-only, do not rename the field.
- developer@blackboxsentinel.com → DEV. royce.parfait@outlook.com → UNMARKED.
- Console lives on the PWA domain behind login (e.g. /console). Never renders in the Hidden facade.

## §1 — LEVEL INDICATOR
- Every account row shows its level: DEV / ADMIN / COORD / UNMARKED, derived from the fields above.

## §2 — 33b CONSOLE VIEWS (wire the mockup to real, server-scoped endpoints)
DEV/operator:
- List all orgs; create/vet org (returns one-time admin registration code); issue/reissue/revoke admin codes.
- System-wide counters: orgs, enrolled, activations 30d, open codes. Account-level indicators visible.
ADMIN:
- Seat management add/remove/edit; MIN-2-ADMINS enforced server-side (refuse dropping below 2).
- Issue coordinator + enrollment codes; see all org codes (status/expiry/uses); revoke.
- Enrollment roster + readiness (armed/not-ready/confirmed-contact count). READINESS ONLY — no name, number,
  location, or content.
COORD:
- Issue enrollment codes; see only codes they issued; their own roster.

- [A] All code ops reuse the unified enrollment_codes + shared atomic primitive. No new code system.
- [A] Metrics are operational counters per-scope, never derived from incident content.
- [L] Prove cross-org refusal ADVERSARIALLY — an org admin cannot reach another org by any route.
- [L] Prove content-read refused for every role.

## §3 — 33c MAINTENANCE PANEL (DEV/operator only)
Every maintenance action a button, audited (who/what/when). Destructive actions dry-run-default + explicit confirm.
- Issue code (ends manual curl issuance)
- R2 purge (existing endpoint — dry-run preview → confirm)
- System health (D1/R2 status, deployed hash, Pages==Worker currency)
- Create/vet org (returns one-time admin registration code)
- Admin codes (issue/reissue/revoke)
- Account deletion (the cascading deleteAccount — no orphaned events/R2)
- Deploy/migration state (live vs pending)

## §4 — STALE DOC
- BRIEF_30_SIGNUP_GATE.md still describes the retired Gumroad webhook. One-line fix.

## ACCEPTANCE
- [L] Sign in as each role → correct view loads; wrong-scope data absent.
- [L] Cross-org attempt refused server-side (adversarial).
- [L] No role reads incident content — endpoint refuses.
- [L] Code issue/revoke works per role on the unified table, atomic.
- [L] Min-2-admins enforced; seat removal revokes access immediately.
- [L] R2 purge dry-run shows count, confirm deletes, nothing scheduled after.
- [L] Account level indicators correct: developer@ DEV, royce.parfait@outlook.com UNMARKED.
- [L] Health panel shows D1/R2/currency. §0a Hidden byte-identical. Safety floor unregressed.

## REPORT
GOOD / BAD / CORRECT-FOR-REPAIR. Real-surface proof per item. Deployed hash, both halves asserted.
Every open item ends with who closes it and how.

## ALREADY ON ROYCE (name in report, do not mark done)
- wrangler secret delete GUMROAD_PRODUCT_ID
- Real-UI operator sign-in: developer@ → admin action → 200; royce.parfait@outlook.com → 401 (Royce performs, CC confirms)
