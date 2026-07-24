# BRIEF 25 — ANONYMOUS INCIDENT TALLY ("it happened")

**Entry point:** a button in **Settings** — *"Report anonymously."*
**Under a minute. Four taps. No account of what happened.**

**This is NOT a report of an incident. It is an acknowledgment that one occurred.**
The survivor is saying: *I don't want to say anything, but I want it counted.*

---

## §0 — TWO DIFFERENT INSTRUMENTS (do not merge them)

| | **Brief 27 — Guided Intake** | **Brief 25 — Anonymous Tally (this)** |
|---|---|---|
| Answers | *What happened* | *That something happened* |
| Output | Structured case file | A tally mark |
| Effort | Long, emotionally heavy, FETI-paced | Four taps |
| Identity | Identified, survivor's own | **Severed — no identity exists** |
| Storage | ZK custody, survivor owns it | Severed public-good store |
| Destination | Personal case file → legal aid/counsel | Open public statistics |

**Purpose of this brief:** close the gap on **unreported** sexual assault, sexual harassment, and domestic
violence. Official statistics only count what gets reported. This counts what doesn't.

`[A]` These two paths share no code, no schema, and no store. They must not be unified "for reuse."

---

## §1 — SEQUENCING NOTE (this does not need ZK)

Earlier sequencing put anonymized stats behind the ZK rebuild, because it was conceived as an *export of intake
data*. As a standalone tally it holds **no identified data at all** — there is nothing to encrypt and nothing to
protect by encryption. **It is independent of Brief 3.**

- Can execute after **Brief 23 (Tenancy)**. Does not wait for ZK.
- `[A]` **Hard condition:** it must never become a path that reads, derives from, or joins to identified data.
  If a proposed implementation touches capture or event data in any way — **stop and report.**

---

## §2 — THE FORM (this is the entire schema)

| Field | Type | Purpose |
|---|---|---|
| **What kind** | Sexual assault · Sexual harassment · Domestic violence · Other · Prefer not to say | Reporting gaps differ by type; without this the count is unusable |
| **Roughly when** | This month · Past 3 months · Past year · Longer ago · Prefer not to say | Time series |
| **Roughly where** | Region-level select (never finer) | Maps to a jurisdiction |
| **Was it reported to anyone official?** | Yes · No · Prefer not to say | **This is the gap measurement** |

**That's it. Four questions. Every one skippable.**

**Explicitly NOT collected** — each of these is *an account of what happened*:
- ❌ Relationship to the person who did it
- ❌ Weapon, coercion, force, injury
- ❌ Exact date or time
- ❌ Address, venue, or anything finer than region
- ❌ **Any free text, ever** — free text is re-identifying and this form has no place to type
- ❌ Case numbers, report numbers, agency names, officer names

`[A]` The schema has **no free-text column.** Not optional, not hidden, not "notes." None.

### Why the reported-to-anyone question is the point

If it was reported, it likely already exists in official statistics. If it wasn't, it exists **nowhere else in the
world.** That single flag is what turns a pile of tallies into a measurement of the unreported gap — and it lets
any agency de-duplicate against their own records without ever touching a person.

---

## §3 — SEVERANCE (structural, not promised)

- `[A]` Separate store. **No foreign key, no join path, no derivation link** to any account, device, capture,
  event, session, or org.
- `[A]` **Never auto-populated from a capture or event.** Auto-fill is a derivation path; a derivation path is a
  re-identification path. Fresh entry only.
- `[A]` Not stored: account id, device id, IP, session token, push token, precise timestamp, org association.
- `[A]` Record the **submission month**, not the instant — submission timing must not become an identifier.
- `[A]` Being signed in does not link the submission. The account authenticates the *session*; it is never
  written to the *record*.

## §4 — INTEGRITY (rate limiting without linkage)

A click-through tally can be spammed, and poisoned counts are worse than no counts.

- `[A]` Rate-limit **per account** (e.g., a small number per period). The **counter lives on the account; the
  submission never references the account.** Limit the sender, store the record severed.
- `[A]` No bulk submission, no API accepting submissions on someone's behalf, no org submission path.
- `[A]` If a rate limit is hit, say so plainly. Never silently discard a submission — a survivor must never
  believe something was counted when it wasn't. (Same honest-status rule as the alert path.)

## §5 — CONSENT (one screen, before submit)

> **This is anonymous.**
> It records only that something happened — not what happened, and nothing about you.
> Because it can't be traced to you, it also **can't be taken back.**
> It may be published as part of public statistics on unreported violence.
>
> [ See exactly what will be sent ]  ·  [ Submit ]  ·  [ Cancel ]

- `[A]` Per-submission. **No blanket consent, no remembered preference, no default-on.**
- `[A]` The survivor can view the literal payload — four values — before submitting.
- `[A]` Cancel available at every step.

## §6 — ACCESS & PUBLICATION

| Party | Access |
|---|---|
| **Public — agencies, researchers, coalitions** | The published aggregate, open license, independent of BLACK BOX |
| **BLACK BOX** | Operates the pipeline. **Does not own, sell, mine, or monetize it.** |
| **Orgs** | No privileged access — same public data as everyone |
| **Anyone** | Cannot re-identify: there is no identity stored to recover |

- `[A]` Publish **aggregate counts**, not individual rows.
- `[A]` Suppress any cell below a small-count threshold (default ≥ 10). In a small region, a single row in a rare
  category can still point at a person even with four fields — **suppression is the default.**
- `[A]` No BLACK BOX-owned analytics or monetization path touches this store. The dataset is a public good and
  outlives us.

## §7 — GUARDS

- `[A]` §0a: Settings-side only. **Never in the Hidden facade**, never a tell.
- `[A]` **Never surfaced during an active alert.** This is a calm, deliberate act — never taken under duress.
- `[A]` Nothing in this flow alters trigger, capture, closure, custody, or notification.

---

## ACCEPTANCE

- `[L]` Settings → *"Report anonymously"* → four taps → submitted, in under a minute.
- `[A]` Prove severance: no FK, no join path, no derivation link. Grep and demonstrate.
- `[A]` Prove no free-text column exists in schema or UI.
- `[A]` Prove no auto-population from capture or event exists.
- `[L]` Rate limit enforced per account; the account id appears **nowhere** in the stored record.
- `[L]` Rate-limit rejection is surfaced honestly, never a silent discard.
- `[L]` Consent screen shows the literal payload and states it cannot be withdrawn.
- `[L]` Small-count suppression: a deliberately rare combination is suppressed from publication.
- `[L]` §0a Hidden byte-identical; unreachable during an active alert; safety floor unregressed.

## DONE
A four-tap anonymous tally in Settings that records **that** an incident occurred and whether it was ever
officially reported — nothing more — structurally severed from identity, rate-limited without linkage,
per-submission consent, published as suppressed aggregates under an open license that BLACK BOX operates but does
not own. Committed; both deploy halves currency-asserted; phone sign-off.

**CHAIN:** **25 (this) is INDEPENDENT** — needs accounts only. Runs any time. 23 → 24 → 26 → 27 is the other track.
