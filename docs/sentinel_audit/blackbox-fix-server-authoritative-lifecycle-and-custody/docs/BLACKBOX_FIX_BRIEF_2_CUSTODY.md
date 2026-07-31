# BLACK BOX — Fix Brief 2: Custody, Identity & Integrity Layer

Work order for Claude Code. Extends Fix Brief 1 (the P0–P2 bug brief). Same stack:
PWA/native client + Cloudflare Workers + D1 + R2, deployed via wrangler.

**Rules of engagement:**
- Run each DIAGNOSE step and report findings before applying the FIX.
- Do not weaken Fix Brief 1's server-authoritative model; this layer sits on top of it.
- Canonical storage is always UTC + timezone offset. Local time and DTG are render-only.
- The 36-month vault and tamper alerts are routed to the **operator's** designated security
  contact (configurable per deployment), NOT hardcoded to the founder. For the family pilot,
  the operator IS the founder.

---

## C1 — Recipient identity (mint-on-access; no federated authority ID)

DIAGNOSE
- Inspect the current token model (HMAC, per-role scope). Does claiming a dispatch/export
  token capture any identity, or is access anonymous once the link is held?

FIX
- There is no external authority identity system, so BLACK BOX mints its own. The first time a
  dispatch or export token is claimed, require the recipient to register before any evidence
  renders: full name, agency/organization, role or badge reference, and a contact (email or
  phone) that is verified with a one-time challenge to bind it.
- Generate an immutable recipient ID (e.g. `RCP-{uuid}`) and bind it to the token and to every
  subsequent action that recipient takes. No anonymous access to evidence, ever.
- Record the identity record append-only: who, agency, contact, verification status, first-seen DTG.

---

## C2 — Integrity & tamper-evidence (provable, not assumed)

DIAGNOSE
- Are R2 media objects and D1 event rows currently hashed or signed? Report what integrity, if any, exists.

FIX
- On write, hash every media chunk and every event row (SHA-256).
- Chain them: each record carries the prior record's hash (append-only hash chain), so any
  alteration breaks the chain from that point forward.
- Sign the chain head with a server-held key. Produce a signed manifest for any export.
- Ship a standalone verification routine (a script the recipient/court can run) that confirms a
  package is unaltered. Changing a single byte must fail verification. Tampering = hash/signature mismatch.

---

## C3 — Export = custody transfer + sealed vault

DIAGNOSE
- Find the current export/download path (if any). Does it record who/what/when?

FIX
- On export: assemble the package (media + event record + signed manifest), record a
  custody-transfer event (recipient ID from C1, DTG, full package hash), and hand the recipient
  their verifiable working copy.
- Seal the canonical original into an immutable archive vault: write-once, no delete before
  expiry, **36-month retention**. The original never "leaves" — a sealed, verifiable reference
  remains; the recipient holds a copy that references the same package hash.
- The vault lives under the operator/controller's storage, not the author's. For E2E-encrypted
  deployments the vault holds ciphertext only.

---

## C4 — Tamper alert & investigation

DIAGNOSE
- Confirm there is currently no integrity-monitoring or alerting on stored/exported artifacts.

FIX
- Run scheduled integrity checks against vault artifacts; where feasible, challenge the recipient's
  held copy for its package hash.
- On any mismatch or failed/ignored challenge: fire an alert to the deployment's security contact,
  open an investigation record (event ID, recipient, what failed, DTG), and track it to a logged
  resolution.
- Be honest in the design about scope: the system makes tampering **provable** and records who held
  the data — it cannot compel anyone's cooperation. The leverage is an immutable, admissible record.

---

## C5 — Recipient / agency trust scoring

DIAGNOSE
- None expected to exist; confirm.

FIX
- Maintain a trust record per recipient and per agency: identity verified?, custody acknowledged?,
  integrity challenges answered?, cooperated in investigations?, response latency.
- Derive a trust score and annotate non-cooperation against the recipient/agency record.
- Keep it an internal operational record framed as accountability, not public judgment. Surface it so
  the operator can see agency reliability and so routing can favor higher-trust recipients later.

---

## C6 — Timestamps (UTC canonical, local/DTG render)

DIAGNOSE
- Find current timestamp handling. Is anything stored in local time only?

FIX
- Store UTC + timezone offset on every record. Never store local-only (it breaks ordering and
  integrity across regions).
- Render: the initial event report header in DTG format (DDHHMM Z MMM YY); all subsequent log
  entries in the event's local time. One formatter, two render modes.

---

## ACCEPTANCE CRITERIA

1. Evidence cannot be opened or exported without a verified recipient identity bound to the access. (C1)
2. An exported package verifies as unaltered; flipping one byte fails verification. (C2)
3. Every export is recorded as a custody transfer with recipient ID + DTG + package hash, and a
   sealed copy persists in the operator-controlled vault for 36 months. (C3)
4. A tampered vault artifact or a failed recipient-copy challenge fires an alert to the deployment's
   security contact and opens an investigation record. (C4)
5. Every recipient and agency has a trust record reflecting identity verification, custody
   acknowledgment, and cooperation. (C5)
6. All records store UTC + offset; the initial report renders DTG; later entries render local time;
   sorting by timestamp is correct across regions. (C6)
