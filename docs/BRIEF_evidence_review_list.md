# BRIEF — EVIDENCE REVIEW LIST + REMOVE DUPLICATE SETTINGS ENTRY

**Two fixes. Root cause, not patches. §0a Hidden byte-identical. Trigger/capture/classifier untouched.
Both halves currency-asserted. Prove [L] on real device.**

---

## §1 — REMOVE THE DUPLICATE
- `[A]` Remove the standalone **"Written account"** Settings entry. The survivor's written account is already
  captured inside the Official Report's user section — a separate entry is a duplicate and a conflation.
- `[A]` Settings has exactly THREE entries: **Report Anonymously · Official Report · Evidence Review.**

## §2 — EVIDENCE REVIEW IS BROKEN: captures exist but cannot be opened
Captures are associated with the account but Evidence Review does not surface or open them. Fix the access.
- `[A]` Root-cause why an account's own captures are not accessible in Evidence Review (encryption is on;
  decrypt-on-device should work). Name the cause — is it listing, key access, or the decrypt path — and fix it.
- `[A]` Evidence Review lists ALL of the account's captures and each one opens and plays (decrypted on device,
  read-only, server never sees plaintext).

## §3 — MULTI-CAPTURE LIST VIEW
When more than one capture exists, Evidence Review shows a **list**:
- `[A]` Each row shows the capture **date/time in `DDMMMYY@HH:MM` 24-hour format** (e.g. `29JUL26@23:26`),
  derived from the event timestamp.
- `[A]` Each capture is **renameable** — the survivor can set a label for tracking / record management
  (e.g. "kitchen incident"). The rename persists to HER record (sealed under her key), and **never alters the
  signed evidence** — it's a label on top, not a change to the capture.
- `[A]` Tapping a row opens that capture in the review player (playback per Item C: play/pause/stop, frame held
  on pause).
- `[A]` List ordered newest-first (or clearly ordered) so records are easy to find.
- `[A]` Single capture → opens directly or shows a one-row list; multiple → the list. No dead end either way.

## §4 — GUARDS
- `[A]` §0a: Evidence Review + the list live on the Visible/app side only, never in the Hidden facade.
- `[A]` Rename is a label on the survivor's record; the signed evidence zone is untouched (chain of custody
  intact — a renamed capture still verifies).
- `[A]` Trigger/capture/classifier/closure untouched.

## ACCEPTANCE (real device)
- `[L]` Settings shows three entries; no "Written account".
- `[L]` An account with captures opens and plays them in Evidence Review (was inaccessible → now accessible).
- `[L]` Multiple captures → list with `DDMMMYY@HH:MM` timestamps; each opens.
- `[L]` Rename a capture → label persists, survives reload, and the capture still verifies (signed evidence
  unchanged).
- `[A]` §0a Hidden byte-identical; decrypt on device only (server never sees plaintext).

## REPORT
GOOD / BAD / CORRECT-FOR-REPAIR. Name the root cause of the inaccessible-evidence bug. Real-device proof.
Confirm rename never touches signed evidence. Deployed hash, both halves asserted.
