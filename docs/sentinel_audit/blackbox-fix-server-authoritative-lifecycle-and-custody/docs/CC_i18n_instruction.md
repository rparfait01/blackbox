# CC — i18n SCAFFOLD + JP LAUNCH/ONBOARDING (build after Ikumi returns approved strings)

**Do NOT invent or machine-translate Japanese. Wire in ONLY the strings Ikumi approves. Until approved strings
exist for a screen, that screen stays English.**

Standing constraints apply. §0a byte-identical, safety floor untouched, both halves currency-asserted.

## §1 — i18n SCAFFOLD (build now; it's the framework the rest hangs on)
- Add a lightweight i18n layer: a strings file per locale (en, ja), a key→string lookup, a locale setter that
  persists the choice (not localStorage inside the facade — use the app's existing persistence).
- Every user-facing string on the LAUNCH and ONBOARDING/SIGN-IN surfaces becomes a key, not a literal.
- Default locale: en. Missing ja key → fall back to en (never a blank or a key name shown to a user).
- `[A]` The scaffold changes NO behavior — only how strings are sourced. Prove the EN surface is byte-identical
  in output before any JP is added.

## §2 — LANGUAGE TOGGLE on the launch/landing screen
- EN / 日本語 selector on the launch screen; persists; applies immediately to launch + onboarding + sign-in.
- Labels shown each in its own language: "English" / "日本語".
- `[A]` §0a: the toggle and all JP strings render ONLY on the launch/app-entry + Visible surfaces. NEVER in the
  Hidden facade. The facade stays exactly as-is (its own localization is a separate future pass, not this one).

## §3 — WIRE APPROVED JP STRINGS (launch + onboarding only)
- Populate the ja strings file from Ikumi's approved table (30-ish keys). Exact text as she returns it —
  no edits, no "improvements", no auto-translation of anything she left blank.
- Emergency number in JP copy is 110 / 119 per her approval — NOT 911. Confirm the rendered JP launch copy shows
  the JP numbers.

## §4 — HARD LIMITS (do not cross without a separate approved pass)
- `[A]` Do NOT translate the covert facade (Stillpoint/breathing) — leave English/as-is. JP facade is a separate
  cultural-localization pass.
- `[A]` Do NOT translate trigger / alert / live-status / closure / consent strings. Those are not in scope and
  are safety-critical — English until a dedicated reviewed pass.
- `[A]` If a key has no approved JP value, it falls back to EN. Never machine-fill it.

## ACCEPTANCE
- `[L]` Launch screen: toggle EN↔日本語 flips launch + onboarding + sign-in copy; choice persists across reload.
- `[L]` JP launch copy shows 110/119, never 911.
- `[L]` A key with no JP value falls back to EN cleanly (no blank, no raw key).
- `[A]` §0a: Hidden facade byte-identical; toggle/JP never render there.
- `[L]` Safety floor unregressed; trigger/alert/status still English and unchanged.

## REPORT
GOOD / BAD / CORRECT-FOR-REPAIR. Prove the toggle on the real surface. Confirm which screens are JP-enabled and
which remain EN by design. Deployed hash, both halves asserted.
