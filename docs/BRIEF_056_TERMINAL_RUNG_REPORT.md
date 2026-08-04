# THE CASCADE'S TERMINAL RUNG — CONSTRAINT REPORT

**Report only. Nothing built. Nothing changed.**
Premise as stated: an attended silent call. The survivor is on the line and present; she cannot
speak because speaking is what endangers her. BLACK BOX supplies what a silent caller cannot —
verified location, live audio, and the record of what preceded it.

**Bottom line up front: this is a business-development problem, not a Capacitor dependency.** The
native wrap buys nothing here. No third-party app on either platform may dial emergency services
without a human touching the screen, and that is a deliberate platform restriction rather than a
missing API. The routes that exist all run through a licensed third party.

---

## 1. WHAT HAPPENS TODAY WHEN NOBODY CLAIMS

### The terminal state is `closed_orphan`, reached by a two-hour timer, and nobody outside her own contact list is ever told.

The chain today is **contact → guardian, and then nothing.** `listCascadeContacts` does append a
final rung for a contact with `role = 'emergency'`, but that is a *human contact the survivor
nominated* — a person, with a phone number. **It is not 110 or 911, and no account has one:**

```
role       n
contact    3
guardian   1
```

With every rung notified and nobody claiming, the event simply stays `active`. The only things
that can end it:

| Path | Trigger | Result |
|---|---|---|
| `runEscalation` | T+60s reprompt; T+180s | Coordinator path declared failed, guardian becomes the qualified confirmer. **Still nobody outside the contact list.** |
| `closeOrphanedEvents` | Dark (no heartbeat) **and** unclaimed for **2 hours** | `closed_orphan`, with the note that closure is not an indication of safety |
| `closeOrphanedEvents` | 24 hours absolute | Same |
| `closeFeedLostEvents` | 90s of feed loss after emergency notified | **DEAD CODE — see below** |

**So: she triggers, four people are messaged, none of them acts, and two hours later a cron closes
the event.** That is the terminal state. No external escalation of any kind exists.

### A dead safety path found while answering this

`closeFeedLostEvents` — the 90-second feed-loss close, the one that exists for "a phone seized,
smashed, or out of battery" — is gated on `emergencyNotifiedAt IS NOT NULL`.

**`emergencyNotifiedAt` is read in exactly one place and written in none.** It is declared in
migration `0015_cascade.sql` and no code path ever sets it. On production, 0 of 16 events have a
value:

```
n=16   notified=0
```

So the fast close for an abruptly-terminated capture — with its abnormal-termination declaration
(Brief 38 §D) and its seal enqueue (Brief 40 §F1) — **has never once executed and cannot.** A
seized phone falls through to the 2-hour orphan timer instead. This is unrelated to the terminal
rung and is a defect in its own right; it is not fixed here because this is a report.

---

## 2. CAN A CALL BE ORIGINATED WITHOUT HER TAPPING ANYTHING?

**No. Not on iOS, not on Android, not as a PWA, and not as a native Capacitor app.** This is the
load-bearing answer and it is negative on every configuration.

| Platform | Verdict |
|---|---|
| **PWA (both)** | No. The web platform has no telephony API. `tel:` requires a user gesture and hands off to the dialer, where the user must still press call. |
| **iOS native / Capacitor** | **No.** iOS exposes no API to place a call programmatically, emergency or otherwise. CallKit originates VoIP calls only and is explicitly barred from emergency services. `openURL("tel://110")` still surfaces the system confirmation. Emergency SOS (side+volume hold) and Crash Detection are Apple's own code, not available to apps. |
| **Android native / Capacitor** | **No, for any normal app.** `Intent.ACTION_CALL` is documented as unusable for emergency numbers; apps may use `ACTION_DIAL`, which pre-fills the dialer and **still requires the user to press call**. The emergency variant is a system intent behind a signature-level privilege, available to platform-signed and carrier apps only. |

**The consequence for the product decision: shipping the native wrap does not unlock this rung.**
If someone tells you "we just need to go native for this", they are wrong, and it is worth
knowing that before the Capacitor work is scoped around it.

**Verification worth doing anyway** (an afternoon, not a research project): build a throwaway
Capacitor app that calls `ACTION_CALL` with `tel:110` on a Japanese Android handset and
`openURL` on an iPhone, and record exactly what the OS does. My confidence here is high but it
rests on platform documentation, not on a device in your hand, and this rung is too important to
build a business case on a secondhand answer.

### The narrower question, which has a better answer

Her *tapping* is not the same as her *speaking*. The product already has a trigger she can reach
under duress — double-tap in Hidden, tap in Visible — and it already works. If the terminal rung
were **"the app surfaces a one-tap call to 110 with the audio already live"**, that is buildable
today with no partner and no licence: a `tel:` link is legal, universal, and requires nothing from
anybody. It is a materially weaker product than what you described, and it is available now.

---

## 3. WHAT CAN ORIGINATE, IF THE DEVICE CANNOT

### (a) Twilio Programmable Voice — real, US-capable, **and unavailable in Japan**

Twilio supports emergency calling in the US, Canada, UK, Australia, Ireland, France, Germany,
Austria, Malaysia, Thailand, Philippines, New Zealand and Italy. **Japan is not on that list.**

For the US it is technically possible: `Dial`, the Calls API or a Client SDK with a valid E.164
`From`, and the emergency number must be in the same country as that number.

Four problems, in descending severity:

1. **Routing is by REGISTERED ADDRESS, not by her GPS.** E911 requires an address validated
   against the MSAG database, and the PSAP is selected from it. That model is built for a fixed
   desk phone. A survivor is mobile, and BLACK BOX's whole contribution is a live position —
   which is precisely the input this path cannot use. Without a registered address Twilio routes
   to a national emergency call centre and passes through a **$75 per-call** fee.
2. **Twilio's own terms restrict it.** Their support documentation states that communications
   between emergency service providers and end users are not permitted on Twilio numbers except
   via E911 on Elastic SIP Trunking. Anything built here needs their Emergency Services Addendum
   and a direct conversation, not a credit card.
3. **The callback.** PSAPs call back. The Twilio number must answer and reach her — and she is
   the person who cannot speak.
4. **Getting her audio onto the call.** A server-originated call is Twilio↔PSAP. Her live audio
   only reaches it if her device joins as a WebRTC leg. That part is genuinely feasible — capture
   already holds the microphone and the stream can be shared — but it does not fix 1–3.

### (b) A monitoring centre with a human who calls — how every comparable product actually does it

An ARC / central station receives the alert, a trained operator assesses it, and **the operator
telephones emergency services and speaks.** This is the model behind alarm monitoring and behind
consumer safety apps (Noonlight is the closest analogue).

It solves everything above: a licensed party originates, a human handles the callback, the
operator relays verified location and can describe the live audio. **It also introduces the thing
this product was built to avoid — a stranger in the loop, latency, and a per-user monthly cost.**

### (c) ASAP-to-PSAP — the licensed data path, but not a voice call

APCO/The Monitoring Association's Automated Secure Alarm Protocol delivers alarm data **directly
into PSAP CAD systems over the Nlets network**, in about five seconds, cutting roughly two minutes
off dispatch. Participation requires being an **NRTL/UL-certified central station**, vetted by The
Monitoring Association.

This is the correct licensed rail for exactly this payload. It is **not** a voice call — so it
does not satisfy your premise on its own — but it is how structured incident data legitimately
reaches a dispatcher in the US, and it pairs naturally with (b).

### (d) RapidSOS — enrichment, not origination

RapidSOS is an additional-data platform: location and device data from Apple, Google, Uber,
wearables and apps, surfaced to the ECC **during a live 911 call**, via the RapidSOS Portal or a
CAD integration. It **does not place calls.** It would make a call placed by (a) or (b) far more
useful, and can do nothing on its own.

### (e) Japan

None of the above is available. There is no Twilio emergency support, no ASAP equivalent, and no
RapidSOS. What Japan *does* have is a state-sanctioned non-voice channel: the **110番アプリ**
(police, for hearing/speech disability) and **Net119** (fire/ambulance) — both **pre-registration
required and disability-scoped**. Worth noting that Japan has already solved "cannot speak" in a
way that is registration-gated, and that a domestic-violence survivor is not the population those
were scoped for.

---

## 4. HOW PSAPs HANDLE SILENT CALLS

### United States — yes, they are worked, and often dispatched

NENA's operational study on silent and hang-up calls is the reference. An **active silent call** —
answered, live, no voice — is treated as a live emergency where the caller may be unable to speak.
Standard practice: **attempt a callback; in many jurisdictions, if the callback fails, dispatch an
officer.** Research exists on identifying the active silent caller (the "four-second rule").

**But it is local policy, not national law.** An unintentional-call determination lets a PSAP
decline to dispatch, and practice varies by centre. So "a silent call gets a unit" is true often
enough to build on and not reliably enough to promise.

Also relevant: **Text-to-911 is live in many US jurisdictions** and is a purpose-built channel for
someone who cannot speak. It is a lower-tech answer to the same problem and it is already
deployed.

### Japan — no equivalent silent-call protocol found

110 is operated prefecturally. My searches surfaced no named silent-call protocol analogous to the
UK's Silent Solution. Public guidance for a caller who cannot speak amounts to *make a noise or
tap the handset*, plus the pre-registered apps above. **Treat "a silent 110 call gets a unit
dispatched" as unverified for Japan** — it needs a direct conversation with a prefectural police
communications section, and that is a phone call somebody should make before anything is designed.

---

## 5. LEGALLY, CAN A NON-CARRIER ORIGINATE?

### United States — not as yourself; only through someone who is

Originating voice traffic to 911 puts you in **interconnected VoIP** territory under 47 CFR Part 9.
Those providers must supply E911 as a mandatory, non-opt-out feature, obtain the customer's
physical location before activation, and transmit a callback number and registered location to the
correct PSAP.

BLACK BOX cannot meet those on its own terms — the registered-static-location requirement is
fundamentally at odds with a mobile survivor. **Riding Twilio moves the obligation to Twilio**,
which is the practical route, subject to their addendum and §3(a)'s four problems.

### Japan — the answer is no, and it is structural

Under the 電気通信事業法, emergency call provision (110 / 118 / 119) is a **universal service tied
to 0AB-J numbering and carrier obligations**, with carriers required since April 2019 to deliver
caller location to the receiving agency. Services outside that numbering — 050 IP telephony and
app-based voice generally — **do not carry 110/119 access.**

**For the Japan pilot, the terminal rung as described is not legally available at any price
without becoming or partnering with a registered carrier.** This is the single hardest constraint
in this report, and it lands on your primary market.

---

## 6. FALSE-DISPATCH LIABILITY

This rung fires **precisely when nobody claimed**, which is the same set as *nothing was wrong and
everyone was busy*. The record already shows how ordinary that is: in one production event the
coordinator opened the dashboard at T+4.65s and never claimed at all.

- **Swatting statutes and false-report offences** exist in every US state; false-alarm ordinances
  impose escalating fines and, after repeat offences, **non-response designations** — the failure
  mode where the address stops getting a unit.
- **Verified response** is the direction the alarm industry moved for exactly this reason: many
  jurisdictions now require verification (multi-call, or audio/video) before dispatch.
- **BLACK BOX is unusually well placed here.** It holds live audio, live location, a classifier
  output and a transcript. Audio verification is the thing that makes verified response
  acceptable — the product's evidence stack is the mitigation, if a human reviews it.
- **An automated dispatch with no human verification is the highest-liability configuration that
  exists**, and it is the one the brief describes. Every route in §3 that is actually licensed —
  ARC, ASAP — puts a trained human between the signal and the dispatcher, and they do that because
  of this section, not in spite of it.

---

## VERDICT

**Business development, not Capacitor.** Ranked by what it costs to find out:

1. **Free, this week.** Confirm §2 on real handsets. Confirm with a prefectural police
   communications section what actually happens on a silent 110. Both answers change the shape of
   everything below and neither costs anything.
2. **Buildable now, no partner.** A one-tap call-110 affordance on the active-alert screen, with
   capture already running. Weaker than the brief. Available immediately, in both countries, with
   no licence.
3. **US only, needs a partner.** ARC/monitoring integration (human relay) or ASAP-to-PSAP
   (NRTL certification). Real, proven, and the route every comparable product took.
4. **Japan.** Blocked at the legal layer. Nothing in the product changes this — it is a carrier
   partnership or nothing, and it should be scoped as a multi-year relationship rather than a
   feature.

The premise is right: a dispatcher who can listen is worth more than a contact who does not
answer. The obstacle is not technical capability but who is permitted to open the line — and that
is a licence, not a build.

---

### Sources

- [Twilio — Emergency Calling for Programmable Voice](https://www.twilio.com/docs/voice/tutorials/emergency-calling-for-programmable-voice)
- [Twilio — What kind of phone calls can't be made using Twilio?](https://support.twilio.com/hc/en-us/articles/223180528-What-kind-of-phone-calls-can-t-be-made-using-Twilio)
- [Twilio — Emergency Services Addendum](https://www.twilio.com/en-us/legal/emergency-services-addendum)
- [APCO International — ASAP to PSAP](https://www.apcointl.org/technology/interoperability/asap-to-psap/)
- [ASAP for Alarm Monitoring Centers](https://asap911.org/asap-for-alarm-monitoring-centers)
- [RapidSOS Developer — Public Safety Partners, Getting Started](https://developer.rapidsos.com/public_safety/default/getting-started)
- [RapidSOS — Partners and API integrations](https://rapidsos.com/partners-api-integrations/)
- [NENA — Silent or Hang-Up 9-1-1 Calls for Service, an Operations-Focused Study](https://cdn.ymaws.com/www.nena.org/resource/resmgr/standards-archived/nena_56-501.1_archived_20200.pdf)
- [AEDR Journal — The "Four-Second Rule" for Identifying the Active Silent 911 Caller](https://www.aedrjournal.org/the-four-second-rule-for-identifying-the-active-silent-911-caller)
- [Intrado — Abandoned 9-1-1 Calls: What is a PSAP to do?](https://www.intrado.com/blog/abandoned-calls-what-is-psap-to-do)
- [FCC — VoIP and 911 Service](https://www.fcc.gov/consumers/guides/voip-and-911-service)
- [eCFR — 47 CFR Part 9, 911 Requirements](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-A/part-9)
- [総務省 — 緊急通報の機能](https://www.soumu.go.jp/menu_seisaku/ictseisaku/net_anzen/hijyo/tuho.html)
- [消防庁 — IP電話等からの緊急通報に係る位置情報通知共通システム](https://www.fdma.go.jp/pressrelease/houdou/items/h18/180511-3/180511-3houkoku_5.pdf)
- [Android Open Source Project — Emergency numbers and emergency calling](https://source.android.com/docs/core/connect/emergency-call)
