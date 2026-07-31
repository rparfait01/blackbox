# BLACK BOX — Last Resort Protocol

**Version:** 1.0
**Status:** Spec for v2 Recorder + Authority Portal
**Companion docs:** `AUTHORITY_VIEW_SPEC.md`, `BLACK_BOX_HARDWARE_ROADMAP.md`

---

## 0. The use case this exists for

The base product is designed for the *acute moment* — an attack in progress, a panic situation where the user activates the device themselves. This protocol handles a different, harder category:

> **When the user can't speak for themselves anymore.**

- A vacation traveler in mental health crisis walks into a forest. Phone off. Found too late.
- An elderly relative with dementia leaves home. Last seen on a security camera, then gone.
- A solo hiker doesn't return. Cell signal lost hours ago.
- A loved one stops responding to messages. Their phone goes to voicemail. Nobody knows where they are.
- A possible kidnapping. Phone went dark. Active investigation, no leads.

In each of these, the family or close circle hits the same wall: the person is somewhere, but every channel of communication is dead. The phone is off. The Find My network last pinged 14 hours ago. Police can issue a missing-person report but their tooling for tracking starts from zero.

The Last Resort Protocol gives the user's most trusted people a pre-authorized way to ask the device itself for help.

---

## 1. Three coupled capabilities

The protocol consists of three engineered systems that work together:

| Capability | What it does | Required tier |
|---|---|---|
| **Guardian tier** | A higher-trust contact role with verified identity and consent-based reverse activation rights | Software |
| **Reverse activation** | Allows guardians to remotely trigger the device when the user is unreachable | Software + hardware (LTE-M minimum) |
| **Independent signal** | Device transmits to cloud via its own cellular/satellite path, independent of phone | Hardware v2 only |
| **Authority portal** | Self-serve verified-credential access for police/EMS/embassies to query the system | Software + ops |

Each can be implemented independently, but they reach full value together. The recommended sequence: guardian tier first (software-only, can launch on Lite tier), independent signal second (v2 hardware), reverse activation third (requires both), authority portal last (requires ops/legal work).

---

## 2. Guardian tier — verified high-trust contact

### 2.1 Why this tier exists

A normal designated contact gets the alert during an active emergency. They see what the user is broadcasting. The system is reactive to the user.

A **Guardian** is someone who can take action *on the user's behalf* when the user cannot. This is a fundamentally different trust relationship. The legal analog is closer to "medical power of attorney" than "emergency contact." The verification requirements scale accordingly.

### 2.2 Who qualifies in real life

- Spouse / long-term partner
- Parent (for users who are minors or who have specifically authorized their parent)
- Adult child (for elderly users who have designated)
- Sibling with close relationship
- Long-trusted close friend
- Designated legal representative

Who does NOT qualify by default (require additional verification or are blocked outright):
- New relationships (under 12 months of demonstrated contact history)
- Ex-partners, even amicable
- People who have ever had a restraining order against them filed by the user
- People with documented domestic violence convictions against the user (insofar as discoverable)
- Acquaintances or casual friends

### 2.3 Verification protocol

To designate someone as a guardian, both parties complete this sequence:

**Step 1: User initiates**
User opens BLACK BOX → Settings → Guardians → Add Guardian → enters guardian's contact info.

**Step 2: Identity verification (user)**
User uploads government ID. System runs through ID-verification provider (Stripe Identity, Persona, or similar — ~$2 per verification, paid by user as one-time fee).

**Step 3: Identity verification (guardian)**
Guardian receives invitation. Completes same ID verification process from their device.

**Step 4: Live video confirmation**
System schedules a brief live video call between user and guardian. Both must be visible. Brief script confirms the user understands what guardian access means and freely consents. Recorded for legal record.

**Step 5: 72-hour cooling-off period**
After all verification complete, the guardian capability is *pending* for 72 hours. During this window:
- The user can cancel the designation with no friction
- Reverse activation is NOT available
- Guardian sees their status as "pending"

This cooling-off prevents coercion. An abusive partner cannot force the user to designate them as guardian in a moment of duress; the user has 72 hours during which they can quietly reverse the decision.

**Step 6: Active guardian status**
After cooling-off, guardian capability becomes active. Maximum two guardians per user. Adding a third requires removing one first (and removal is instant, no cooling-off in the revocation direction).

**Step 7: Re-confirmation every 90 days**
Guardian capability expires every 90 days. User must re-confirm with a single tap. If they don't, capability lapses automatically.

### 2.4 What guardians can do

| Capability | Default | Configurable by user |
|---|---|---|
| Receive all normal emergency alerts | Yes | No (always on) |
| See full dashboard during active emergency | Yes | No |
| See user's location at any time | No | User can opt-in (e.g., elderly parent) |
| Initiate reverse activation (see §3) | Yes | User can disable per-guardian |
| Trigger periodic check-in cascade | Yes | User can disable per-guardian |
| Mark user as "missing — please find" | Yes | User can disable |
| Approve emergency data release to authority | No | User can opt-in |
| Override user's data-deletion request | Never | Never (no override exists) |

### 2.5 What guardians cannot do, ever

These are hard system limits, not user-configurable:

- Modify user's settings
- See user's BYOK API keys or any encrypted data
- See user's past activations the user has marked private
- Speak through the device (no two-way audio)
- Activate the device's deterrent modes (piezo, strobe)
- Cancel the user's hold-to-cancel during active emergency
- Reveal user's location to anyone outside the existing contact tree without the user's consent
- Permanently disable the user's revocation capability

### 2.6 Revocation

User can revoke a guardian at any time, from the device, with biometric confirmation (Face ID / Touch ID / passphrase). Revocation is:
- Instant
- Irreversible by guardian
- Notified to guardian (so they know they no longer have access)
- Logged in the audit trail

If the guardian had an in-progress reverse activation, revocation cancels it immediately.

---

## 3. Reverse activation — guardian-initiated emergency

### 3.1 The flow from guardian's side

Guardian opens their BLACK BOX app or web portal. Sees their guardian-of relationships. For a user who is unreachable:

1. Tap "Request emergency activation" for that user
2. Fill mandatory reason field — minimum 50 characters, plain-language explanation of why
3. Confirm understanding: *"This will activate [name]'s device. They will be notified. The action will be permanently logged."*
4. Submit

System validates:
- Guardian status is active and not expired
- Two-guardian rule satisfied (or single-guardian + third-party notification triggered)
- No abuse pattern flags

If validated, the system initiates the cascade.

### 3.2 The cascade

```
T+0s:    Guardian submits request
T+0s:    User receives push notification, SMS, and LINE message:
         "[Guardian name] is requesting emergency activation. 
         Tap to cancel or confirm you're safe."
T+0s:    User has 15 minutes to respond
T+15min: If no user response, device wakes:
         - Cellular/satellite ping reports last-known position
         - If device is in range of paired phone, normal activation triggers
         - If not, device activates standalone (recording, GPS, tamper monitoring)
T+15min: Dashboard goes live for guardian and any other designated contacts
T+30min: Authority notification cascade if configured by user
         (default: not auto-notify; user must have opted in)
```

The 15-minute response window is the most important interval in this entire protocol. It's the user's chance to say "I'm fine, leave me alone," before surveillance begins.

### 3.3 The two-guardian rule

If the user has designated two guardians, reverse activation requires **both** to initiate within a 30-minute window. The system holds the first request pending; once the second arrives, the cascade begins.

If only one guardian is designated, the cascade can proceed with that single guardian, but:
- A third-party notification triggers automatically (e.g., to a regional police non-emergency line, or to a non-guardian secondary contact)
- The notification states: *"Single guardian has initiated reverse activation on [user]. No second-party check. Proceeding."*

This creates external visibility on single-guardian requests, raising the cost of abuse.

### 3.4 The user's response options

When notified, the user has three options:

| Response | Effect |
|---|---|
| **"I am safe — cancel"** | Cascade aborts. Logged in audit trail. Optional: user can flag the guardian's request as inappropriate (which strikes against that guardian's record). |
| **"I need help"** | Treats as a normal emergency activation. Full cascade fires immediately. |
| **No response within 15 minutes** | Cascade proceeds. Device wakes, transmits, records. |

If the user is unreachable because they cannot respond (unconscious, incapacitated, dead), the 15-minute window passes silently and the protocol does its job.

If the user is unreachable because they don't want to be found (running away from a bad situation, taking a break from family), they can still cancel within 15 minutes if they happen to look at their phone — the notification arrives by every channel possible.

This isn't perfect. The 15 minutes is a balance. Longer = more abuse risk and longer to help. Shorter = more false positives where someone is just busy or asleep.

### 3.5 What reverse activation produces

Once the cascade fires and the user has not canceled:

- Device pings its current location via whatever channel is available (cellular/satellite/Find My piggyback)
- If device can hear paired phone, full normal recording activates
- If standalone, device begins independent recording to local storage
- Cached audio/video from device storage gets uploaded as bandwidth allows
- Dashboard becomes available to guardian + any designated emergency contacts
- Dashboard tag: `[REVERSE-ACTIVATED]` — visually distinct from a self-activation
- The reason text submitted by guardian is shown prominently on the dashboard

This last detail matters: anyone viewing the dashboard sees the guardian's stated reason. Accountability is built into the surface. If guardian wrote *"My ex-girlfriend is at a party and I want to know if she's with someone,"* that text is visible. The dashboard becomes its own audit trail.

### 3.6 Abuse pattern detection

The system monitors for misuse:

- More than 2 reverse activations in 30 days from same guardian → flag
- Reverse activations consistently followed by user's "I am safe" cancellation → flag
- Reason text consistently vague or repetitive → flag
- User has marked previous reverse activations as inappropriate → flag

Flagged guardians:
- User is notified discreetly: *"[Guardian] has used reverse activation in ways that may suggest concern. Review activity?"*
- System suggests revocation if patterns persist
- Repeat offenders eventually get auto-revoked with notification to both parties

---

## 4. Independent device signal

The device must function without the phone. This is what makes the system actually useful in the worst cases — when the phone is off, broken, taken, or out of signal.

### 4.1 Connectivity options

The v2 Recorder ships with multiple connectivity paths, used in priority order:

```
Priority 1: WiFi Direct to paired phone (high bandwidth, free)
Priority 2: BLE to paired phone (low bandwidth, free)
Priority 3: LTE-M cellular IoT (medium-low bandwidth, subscription)
Priority 4: Apple Find My network piggyback (passive, free)
Priority 5: Iridium satellite (Adventure SKU only, low bandwidth, premium subscription)
```

If priorities 1 and 2 fail (phone offline or destroyed), the device transitions to 3 and 4 automatically.

### 4.2 LTE-M — the standard backup

**Technology:** Low-power cellular IoT standard. Quectel BG95 module or similar. Coverage in most populated regions globally.

**Hardware cost:** ~$15–25 BOM addition. ~$30 retail markup.

**Subscription:** ~$5–15 per device per year, depending on volume. We absorb the first 3 years into the device purchase price; user covers years 4+ at cost.

**Bandwidth:** Sufficient for the emergency payload (see §4.5). Audio upload at 8-16 kbps (telephony-grade) is achievable. Not sufficient for video.

### 4.3 Apple Find My piggyback — the free fallback

Apple's Find My network has hundreds of millions of nodes (every iPhone in proximity). When the v2 Recorder is in low-power signal-broadcasting mode, it can emit a Find My-compatible beacon. Any nearby iPhone picks it up and relays an encrypted location ping to Apple's network.

**Hardware cost:** Negligible. Uses existing BLE radio.

**Subscription:** None. Free.

**Coverage:** Anywhere iPhones exist. In urban areas, location resolves to meters. In rural areas, can be hours/days between pings.

**Limitations:**
- Apple's MFi (Made for iPhone) program is required. Approval process takes 6-12 months. Worth pursuing post-launch.
- Google has an equivalent (Find My Device network) that can supplement.

### 4.4 Iridium satellite — the wilderness SKU

For users who need coverage anywhere on Earth (international travelers, wilderness adventurers, journalists in conflict zones):

**Technology:** Iridium 9603N modem or similar. Truly global coverage including oceans and remote terrain.

**Hardware cost:** +$40–60 BOM. Significantly larger antenna requirement (changes form factor).

**Subscription:** $15–50 per year. Garmin inReach has established the market.

**SKU positioning:** "BLACK BOX Recorder Adventure" — $499–599 retail.

### 4.5 Emergency broadcast packet

When the device transmits independently, the payload is bandwidth-constrained but useful. Recommended structure (~400 bytes):

```json
{
  "device_id": "bb-a7f3-8e2c-4d",
  "owner_hash": "<sha256 of owner identifier, not the owner's real ID>",
  "broadcast_type": "self-activation" | "reverse-activation" | "tamper" | "scheduled-checkin",
  "timestamp_utc": "2026-06-09T22:14:02Z",
  "gps": {
    "lat": 26.3344,
    "lon": 127.7894,
    "accuracy_m": 4,
    "altitude_m": 12,
    "is_indoor_likely": false
  },
  "last_movement_utc": "2026-06-09T21:58:11Z",
  "movement_pattern": "stationary | walking | vehicle | unknown",
  "battery_pct": 23,
  "estimated_runtime_hours": 8,
  "storage_pct_full": 35,
  "tamper_status": "intact | switch | mesh | photodiode | shock",
  "audio_cached_bytes": 1843200,
  "audio_streamable": true,
  "signal_path": "lte-m | satellite | findmy",
  "sequence": 47,
  "signature_hmac": "<256-bit HMAC>"
}
```

This packet:
- Repeats every 5 minutes during active emergency
- Repeats every 15 minutes in standby alert mode
- Repeats every 60 minutes if battery is critical
- Survives via packet sequence numbering even if 90% are lost in transit

Total daily data usage for the device at standard cadence: ~5MB. Easily within LTE-M and Iridium budgets.

### 4.6 What the broadcast cannot do

Honest constraints:
- **Audio streaming over LTE-M is degraded.** Telephony-grade only. 8-16 kbps. Voice intelligibility yes, music or rich ambient no.
- **Video over LTE-M is not feasible.** Video stays on the device until WiFi Direct or higher bandwidth is restored.
- **Satellite is slow.** Iridium messages can take 5-20 minutes to transmit. Useful for periodic check-ins, not for live audio.
- **Find My is passive.** Device cannot initiate transmissions on Find My; it can only be located when an iPhone happens to be nearby.

These constraints affect the user experience. Independent signal is not the same as full streaming. It's the difference between "we know where they are and they're alive" and "we have nothing."

---

## 5. Authority access portal

### 5.1 The strategic principle

**Authorities will use tools that help them do their existing job. They will not adopt systems that require IT integration or procurement processes.** The portal is designed accordingly:

- Free
- Self-serve sign-up
- No agency-side integration required
- Works in any browser
- Useful in the first 60 seconds of an investigation

The pitch to a police chief is: *"Your dispatchers and detectives already get BLACK BOX links forwarded to them. We give you a portal where you can search across all BLACK BOX activity in your jurisdiction in one place. Free. No IT engagement. Sign-up takes 3 minutes."*

### 5.2 Verification model

The portal is at `authority.blackbox.app`. Sign-up requires verified affiliation with a recognized agency.

**Automatic verification** for known domains:
- Government-issued emails (e.g., `*.lg.jp`, `*.gov`, `*.police.uk`, etc.)
- Major NGO emails for embassy/consular access (with manual review)
- Verified law enforcement directory cross-reference

**Manual verification** for everyone else:
- Upload of official credentials (badge with badge number)
- Supervisor verification email
- Phone call confirmation to agency main line
- Typically resolves within 48 hours

Each verified user gets:
- Role tier (investigator / dispatcher / supervisor)
- Audit-tracked access
- Quarterly re-verification

### 5.3 Capabilities

A verified authority user can:

**Search active events:**
- By geography (radius from a location)
- By phone number (returns devices registered to that number, if user has opted to allow this kind of lookup — default off)
- By name (returns matching user profiles, if user has opted in — default off)
- By time window

**View results:**
- Public-tier view by default
- Authority-tier view for events where the user (or their guardian) has authorized access
- Family-authorized access: when a family files a missing person report and grants access via SMS-signed authorization, the investigator can see the full event

**Take actions:**
- Mark as "investigating"
- Add notes (timestamped, signed, audited)
- Download evidence package (with appropriate authorization)
- Request callback to user's emergency contact
- Flag for inter-agency coordination

### 5.4 Family-authorized access workflow

When a family files a missing person report and the missing person has a BLACK BOX:

1. Family contacts BLACK BOX support (or uses self-service portal)
2. They identify the missing person and provide proof of relationship
3. System verifies via existing guardian relationships, or requires additional proof (police report number)
4. Family taps "Authorize investigator [name] from [agency] to access [user]'s data"
5. Authorization is signed via SMS link sent to family member's phone
6. The named investigator's portal now shows full authority-tier access to the missing person's events

Time from family decision to investigator access: under 5 minutes.

### 5.5 Audit and accountability

Every authority access is logged:
- Officer's name, badge, agency
- Timestamp of query / view / download
- What was searched, what was viewed, what was downloaded
- Why (free-text reason field, required)
- IP / device info

Audit logs are:
- Visible to the user (if alive) at any time
- Visible to the user's guardians
- Subject to legal request from the user or their family
- Retained for 7 years minimum

Abuse of authority access is criminally prosecutable in most jurisdictions. The audit trail provides the evidence.

### 5.6 The integration tier (for jurisdictions that want it)

Beyond the self-serve portal, some agencies will want to push deeper:

**Webhook integration:** Agency provides a webhook URL. BLACK BOX backend posts new events matching their jurisdiction. Their existing CAD system parses and creates incident records. ~1 day of agency-side IT.

**Direct CAD plugin:** Pre-built plugins for major CAD vendors (Tyler New World, Hexagon, Motorola, CentralSquare). BLACK BOX events appear natively in their dispatcher console.

**NG911 / PSAP compliance:** For modern emergency systems. BLACK BOX events emit as i3 PIDF-LO compliant location objects. Audio streams via SIP/RTP.

All of these are optional. The base portal works without any of them.

---

## 6. Privacy and abuse mitigation summary

The features in this document are powerful, which means they're abusable. The following are the system-wide guarantees:

| Guarantee | How it's enforced |
|---|---|
| **User can revoke any guardian instantly** | Hardcoded into firmware and PWA. No override exists at any tier. |
| **Every guardian action is logged and shown to user** | Audit trail in PWA, automatic email/LINE digest weekly. |
| **No data leaves the system without explicit authorization** | Cryptographic signing. Authority portal access requires authenticated session + audit logging. |
| **Reverse activation always notifies the user** | Cannot be disabled. Notification fires on every channel. |
| **15-minute response window before reverse activation proceeds** | Hardcoded. Configurable only to longer (never shorter than 15 min). |
| **72-hour cooling-off period before guardian goes live** | Hardcoded. Cannot be skipped even with consent. |
| **Maximum 2 guardians per user** | Limits dilution of trust. |
| **90-day guardian re-confirmation required** | Forces active maintenance of the relationship. |
| **Abuse pattern detection with auto-revocation** | System-level monitoring with notification to user. |
| **Independent audit log of all authority access** | Immutable. Family-accessible. 7-year retention. |

These are not opt-in. They are properties of the system.

---

## 7. Legal framework needed before launch

Before this protocol can launch, the following legal work is needed:

1. **Terms of Service language for guardian designation.** Clear that designation is a legal authorization. Must hold up under reasonable consent doctrines in target jurisdictions (Japan, US, EU, UK to start).
2. **Authority portal Terms of Use.** Verified-credential agreement. Misuse disclosure. Audit-trail acknowledgment.
3. **Data retention policy.** How long audit logs are kept. How long emergency-broadcast metadata persists. How user deletion requests interact with active investigations.
4. **DV/abuse safeguard certification.** Engagement with domestic violence organizations to review the guardian system. NNEDV in the US, NEC in Japan. Their feedback materially shapes the safeguards.
5. **Wiretap law compliance.** One-party consent recording in most jurisdictions. Reverse activation surfaces complex questions — is the user "consenting" via prior guardian designation? Worth a written opinion from a lawyer in each major jurisdiction.
6. **Cross-border data transfer.** GDPR for EU users, APPI for Japan, CCPA for California. User-side encryption helps; BYOK helps; documented DPAs for agency partners required.

Budget for legal review before launch: $15–25K for a thorough multi-jurisdiction review by a tech-privacy specialist firm.

---

## 8. Implementation phases

The protocol is layered. Ship in this order:

| Phase | Capability | Dependencies |
|---|---|---|
| **L1 (with Lite MVP)** | Guardian tier (software-only). Verification flow. Cooling-off. Audit trail. | Lite MVP complete |
| **L2 (with v1 Sentinel)** | Authority portal v0 — self-serve sign-up, basic search, audit log | L1 complete |
| **L3 (with v2 Recorder)** | LTE-M independent signal. Apple Find My piggyback. Emergency broadcast packet. | v2 hardware shipping |
| **L4 (post-v2)** | Reverse activation. Two-guardian rule. Abuse pattern detection. | L1 + L3 complete |
| **L5 (year 2)** | Family-authorized investigator access. Authority CAD integrations. Iridium satellite SKU. | L4 stable |

Each phase requires legal review (§7) before launch.

---

## 9. The honest framing for users

Onboarding copy for the guardian designation step:

> **Guardians are different from emergency contacts.**
>
> An emergency contact gets the alert when you activate BLACK BOX. A guardian can activate BLACK BOX for you when you can't.
>
> This is for the moments you might not be able to ask for help. A mental health crisis, an accident, a disappearance you didn't see coming. Your guardian is the person you would trust with the equivalent of medical decisions if you were unconscious.
>
> Guardians can't see your day-to-day. They can't track you. But if you're unreachable and they believe you need help, they can activate your device to find you.
>
> You will always be notified before this happens. You will have 15 minutes to cancel it. You can revoke a guardian at any time, instantly, with no override.
>
> Choose carefully. Most people should have one or two. Many people should have zero.

The last line is intentional. Not everyone should designate a guardian. The feature exists for people who would benefit; not everyone does.

---

## 10. What this protocol doesn't solve

To be honest about limits:

- It doesn't prevent the underlying mental health crisis, accident, or attack. It shortens the window between crisis and discovery.
- It doesn't work if the user has destroyed or removed the device.
- It doesn't work in true off-grid wilderness (Iridium helps but isn't infallible).
- It doesn't replace welfare systems, mental health care, or community connection.
- It doesn't reduce the grief if the worst has already happened. It only reduces the *uncertainty*.

The protocol's job is reducing uncertainty. Uncertainty is what destroys families in the hours and days after someone disappears. Knowing someone is gone, with evidence, is terrible. *Not knowing* is worse, because it goes on forever.

---

**End of Last Resort Protocol Spec.**
