# BLACK BOX — Fix Brief 6: Live Test 5 Findings

Work order for Claude Code. Device-verify everything — code-level fixes have failed on the
phone repeatedly. The stand-down close path must have exactly ONE door: the verified code.
A refresh is not a door. A call is not a door.

---

## P0 — Stand-down still circumventable (refresh bypass)

**LT5-1 — Requesting stand-down, then refreshing the window, closes the alert without the
verified code.**
- Diagnose: the "request stand-down" action sets a client or server pending state that a
  refresh finalizes into a close, OR the page re-init on refresh closes the event. Find the
  exact path.
- Fix: a stand-down *request* must NOT change event status. Only `POST /standdown` with the
  verified code sets `status=closed`, server-authoritative. On refresh, the client re-hydrates
  from the server's current status — an active alert stays active and the active-alert UI
  resumes. Remove any pending/soft-close state that a refresh can finalize. One close door only.

## P0 — Guardian dashboard blocked by the share-with-authorities modal

**LT5-2 — The modal opens automatically on dashboard load and covers the live view.**
- Fix: the dashboard loads to the live view. The modal opens ONLY when the guardian taps
  "Share with authorities."

**LT5-3 — The modal has no QR and no copyable URL.**
- Fix: populate it from `/v1/c/:id/dispatch-link` (server-generated QR + copyable link).

**LT5-4 — The "Share with authorities" button does not function.**
- Fix: wire it to mint the dispatch token and open the populated modal. The Brief 4 cookie-path
  fix did not hold on device — re-verify the request actually succeeds (watch for 401/empty).

**LT5-5 — The modal's close / cancel button does not function (guardian is trapped).**
- Fix: the close handler dismisses the modal and returns to the live dashboard.

---

## P1 — Permissions re-prompt on every activation

**LT5-6 — Mic + location "ask permission" pops on every initiation. Dangerous mid-emergency.**
- Diagnose: is the app installed as a standalone PWA (browser tabs re-prompt every session)?
  Did onboarding priming complete? Is getUserMedia / geolocation re-requested fresh each
  activation instead of reusing a held grant?
- Fix: complete priming at onboarding and reuse the granted stream/watch; never prompt on the
  activation path. Full persistence is the native-shell ceiling — but a per-activation re-prompt
  on Android is beyond that ceiling, so find the bug.

## P1 — Remove support contact

**LT5-7 — "Remove" shows removed, but the name/info persist.**
- Fix: remove must delete the contact record server-side; the UI reflects the real server state.

**LT5-8 — Add a confirmation prompt before clearing.**
- "Are you sure you want to clear your support contact?" — clear only on confirm.
- Note: during an active alert, contact changes must remain blocked (Brief 4 A3 / S1).

---

## ACCEPTANCE CRITERIA (verify on a physical phone)

1. Request stand-down, then refresh — the alert stays ACTIVE. Only the verified code closes it.
2. The guardian link opens to the live dashboard with NO modal. Tapping "Share with authorities"
   opens a modal with a working QR + copyable link, and the close button dismisses it.
3. After onboarding, activation does not prompt for permissions (no per-activation prompt on
   Android).
4. Removing a support contact asks for confirmation and actually clears the data.
