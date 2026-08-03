# Org custody — what we tell her, and why it says this

**Brief 53 §C3.** Copy that ships with org custody when the §C4 gates clear. Nothing here is
enabled yet; this is the wording the feature is not allowed to ship without.

---

## The sentence this exists to prevent

> "BLACK BOX cannot read the content of your captures."

True, and dangerously incomplete. A survivor reading it reasonably concludes **nobody** can. Her
shelter can. If she learns that later — from a coordinator quoting her recording back to her, or
from a court filing — the thing she loses is not privacy. It is her belief that the system told
her the truth, and that belief is the only reason she keeps recording during the worst moments of
her life.

A disclosure that is technically accurate and predictably misread is a false disclosure.

---

## What ships instead

**Primary, on the org-custody consent screen:**

> **Your organization can open your recordings.**
>
> When you are enrolled with an organization, your recordings are sealed to two keys: yours, and
> your organization's. A coordinator there can open them to help you.
>
> **BLACK BOX cannot.** We hold the sealed file and never the key.
>
> **Nothing leaves your organization unless you say so.** Sending a recording to anyone else —
> police, a lawyer, a court — takes your authorization, every time. Your organization cannot do
> it for you.

**On the "who opened this" panel:**

> Every time someone at your organization opens one of your recordings, it is recorded here with
> their name and the time. The copy they receive is marked so it can be traced back to them.

**On revocation, stated honestly:**

> When someone leaves your organization, their access to future recordings ends immediately.
>
> **It cannot undo what they already saw.** Nobody's can. What we can do is show you exactly who
> opened what, and mark every copy so a leaked file names the person who opened it.

---

## Three things we do not overclaim

**1. Revocation is partly theatre, and the DPA says so.**
Re-wrapping on offboarding stops future server-mediated access. It cannot un-see what a seat
already saw, and no cryptographic scheme can. Watermarking and the access log are the real
control. Any copy that says "we revoke their access" without that sentence is overclaiming.

**2. Timing and event state are operator-readable by design.**
We can see that an event opened, when it closed, and whether a coordinator engaged. We have to —
closure, auto-close and the orphaned-event failsafe depend on it, and a survivor whose event
cannot auto-close because we could not read its state is worse off. We disclose it and claim no
more than is true. What we cannot read is content: recordings, transcripts, and — once decision B
ships — location.

**3. The organization operating is not the survivor releasing.**
Two powers, never one permission check. The org key lets a coordinator open what the org already
holds. Only she can send it anywhere else. This is structural, not procedural: a release row
cannot exist without her authorization, and the server verifies it against the event's owner
rather than trusting the caller.

---

## Open — not ours to decide

**§C5.1, mass re-wrap at scale.** Offboarding re-wraps every affected capture client-side in one
admin's browser. That is fine at pilot scale and painful at 5,000 seats. The alternative is an
epoch-key hierarchy, which makes rotation cheap and carries a real cost: a departed seat who
cached an epoch key retains access to their tenure's captures. That trades a performance problem
for a security one, and it is a reviewer decision, not ours. **Reported, not picked.**

**§C4, both gates unmet.** Independent crypto review of the envelope design; legal review of
whether re-encrypted evidence survives chain-of-custody scrutiny. The review-answers document in
this repo is our own answers to our own questions, which is precisely the thing a review exists
to check. Nothing ships until both clear.
