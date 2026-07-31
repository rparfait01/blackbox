# BRIEF 33 — THREE-ROLE DASHBOARD + OPERATOR MAINTENANCE PANEL

**Gate: §C shipped (code model final and gated). Reference design: BLACKBOX_dashboard_mockup.html.**
**Build the real console — same UI, real data, boundaries enforced SERVER-SIDE, not by hiding buttons.**

---

## §0 — THE BOUNDARY (the whole point — non-negotiable)

**Separation lives in the worker, not the UI.** Role and org_id come from the **authenticated session,
server-side, per request.** The client only ever renders what the server already decided it's allowed to see.
A hidden button is not a boundary — a determined admin opens dev tools.

- `[A]` Every dashboard query is scoped server-side by the caller's role + org_id.
- `[A]` **Operator is the ONLY role that crosses org boundaries.** Every org-level view is hard-scoped to that
  one org. Prove no endpoint lets an org admin reach another org's data.
- `[A]` No role — including operator — can read incident content. The dashboard shows counters, never captures.

## §1 — THREE ROLES, ONE SHELL

Same app, role-gated. Auth is the existing passwordless system. Role decides what loads.

| Role | Source of power | Scope | Sees |
|---|---|---|---|
| **Operator** (Royce) | `ADMIN_TOKEN` / operator identity | All orgs | Everything + maintenance panel |
| **Org Admin** | account role + org_id | Their org | Seats, all org codes, enrollments, org metrics |
| **Coordinator** | account role + org_id | Their org | Issue enrollment codes, their own roster |

- Lives on the PWA domain, behind login (e.g. `/console`). Never renders publicly, never in the Hidden facade.
- A survivor signing in sees the covert app; a role-bearing account sees the console. Same door, different room,
  decided server-side.

## §2 — WHAT EACH ROLE DOES (wire the mockup to real endpoints)

**Operator:**
- List all orgs, create/vet an org (`POST /v1/admin/orgs` — exists), issue/reissue/revoke admin codes.
- System-wide counters: orgs, enrolled, activations 30d, open codes.

**Org Admin:**
- Seat management — add/remove/edit coordinator. **Min-2-admins enforced server-side** (refuse dropping below 2).
- Issue coordinator + enrollment codes; see all org codes with status/expiry/uses; revoke.
- Enrollment roster + readiness (armed/not-ready/confirmed-contact-count). **Readiness only — no name, number,
  location, or content.**

**Coordinator:**
- Issue enrollment codes; see only the codes they issued; their own enrollment roster.

- `[A]` All code operations reuse the §B unified `enrollment_codes` + shared atomic primitive. No new code system.
- `[A]` Metrics are operational counters only, per-scope, never derived from incident content.

## §3 — OPERATOR MAINTENANCE PANEL (operator only)

Every maintenance action a button, not a curl. Operator-scope, audited.

| Action | Backing | Behavior |
|---|---|---|
| **R2 purge** | existing purge endpoint | **Dry-run preview first**, then explicit confirm. Shows count + size before delete. Never one-click mass delete |
| **System health** | `/health` | D1 + R2 status at a glance; deployed hash; Pages==Worker currency |
| **Create / vet org** | `POST /v1/admin/orgs` | Form → returns the one-time admin registration code |
| **Admin codes** | existing endpoints | Issue / reissue / revoke, with audit |
| **Controlled account deletion** | see §4 | Cascades properly — never orphans events or R2 |
| **Pending migrations / deploy state** | — | Visibility into what's live vs committed-not-deployed |

- `[A]` Every destructive action (purge, delete) is **dry-run/preview by default** and requires explicit confirm.
  No malformed or empty request ever triggers a mass delete.
- `[A]` Every maintenance action is audit-logged: who, what, when.

## §4 — FIX deleteAccount() WHILE HERE (the orphan bug)

`deleteAccount()` currently removes the user + contacts but **not their events, and not their R2 audio** — this
is what created 10,700 orphaned recordings.

- `[A]` Account deletion must **cascade**: user → events → chunks_index → R2 objects → contacts → related rows.
  No orphaned events, no orphaned R2 audio.
- `[A]` Prove it: delete a test account, confirm zero orphaned events and zero orphaned R2 objects remain.
- This is what makes the maintenance panel's account-deletion safe.

## §5 — GUARDS

- `[A]` §0a: the console is operator/org-side only. NOTHING about it renders in a survivor's Hidden facade.
- `[A]` Server-side scoping on every query — prove no cross-org path, prove no content-read path.
- `[A]` Trigger/capture/closure/dispatch untouched — this is a new surface, not a change to the safety floor.
- `[A]` Destructive maintenance actions are dry-run-default + confirm + audited.

## ACCEPTANCE

- `[L]` Operator sees all orgs + maintenance panel; org admin sees only their org; coordinator sees only their
  codes/roster. Proven by signing in as each.
- `[L]` **Cross-org attempt refused server-side** — org admin cannot reach another org by any route.
- `[L]` **No role can read incident content** — prove the endpoint refuses/returns nothing.
- `[L]` Code issue/revoke works per role, on the unified table, atomic.
- `[L]` Min-2-admins enforced; seat removal revokes access immediately.
- `[L]` R2 purge: dry-run preview shows count, confirm deletes, nothing scheduled after.
- `[L]` deleteAccount cascades — no orphaned events or R2 objects.
- `[L]` Health panel shows D1/R2/currency. §0a Hidden byte-identical. Safety floor unregressed.

## DONE
One dashboard shell, three server-scoped roles, operator the only cross-org view, incident content unreadable by
anyone. Code management on the unified table. An operator maintenance panel with dry-run-default purge, health,
org creation, admin codes, and cascading account deletion — every maintenance action a button, audited.
deleteAccount fixed to never orphan. Committed, pushed, both halves currency-asserted.
