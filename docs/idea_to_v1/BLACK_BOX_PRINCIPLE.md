# BLACK BOX — The Principle

**Version:** 1.0
**Status:** The foundation. Every other document follows from this one.

---

## What this is

A short, plain-language statement of what BLACK BOX is, what it isn't, and what we will and won't do. Two pages. Print it. Tape it to a wall. Every engineering decision, every business decision, every word of marketing gets checked against this document.

---

## What we're building

A personal safety system for people who cannot afford to be safe.

Not the only people who will use it. But the people we built it for.

When someone is in danger, the modern personal safety market asks them to subscribe. Eight dollars a month. Ten. Twenty-five. For some people that's a rounding error. For many it's the difference between safety and going without.

The people most likely to need a safety device are the people least likely to be paying for one. Single mothers, students, people leaving abusive relationships, the elderly, tourists, journalists in hostile places. The ones for whom *"I'll skip the subscription"* is a quiet, ordinary decision — and the ones for whom the missing protection has the worst outcomes.

That's the gap. That's the work.

---

## The five things this product is

1. **Single sale.** Pay once. Own forever. No tiers that gate safety features behind monthly fees. The hardware funds the software. The software is free.

2. **Humanized thought.** Every design decision begins by picturing a scared person at 2 a.m. and asking what would help them. Not what would convert them. Not what would retain them. What would *help* them.

3. **Human benefit.** Success is measured in outcomes for people, not in metrics that proxy for outcomes. We do not report monthly active users. We report lives helped.

4. **Not profit-driven per se.** Revenue is necessary. It pays the people doing the work, funds the hardware, keeps the lights on. It is not the goal. The goal is the protection. Revenue serves the protection.

5. **People first.** When operational convenience and user wellbeing trade off, user wellbeing wins. Every time. Documented as a rule, not a vibe.

---

## The five things this product is not

1. **Not a subscription.** Not now, not later, not when we need to "monetize," not when investors push for ARR.

2. **Not surveillance.** We do not sell, share, monetize, or analyze user data. The user owns their data. Their AI provider gets only what the user authorizes. Their cloud storage is theirs. Their keys never leave their device.

3. **Not exploitative of fear.** No urgency-driven upsells. No fear-based marketing. No advertising during a crisis. No "upgrade now to unlock the feature that would have saved you." Whatever exists in the product is available to everyone who needs it.

4. **Not engagement-optimized.** We do not want users opening the app every day. We want it to work the night they need it and stay invisible otherwise. The dormant view is not a notification surface. The history is not a feed.

5. **Not closed.** The software is open-source. The protocols are documented. The architecture is published. Anyone can audit how it works. Anyone can fork it. Anyone can self-host. The hardware is patented — but defensively, to prevent others from enclosing what is meant to be free.

---

## Design rules these principles produce

Engineering decisions reference these directly:

- **No feature ever moves behind a recurring fee.** If a feature requires ongoing cost, find a way to absorb it into the one-time price or don't ship it.
- **No advertising. Anywhere. Ever.**
- **No telemetry beyond the minimum required to keep the service running.** No analytics dashboards.
- **No retention loops.** No "you haven't opened the app in 30 days" reminders. No streaks.
- **No upsells during use of the safety features.**
- **No data shared with any third party the user did not explicitly authorize, per transaction.**
- **No degradation of the free tier to drive purchases.** The free tier is the protection. It is not the bait.
- **No requirement of paid AI to use the system.** Local floor (keyword + tone classifier) is always available, no key needed.
- **No reliance on a single cloud provider for survival.** Architecture must degrade gracefully to peer-to-peer + local storage if any cloud disappears.

---

## What hardware revenue is for

To pay the cost of the people doing the work, the materials needed to build the devices, the legal reviews, the safety audits, the certifications, the support staff who answer the late-night questions.

Not to enrich the founders.
Not to satisfy investors who expect compounding returns.
Not to fund acquisition of competitors.

A successful BLACK BOX year is one where the team is paid fairly, the next round of hardware ships, the certifications are renewed, the abuse-prevention review with domestic violence organizations happens on schedule, and the bank account at the end of the year is roughly where it started.

Growth, when it happens, is in the number of people protected — not the size of the operation.

---

## What we owe the user

When someone buys a BLACK BOX, they are trusting us with the most important thing they have: themselves, and the people they love. That trust obligates us specifically:

1. To build the product to actually work the night they need it.
2. To tell them honestly what it can and cannot do.
3. To never use their fear as a marketing channel.
4. To never share their data without their per-transaction authorization.
5. To make the system survive us — if the company fails, the protection does not.
6. To listen when they tell us something is wrong, and to fix it.
7. To respect their decision when they want to leave — full data export, full account deletion, no hostage tactics.

---

## What we owe the people we did not build it for

Some people will use BLACK BOX who do not need it. Comfortable. Privileged. Not at meaningful risk. They will buy it because they like the design, or because they are anxious, or because a relative bought one for them.

That's fine. Their purchase funds the protection of the people who do need it. We do not gatekeep. We do not means-test. We do not require sob stories.

But we do not market to them as the primary audience either. The marketing speaks honestly about who this is for, and they can join if they want.

---

## What we owe ourselves

To stop building when the product is good enough. Not to chase feature creep. Not to convince ourselves of new "tiers" and "Pro" plans. Not to discover that we suddenly need recurring revenue.

If the product reaches the state where it does its job well, and the team is sustainable, and the users are safer — that is enough. We do not need to grow forever.

---

## What this looks like when it works

A nineteen-year-old international student in Tokyo, walking home from a part-time job at 1 a.m., wearing a BLACK BOX pendant her aunt mailed her. She has not opened the app this week. She does not need to. The device is on. Her family has the access she set up six months ago. The audit log shows nothing.

She arrives home safely, as she has every night.

If she does not, the system does its job, and her family knows where she is within five minutes, and the local police see a dispatch summary on a portal they signed up for in three minutes, and someone is moving toward her while she is still being moved.

That is the entire product.

The rest is engineering.

---

## The test

If at any point a decision is being considered — a feature, a pricing change, a partnership, a marketing campaign, an investor demand — and it cannot be reconciled with this document, the document wins. Not the decision.

If the document has to be revised to allow the decision, that's a warning. The principle should be more stable than any individual decision. Revisions to the principle are rare, deliberate, and only ever in the direction of *more* user benefit, never less.

---

**This is what we are building.**
**This is why.**
**This is the rule.**
