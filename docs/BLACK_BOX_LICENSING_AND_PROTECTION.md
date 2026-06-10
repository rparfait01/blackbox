# BLACK BOX — Licensing & Protection

**Version:** 1.0
**Purpose:** How the principle in `BLACK_BOX_PRINCIPLE.md` is protected from erosion — by code license, by patent strategy, by trademark, by operational practice. The mechanisms that keep "single sale, no subscriptions, people first" enforceable even when business pressure pushes the other way.

---

## The problem this document solves

Every safety-product company starts with good intentions. Most end up selling subscriptions, harvesting data, and lobbying against open alternatives. The drift is rarely sudden. It happens one reasonable-sounding decision at a time:

- *"We need recurring revenue to fund the next hardware version."*
- *"Adding analytics will help us improve the product."*
- *"This feature is too expensive to give away free."*
- *"An investor wants a clear path to subscription revenue."*
- *"Our competitors have a Pro tier; we look amateur without one."*

Each of those sentences is a small step toward the model BLACK BOX exists to dismantle. Good intentions are not enough. The architecture, the license, and the legal structure have to make drift *structurally hard* — so that maintaining the principle is the path of least resistance.

This document is the set of mechanisms that do that work.

---

## 1. The four mechanisms

| Mechanism | What it protects | Effort | Cost |
|---|---|---|---|
| **Open-source code (AGPL-3.0)** | Software cannot be enclosed | Low (license headers, public repo) | Free |
| **Defensive patents** | Hardware mechanisms cannot be copied and resold against the principle | Medium (drafting, filing) | $5–25K |
| **Trademark** | Brand cannot be diluted by imitators | Low (filings) | $1–3K |
| **Operational charter** | Founder/team commitments to the principle, in writing | Low | Free |

All four are needed. Any one alone is insufficient.

---

## 2. Open-source code (the primary mechanism)

### 2.1 What gets open-sourced

Everything. The PWA, the Worker code, the bot integrations, the device firmware (when v1/v2 ship), the dashboard, the share architecture, the AI router, the local classifier — all of it. Public GitHub repository under the BLACK BOX organization.

### 2.2 The license: AGPL-3.0

GNU Affero General Public License version 3.0. The key clause that makes this work for a safety system:

> Anyone who runs a modified version of this software as a network service must make their source code available to users.

This means a competitor cannot fork the BLACK BOX code, modify it, host it as `safetyplus.com`, and offer it as a paid SaaS without also releasing their modifications back to the public. They are legally required to share their code with their users.

In practice, this makes the "fork BLACK BOX, put it behind a subscription, profit" path very unattractive. The competitor would have to either:
- Open their code (defeating the subscription moat they were building)
- Avoid using BLACK BOX code at all (rebuild from scratch — slow, expensive)
- Use it anyway and risk legal action (BLACK BOX foundation, see §5, can sue)

### 2.3 Why AGPL specifically (not MIT, not Apache, not BSD)

| License | What it allows | Fits BLACK BOX? |
|---|---|---|
| MIT / BSD / Apache | Anyone can take the code and close it inside a proprietary product | ❌ Defeats the protection |
| GPL-3.0 | Distribution requires source release — but cloud SaaS sidesteps this | ❌ The "SaaS loophole" |
| **AGPL-3.0** | SaaS hosting *also* triggers source release requirement | ✅ Closes the loophole |
| Server Side Public License (SSPL) | More aggressive than AGPL but not OSI-approved | ⚠️ Reduces ecosystem participation |

AGPL-3.0 is the right balance: strong enough to prevent enclosure, recognized enough to be acceptable to contributors and developers.

### 2.4 What this means in practice

- **You** can develop, sell hardware, host the official BLACK BOX service, and accept paid hardware support contracts. AGPL does not prevent commercial activity by the original author.
- **A competitor** cannot take your code, modify it, host it as a service, and avoid releasing their improvements.
- **A community member** can fork it, run their own instance, modify it freely — and if they let others use their instance, they must share their code.
- **A government or NGO** can self-host the entire system for their constituency without paying anyone. They become operators, not customers.
- **A hostile actor** cannot embed the BLACK BOX code into a malicious product without revealing how their malicious product works.

### 2.5 The documentation license

Code is AGPL-3.0. Documentation (these spec files, the marketing copy, the visualizations) is **Creative Commons BY-SA 4.0**. Anyone can use the documentation, including for commercial purposes, as long as they:
- Credit BLACK BOX as the origin
- Share their derivatives under the same license

This means a journalist writing about BLACK BOX, a school teaching personal safety, or a researcher studying the architecture can all freely use the materials. They just can't lock their derivatives behind paywalls.

---

## 3. Defensive patents

### 3.1 Why patents at all (given the open-source commitment)

The open-source license protects the software. The hardware needs different protection. Without patents on the specific hardware mechanisms, a Shenzhen manufacturer can produce identical units, market them under any brand, and either:
- Sell them cheaply (which is fine — that increases protection in the world)
- Sell them cheaply *as part of a subscription service* (which is exactly what the principle exists to prevent)

Patents on the hardware mechanisms let the BLACK BOX foundation legally challenge that second case.

### 3.2 What to patent

The mechanisms that are novel and structurally tied to the principle:

1. **Tamper-as-signal architecture** — the integrated approach where tamper detection on the hardware *is itself* the activation trigger, with last-gasp transmission capability
2. **Last-gasp supercap reserve** — the specific circuit that allows final-packet transmission after main battery loss
3. **BYOK + share-token tier system** — the architecture where AI key control stays with user and dashboard access is delegated via tiered tokens
4. **Guardian + reverse activation protocol** — the multi-party consent system with cooling-off and revocation
5. **Distinctive hardware design** — the physical form factor and ornamental design (separate design patents for cube, puck, pendant)

### 3.3 Patent strategy

**Provisional patent first.** $65 USPTO filing fee. Can be self-drafted using a template. Buys 12 months of "patent pending" status. File this within 30 days, before any further public disclosure.

**Within those 12 months, decide:** Convert to full utility patent applications in target jurisdictions. Cost: $8–15K per filing, prosecuted over 2–4 years. Or let the provisional lapse if the strategic value isn't there.

**Defensive use only.** The BLACK BOX foundation never sues users, hobbyists, researchers, NGOs, or community contributors using the open-source code. The patents exist solely to challenge bad-actor commercial use that violates the principle (specifically: imitators putting BLACK BOX-derived protection behind subscriptions, harvesting user data, or marketing it deceptively).

**License explicitly:** Any commercial entity that wants to manufacture BLACK BOX-compatible hardware can do so freely under a "Defensive Patent License" — they get a free patent license as long as they agree not to assert their own patents against BLACK BOX or other DPL signatories, and as long as their product respects the principle (no subscriptions, no data harvesting). Bad actors get no license.

### 3.4 Design patents

The physical industrial design of the BLACK BOX hardware is itself protectable. Design patents are cheaper ($1–3K each) and granted faster (12–24 months) than utility patents. File design patents on:

- The cube form factor of v1 Sentinel
- The puck form factor of v2 Recorder
- The pendant, keychain, and clip variants
- The distinctive matte-black aesthetic with ceramic window

These protect the look. If imitators want to compete, they have to design their own visual identity. Brand recognition stays clean.

---

## 4. Trademark

### 4.1 What to register

The wordmark **BLACK BOX** in the personal safety device class. Plus:
- The combined wordmark + visual logo (when finalized)
- Sub-brands: **Sentinel**, **Recorder**, when finalized
- Tagline: **"Personal safety, single sale."**

### 4.2 Jurisdictions

- USPTO (United States)
- JPO (Japan — primary launch market)
- EUIPO (European Union)
- IPOS (Singapore — regional headquarters option)
- WIPO Madrid Protocol filing covers many additional markets cheaply

Total trademark budget: $4–8K across these jurisdictions, with an attorney. Cheaper if filed pro se ($300–800 per jurisdiction USPTO fees), but the attorney prevents common rejection errors.

### 4.3 Why trademark matters for the principle

Trademark prevents an imitator from selling a product *as if it were* BLACK BOX. They might be selling a fake or a stripped-down knock-off, but they can't use the name to confuse customers into believing it's the real thing.

This matters because the brand carries the principle. *"Made by BLACK BOX"* should mean "no subscription, never will be, software is free, hardware is one-time, your data is yours." Trademark protection means imitators can't borrow that promise without standing by it.

---

## 5. Operational charter — the foundation entity

### 5.1 The structural problem

A founder can write a principle document. The founder can also revise it. The founder can also be bought out, replaced, or convinced over time. Without structural protection, the principle is only as durable as the current people in charge.

### 5.2 The solution: a foundation, not a company

Once the project reaches sustainability, transition ownership of the core assets (trademark, patents, open-source repository governance) from a private company to a **non-profit foundation** governed by a charter.

The foundation's charter:
- Reproduces the principle document verbatim
- Requires unanimous trustee approval for any change to the principle
- Names initial trustees including representatives from domestic violence organizations, civil liberties organizations, and one academic in safety research
- Prohibits sale or transfer of the trademark to any for-profit entity
- Prohibits litigation use of the patents against users, hobbyists, or community contributors

The for-profit entity (the original company) becomes a *licensee* of the foundation. It can manufacture and sell hardware. It cannot change the principle. If the for-profit entity is sold or shuts down, the foundation retains the trademark and patents, and can grant manufacturing rights to a new operator who agrees to the principle.

### 5.3 Timeline for this transition

Year 1–2: Single private company. Founder controls everything. The principle is enforced by the founder's commitment plus the open-source license.

Year 3+: Once cash flow is stable and the product is established, file the 501(c)(3) (or international equivalent) foundation. Transfer assets. Sign the licensing agreement between the company and the foundation. Make the public announcement.

This transition is the moment the principle becomes structurally durable. Until then, it depends on the founder's word — backed by the open-source code, which is irrevocable.

### 5.4 Why this matters

It's the only mechanism that protects the principle from the founder themselves. People change. Circumstances change. Investors get persuasive. The foundation structure means that even if the original founders eventually want to monetize the project differently, they cannot — the assets are no longer theirs to monetize.

This is uncomfortable to commit to. It is also the only honest way to keep the promise.

---

## 6. The launch sequence

In order, with timing:

### Within 30 days of today
- [ ] File provisional patent (US, $65 self-filed; $5–10K attorney-filed)
- [ ] Acquire domain
- [ ] Reserve Telegram and LINE bot usernames
- [ ] File USPTO trademark application for "BLACK BOX" in safety device class

### Before W1 build starts
- [ ] Confirm AGPL-3.0 license decision in writing
- [ ] Set up public GitHub organization
- [ ] Draft contributor license agreement (CLA) for outside contributors

### W10 (after MVP complete)
- [ ] Publish all code under AGPL-3.0 to public repo
- [ ] Publish documentation under CC-BY-SA 4.0
- [ ] Public launch announcement explaining the licensing and principle
- [ ] Open contributor channels (GitHub Discussions, Discord, or similar)

### Within 12 months of provisional filing
- [ ] Decide on conversion to full utility patents (or let provisional lapse)
- [ ] File design patents on v1 Sentinel cube once design is final
- [ ] Extend trademark filings to Japan, EU, additional jurisdictions

### Year 2–3
- [ ] Establish non-profit foundation
- [ ] Transfer trademark and patent ownership to foundation
- [ ] Foundation charter executed, trustees seated
- [ ] Public announcement of foundation transition

---

## 7. The honest reality check

This strategy has real costs:

- **Open-sourcing the code caps your potential acquisition value.** Major safety-app acquirers (insurance companies, larger consumer-electronics players) typically want proprietary code. They want what they bought to be exclusive to them. AGPL'd code is, by design, never exclusive to anyone. The acquirer pool is smaller and the prices are lower.

- **Patent costs add up.** Filing in five jurisdictions across utility and design patents over 2-4 years totals $40–80K. Real money.

- **Foundation governance is slow.** Decisions that affect the principle require trustee approval. This is intentional — it's what makes the principle durable — but it also means quick pivots become impossible. The structure forces deliberate decision-making.

- **Some good ideas will get rejected by the structure.** The principle is restrictive. Features that could genuinely help users may be incompatible with the rule against subscriptions or telemetry. We will not ship some features that another company would ship.

These are not bugs. They are the cost of the principle. The point of the document is to make those costs visible up front so they are accepted, not discovered later.

---

## 8. What this strategy is NOT

It is not:
- A guarantee against any imitation
- A guarantee against a competitor outspending us in marketing
- A guarantee that the principle survives forever (only that it survives longer than founder commitment alone would)
- A way to maximize founder wealth (it explicitly reduces it)
- A claim of moral superiority over other safety products (other products serve real users; we serve a different set of users with a different model)

It is:
- A best-effort structural defense of the principle
- A signal to potential users that we mean what we say
- A signal to potential contributors that the code they contribute to will not be enclosed
- A reason for press and trust organizations to take the project seriously
- A way to align the legal and operational structure with the stated values

---

## 9. What we do if the strategy fails

If, despite all this, a well-funded competitor copies the product, charges a subscription, and outcompetes us — we did our job. The protection still exists in the world. People still have access to a free option (ours). The competitor has to maintain their service against the perpetual competition of free.

Better outcomes than that one are also possible. But that one is acceptable. The principle is not "we win." The principle is "people are safer."

---

**End of licensing and protection strategy.**
