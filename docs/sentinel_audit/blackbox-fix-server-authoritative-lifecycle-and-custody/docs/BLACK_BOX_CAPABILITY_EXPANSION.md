# BLACK BOX — Capability Expansion Roadmap

**Version:** 1.0
**Purpose:** Adaptive features that extend the system's safety capability beyond passive recording. Some are hardware additions, some are software-only, some are both. Ranked by impact-to-effort ratio.

---

## 0. Framing principle

The core product is **evidence + notification**. Everything in this document is *additive* — features that make the system more useful in specific scenarios without changing the fundamental thesis. Some are deterrents (make the threat reconsider). Some are intelligence aids (give the system better signal). Some are coordination tools (involve more humans faster). All of them must compose cleanly with the base architecture.

**Filter every feature through three questions:**
1. Does this protect the user, or does it just feel like protection?
2. Does it work in the specific 30-second window of a real attack, or only in a planning window?
3. Does it introduce a failure mode worse than not having it?

Features that fail any of these get cut, no matter how clever.

---

## 1. The active deterrent system (your idea, expanded)

The directional high-pitch deterrent is a genuinely strong addition to the v2 Recorder. Let me unpack what works, what doesn't, and what the realistic spec looks like.

### 1.1 What's technically possible

**Painful directional sound** is a real category of self-defense technology:

| Approach | Output | Form factor | Ethics |
|---|---|---|---|
| **Piezo buzzer in v2 puck** | 110–125 dB at 4–5 kHz | Already in form factor | Comparable to a personal alarm — established self-defense tool |
| **Mosquito alarm (15–17 kHz)** | 95–110 dB, targets under-25 hearing | Tiny emitter | Ethically questionable — discriminatory by age |
| **Parametric speaker array** | Highly directional, focusable | Larger device, not pendant-scale | Expensive, complex, but truly aimed |
| **LRAD-class device** | 137+ dB at 1 m | Hand-carried, not wearable | Military/police only |

For a wearable safety device, the realistic spec is **a high-output piezo or magnetic speaker in the 110–125 dB range, broadband 3–5 kHz** (the frequency range human hearing is most sensitive to). Not directional — omnidirectional from a wearable doesn't matter much because the device is on the victim's body, sound radiates outward from there.

### 1.2 The realistic deterrent spec for v2 Recorder

Add to the v2 puck:
- **Piezo speaker, 25mm diameter**, capable of 110–115 dB at 30 cm (typical personal-alarm spec)
- **Frequency:** 4 kHz fundamental, with harmonics for psychological harshness (sirens use modulation for the same reason)
- **Pattern:** Pulsed 0.5s on / 0.2s off — pulsing is more psychologically disruptive than continuous
- **Activation modes:**
  - **Silent** (default): does not emit, just records
  - **Beacon**: emits intermittent locator tone audible at distance (for post-event recovery)
  - **Repel**: full 110+ dB sustained
- **User configurable in PWA:** which mode fires on which trigger
  - Manual button = repel
  - Tamper = repel (the device emits its own death scream)
  - Deadman pin = repel
  - Voice keyword = silent by default

### 1.3 Why pulsing matters psychologically

A continuous loud sound is something people learn to filter. A pulsing alarm — like a fire alarm or smoke detector — triggers a learned response in everyone: *something is wrong, someone help*. The pulse pattern is doing more work than the volume.

### 1.4 Auxiliary deterrents that don't require new hardware

The phone is already capable of significant deterrent action without any added hardware:

**Phone speaker scream mode**
- Modern phones produce 90–100 dB at maximum volume
- Activate during emergency, phone screams a siren pattern at full volume
- Free, instant, no hardware cost
- Drawback: the phone might be in a pocket or bag, muffled
- Mitigation: when activation fires, prompt user via haptic to remove phone for "screen-up" mode

**Phone flashlight strobe**
- Bright flash at 2–3 Hz draws attention from distance
- Visible at night from hundreds of meters
- ImageCapture API for control on Android, limited on iOS
- Doubles as locator beacon for search-and-rescue

**Phone screen flash white**
- Full-white at max brightness, pulsed
- Visible at night from helicopter
- Battery-efficient compared to flashlight

**Recorded sound playback at high volume**
- "POLICE — STAND BACK" voice, pre-recorded, in multiple languages
- "ATTACK IN PROGRESS — SOMEONE CALL 110"
- Multiple-voice playback to simulate crowd approaching
- Sirens, alarms, dog barking
- All zero-hardware-cost, just audio files in the app

**Phantom incoming call**
- Phone rings as if a friend is calling
- "Mom calling…" with answer button
- Lets victim extract from situation: "I have to take this, my mom is sick"
- Triggerable via shake, hidden button in lock screen widget
- Doesn't fire any alert — just an escape tool

### 1.5 The decision matrix for which deterrent fires when

Different threats call for different deterrents. Recommendation:

| Scenario | Deterrent |
|---|---|
| Stalking, following | Phantom incoming call (escape excuse) |
| Aggressive approach, public | Phone scream + flashlight strobe (attract attention) |
| Physical attack in progress | v2 piezo at full repel (pain + attention) |
| Forced into vehicle | Silent record + phone scream (delay the kidnap with confusion) |
| Hostage / forced compliance | Silent record only (deterrent would escalate) |
| Lost / injured in wilderness | Beacon mode (intermittent locator) |

This is configurable per user. Their threat model drives their defaults.

---

## 2. Voice & audio features (software-only)

### 2.1 Voice keyword activation
*"Hey Black Box, help me"* triggers activation. On-device speech recognition — no upload, no cloud. Configurable phrase per user.

- **Tech:** Picovoice Porcupine, or whisper.wasm in always-listening mode (battery-expensive)
- **Privacy:** zero audio leaves device during keyword listening
- **Power cost:** moderate to high — affects 5–10 hour standby
- **Recommendation:** ship in W2 of build, as optional toggle, default off

### 2.2 Duress phrase (already specced, worth elevating)

Speak a configured phrase → screen *appears* to cancel → recording and transmission continue silently → contact gets `[DURESS]` flag.

The duress phrase should be:
- Plausible in conversation: *"I'm okay, false alarm, sorry"* or *"Cancel, this is fine"*
- Different enough from real cancel that no false positives
- Custom-set, not a global word

**The aggressor hearing the victim "cancel" the alarm thinks they've won.** They haven't.

### 2.3 Vocal stress analysis

The AI provider receives transcript text plus inferred vocal stress markers (pitch elevation, speech rate, voice tension, breath patterns). This is generated by Web Audio API analysis in-browser before transcription, never uploaded raw.

A high-stress *"I'm fine"* gets flagged differently than a relaxed *"I'm fine"*. The substrate decides; the AI describes.

### 2.4 Multilingual classification

The local classifier ships with keyword libraries in at least: English, Japanese, Mandarin, Spanish, Korean. AI classification works in any language the user's chosen provider supports.

For Japan-launch specifically, Japanese threat vocabulary needs careful curation — *"yamete"* (stop), *"tasukete"* (help), *"hanase"* (let go), *"naguru"* (hit), weapons (*"naifu"*, *"juu"*).

### 2.5 Background sound identification

Beyond speech, the system identifies ambient audio:
- Vehicle interior vs outdoors
- Specific vehicle type (engine sounds — motorcycle vs car vs truck)
- Water (drowning risk)
- Traffic (urban setting)
- Indoor reverb characteristics (small room vs large space)
- Gunshot signatures
- Glass breaking
- Sirens (already-responding services)

These get fused into the dispatch summary. *"Subject is in vehicle interior, mid-size car, highway speed, with one other voice."*

### 2.6 Direction-of-arrival on v2 only

The 4-mic array does beamforming. The aggressor voice gets directional tagging. The dashboard's compass element (already specced) shows where the threat is relative to the victim. For authorities responding, this becomes "approach from the [opposite] direction."

---

## 3. Schedule, behavior, and trust features

### 3.1 Companion mode

*"I'm walking home, watch me until I arrive."*

User sets a destination and ETA. System tracks their walk. If they deviate significantly from expected route, or stop moving for too long, or don't arrive within ETA, automatic activation cascade fires.

- **Implementation:** server-side route monitoring against the user's stated destination
- **Configurable thresholds:** time delay tolerance, deviation distance
- **Cancel:** when user arrives at destination, app auto-cancels companion mode

### 3.2 Scheduled monitoring

User's calendar integration. *"I'm meeting someone I don't know at this address."* The calendar event title or location triggers auto-arm with elevated sensitivity during the event window.

- Risky meetings (dates, business with strangers, real estate showings) auto-armed
- Auto-disarm after event window
- Can be configured per calendar source (work calendar always armed; personal calendar opt-in)

### 3.3 Periodic check-in

Default off, opt-in per situation. User sets a check-in interval (e.g., 30 minutes). Phone pings them. If they don't acknowledge within a grace window, activation fires.

Useful for:
- Solo travel through unfamiliar areas
- Outdoor activities (hiking, diving, climbing)
- Late-night work shifts
- Elderly users with fall risk

### 3.4 Trusted location auto-disarm

User's home and work auto-disarm partial sensors (deadman triggers stay armed, voice keyword stays armed, but shake threshold raised). Standard for similar safety apps.

Configurable radii. Geofenced via GPS or trusted WiFi networks.

### 3.5 Behavioral baseline

Over time, the system learns the user's normal patterns: typical commute, common locations, sleep window, usual walking speed. Anomalies trigger lower-threshold attention.

*"User is in an unusual location at an unusual time, with elevated movement speed."*

Not enough to trigger activation by itself, but contributes to the substrate's threat classification when other signals appear.

### 3.6 Voice biometric authentication

Voice samples during onboarding train a user-specific voiceprint. If someone other than the registered user attempts to use the device, triggers fire differently. Particularly useful for:

- Phone stolen, attacker tries to use it
- Forced cancel — if the cancel phrase is spoken by aggressor (e.g. matched recording), system ignores
- Identifying which voice is the user vs others in the audio (diarization confidence boost)

### 3.7 Tampering by software detection

If a someone attempts to:
- Force-quit the app during activation
- Toggle airplane mode
- Disable location services
- Uninstall the app

Each is a *signal*. Either the user (cancel intent) or the aggressor (suppress intent). The substrate decides based on context — combined with active recording and unfinished activation, software tampering escalates rather than resolves.

---

## 4. Social & network features

### 4.1 Crowd response network (opt-in)

Verified BLACK BOX users near an active emergency can opt-in to receive a discreet *"Someone needs help 200m from you, can you respond?"* notification.

- **Opt-in only.** Heavy emphasis on this. No surprises.
- **Verified users only.** Some identity-verification tier above a free account.
- **Read-only.** They see public-view data, never authority-tier.
- **Privacy designed.** No directional indicator pointing at the user; just "nearby."

This creates a peer-response network. In urban Japan, where bystander culture is real, this could meaningfully reduce response time before police arrive.

### 4.2 Trusted person system

User pre-designates *trusted people* — partner, family, close friends. The system recognizes their voices (via voiceprint) and their nearby Bluetooth signatures.

If the user is with a trusted person, threat sensitivity adjusts: a loud voice plus aggressive language is less alarming if it's the user's known partner (probably an argument, not a threat) than an unknown voice.

This is a substrate feature, not a UI feature. The classification confidence adjusts based on company.

### 4.3 Multi-user witness coordination

If two BLACK BOX users happen to be near each other when one activates, the other's device can be cross-referenced as a potential witness. Their audio is queryable (with their consent) for additional evidence.

*"User A activated at 18:32. User B was within 50m from 18:30–18:45. With user B's permission, additional audio context available."*

Long-term feature. Requires careful consent UX.

### 4.4 Family group dashboards

For families: parents, partners, dependents — a shared dashboard where each user can see the others' last-known status, current activation state if any, recent practice tests.

Doesn't violate the user's privacy because they opt-in to be visible to the group, and they control granularity.

Useful for international travel (*"Where is Yumi right now?"*), college students (*"Is my daughter back from her late shift?"*), and adult-children-of-elderly-parents.

### 4.5 Public registry of activations (heavily moderated)

A public map of *resolved* (not active) BLACK BOX activations in the user's region, with anonymized event details. Builds awareness of risk geography.

Each registry entry shows:
- Approximate area (500m radius)
- Anonymized event type
- Resolution status
- Time of day pattern

Could become input to city planning, women's safety reporting, journalism. Could also be sensationalized — needs editorial process.

---

## 5. Hardware sensor additions (v2+ roadmap)

### 5.1 Heart rate sensor

Sudden HR spike combined with vocal stress is a strong panic indicator. Cheap photoplethysmography (PPG) sensor adds <$2 BOM.

If user's HR jumps from 75 → 145 in 10 seconds with no exercise context, system auto-arms (doesn't activate, but increases sensitivity).

Continuous baseline learning makes this user-personalized.

### 5.2 Skin temperature

A rapid drop in skin temperature is a marker of shock or blood loss. ±$0.50 BOM addition.

Important for medical events. Combined with HR and accelerometer, distinguishes between *"user is sleeping"* and *"user is unconscious."*

### 5.3 Galvanic skin response (sweat / fear)

Stress sweating measured via skin conductance. ±$1 BOM.

Adds to the stress profile, particularly useful when the user can't make sound (gagged, hostage, hiding).

### 5.4 Body orientation / fall

Already specced in IMU. Worth elevating: if user is suddenly horizontal and stays horizontal in a non-bed location, system queries for response. No response = activation.

### 5.5 Restraint detection

Specific motion patterns indicate restraint:
- Wrists tied: hands move in synchronized arc patterns
- Bound legs: gait drastically different
- Carried: motion is rhythmic but the user isn't pedaling

IMU + ML model. Research-grade, not commercial yet, but a Phase 2 direction.

### 5.6 Camera face identification

If aggressor steps into camera frame on v2, snapshot is captured, face is hashed. Comparison against any known-aggressor database the user opted into (e.g., a restraining-order subject they've added).

Match → escalates threat level dramatically.

### 5.7 License plate OCR

If a vehicle is in frame (any view), license plate gets OCR'd and logged. Critical evidence for forced-vehicle scenarios.

Implementation: edge ML model (MobileNet-class) running on v2 SoC during recording. Plate gets timestamped and saved alongside transcript.

### 5.8 GPS anti-spoofing

Higher-end GNSS chips detect spoofing (when an attacker tries to fake the device's location). If detected, system flags the location as untrusted and falls back to:
- Cell tower triangulation
- WiFi positioning
- IMU dead-reckoning from last trusted position

### 5.9 Direct satellite emergency (Garmin inReach-class)

For wilderness / international travel: when no cellular, no WiFi, no LTE-M coverage, satellite messaging via Iridium or Globalstar.

Hardware addition: ~$30 BOM for a satellite modem chip. ~$15/yr per-device subscription unless integrated with a service provider deal.

Not for MVP. Year-2+ premium tier.

---

## 6. Recovery and post-event features

### 6.1 Auto-generated evidence package

After event resolution, system compiles:
- Full audio (with timestamps)
- Full video (with timestamps)
- Location trail
- Transcript with diarization
- AI classification log
- Audit chain (who viewed, when, what shares)
- Cryptographic signatures throughout

Output: signed ZIP + PDF report. Court-admissible chain of custody. Stored by user (their cloud), shareable with their lawyer / police investigator.

### 6.2 Insurance integration

For users opting in: incident report automatically formatted for their insurance carrier (travel insurance, personal liability, etc.). Sent to a designated email with one tap.

Saves the user hours of paperwork at exactly the moment when paperwork is hardest.

### 6.3 Therapy and mental health resources

Post-event UI in the PWA offers:
- Mental health resources (local, language-specific)
- Trauma-informed advice
- Connection to victim support organizations

Specifically not pop-ups during recovery. Just available in the post-event review screen, calmly.

### 6.4 Legal aid connection

Optional integration with victim's-rights legal aid organizations. The user can elect to share the evidence package directly with their selected legal aid contact.

Particularly important for DV survivors and sexual assault survivors who often don't know how to start the legal process.

### 6.5 Insurance partnerships

Could insurance carriers offer a premium discount to users carrying BLACK BOX? Plausible:
- Travel insurance: lower rates with BLACK BOX
- Home/personal liability: same
- Some employers' executive protection insurance: definitely

Year-2 partnership track. Real revenue potential.

---

## 7. Information & intelligence features

### 7.1 Known-danger overlay

Optional integration with public crime data (where available). User entering an area with recent reported incidents gets a discreet notification:

*"You're entering an area with 3 nighttime safety incidents in the last 30 days. Sensitivity raised."*

Not alarmist. Just informational. Could partner with:
- Crime mapping services (CrimeReports, SpotCrime)
- City open-data portals
- Women's safety organizations' incident reporting

### 7.2 Predicted threat path

Based on the user's current movement vector, system projects 30 seconds ahead:
- *"Subject is approaching a junction. Likely paths: A, B, C."*
- For responders, helps them deploy ahead of the moving event.

### 7.3 Nearest-help index

Always-on, ambient info: distance to nearest police, hospital, fire station, embassy, BLACK BOX peer responder, lit-and-occupied public space.

Available in the user's dormant view (small text), and prominent in active dashboard.

### 7.4 Walk-with-me aware

If multiple BLACK BOX users are walking the same route, system can auto-pair them as walk-buddies (with consent). They don't know each other personally, but their devices know they're traveling parallel paths.

If one activates, the other (closer than the contact network) might be the first responder.

### 7.5 Stranger-meeting verification

A user about to meet someone they don't know (dating app meetup, business meeting, real estate showing) can:
- Share their meetup details with a trusted contact in advance
- Initiate an automatic check-in cadence
- Optionally share the other party's info (name, photo, phone) with the trusted contact
- Auto-arm during the meeting window

The system becomes a structured *meetup safety protocol* without the user needing to think about each step.

---

## 8. Priority recommendations

Given limited engineering bandwidth, here's the ranked recommendation:

### Ship in MVP (W1-W9 of base build)
- Duress phrase (already specced)
- Voice keyword activation (W2 or W3 addition)
- Phone scream / flashlight strobe deterrents (W2 phase add)
- Trusted location auto-disarm (W4 or W5)
- Companion mode (W7 or W8)
- Periodic check-in (W7 or W8)

### Ship in v1 (post-MVP, Q4 2026 – Q1 2027)
- Phantom incoming call
- Voice biometric authentication
- Behavioral baseline
- Scheduled monitoring
- Auto-generated evidence package
- Multilingual keyword libraries (full Japanese, Mandarin, Korean, Spanish)
- Crowd response network (alpha)
- Background sound identification

### Ship in v2 (Q2-Q3 2027)
- v2 piezo deterrent (the hardware addition you suggested)
- 4-mic direction-of-arrival
- License plate OCR (v2 only)
- Camera face identification
- Family group dashboards
- Heart rate sensor option

### Year-2+ research and partnerships
- Restraint detection ML
- GPS anti-spoofing
- Satellite emergency (premium tier)
- Insurance partnerships
- Therapy/legal aid integrations
- Public registry (with editorial review)

---

## 9. The most underrated feature

If forced to pick one feature on this list that would do the most good per dollar of engineering, it's not the hardware deterrent — it's **companion mode**.

Most personal safety incidents don't happen at random. They happen during transitions: walking home, leaving a date, going to a meeting with a stranger, taking the late-night train. Companion mode addresses exactly this — the predictable risky transition — by adding structured surveillance with auto-escalation. No new hardware. Mostly server logic. High user value. Low development cost.

The piezo deterrent is exciting and worth building. But companion mode is the feature that prevents the activation from being needed in the first place.

---

## 10. The one feature to never build

**Active counter-strike capability.** Anything that physically harms an attacker beyond noise/light. Anything that calls for a third party to harm an attacker. Anything that takes autonomous action against a human being.

BLACK BOX exists in the information layer. It records, classifies, shares, deters. It does not strike. The legal, ethical, and reputational risks of crossing that line are enormous, and the actual value gain is small — police and trained responders are far better at intervention than any consumer device.

The product's defensibility comes from being information-first. Maintain that line at all costs.

---

**End of capability expansion roadmap.**
