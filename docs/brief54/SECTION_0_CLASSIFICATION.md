# BRIEF 54 §0 — CLASSIFICATION, WITH ITS SAMPLING BASIS

**Report only. No conversion performed. No product code changed.**

## What was measured, and how

`test-utils/guard-ast.mjs` was built FIRST, as the measuring instrument. Three regex passes had
already produced 802, then 38, then 770-with-wrong-classes — each confidently wrong in a different
direction. Whether an assertion reads source text is structurally decidable, so the AST answers it;
what CLASS an assertion belongs to is not, because `/STOP/` and `/return <Navigate/` are both
regexes over source and only intent separates copy from render behaviour.

**Corpus:** 770 source-text assertions (551 positive, 219 negative) across all 42 files.

**Sample:** the 6 largest files — **256 assertions, 118 `it()` blocks** — hand-classified. That is
**33% of the corpus by assertion count**, drawn from the heaviest files rather than at random, so
it is biased toward large, mature guards. Small guards likely skew more STRUCTURAL (fewer, sharper
assertions), which means the BEHAVIOURAL share below is probably an UPPER bound for the corpus.

**Unit of judgment:** the `it()` block. Intent is expressed there, and assertions inside one block
almost always share a class. 118 judgments, not 256.

## The table

| Class | Blocks | Assertions | Positive | Negative | Share |
|---|---|---|---|---|---|
| **BEHAVIOURAL** | 56 | **124** | 107 | 17 | **48%** |
| STRUCTURAL | 42 | 82 | 42 | 40 | 32% |
| CONFIGURAL | 8 | 27 | 23 | 4 | 11% |
| PROSE-COPY | 12 | 23 | 22 | 1 | 9% |
| UNEXPRESSIBLE | 0 | 0 | — | — | 0% |

Per file:

| File | Composition |
|---|---|
| `report-destinations` (pwa) | S:25 B:24 P:12 |
| `currency-guards` (pwa) | C:26 B:15 S:4 |
| `dashboard-polling` (api) | B:35 P:6 C:1 |
| `evidence-dashboard` (pwa) | B:34 S:7 |
| `console-boundary` (api) | S:28 B:8 |
| `report-leaf` (api) | S:18 B:8 P:5 |

## BEHAVIOURAL is 48%, and that changes what "done" means

Nearly half the sample is not a guard at all. It is a test written as a regex over source.

Representative cases:

- *"exponential backoff 3/6/12/24/48 with a 60s cap"* — a retry-ladder test, asserted by matching
  numbers in a file. The real test drives the ladder and observes the delays.
- *"a missing rear lens DEGRADES, it never fails"* — a fallback test. The real test rejects
  `getUserMedia` for video and asserts audio still records.
- *"an unseekable waveform says so instead of silently absorbing the tap"* — a UI behaviour test.
- *"health fails closed: an unreachable PWA is a mismatch, never unknown"* — an error-path test.

**Converting these to AST checks preserves a weak form of a strong property**, which §0 explicitly
warns against. They should become real tests and the guards deleted.

Consequence for the brief: this is **mostly "write the tests that were never written,"** not a
mechanical toolkit swap. Extrapolated across the corpus, roughly **370 of 770 assertions** are
tests-in-disguise. That is the dominant cost, and it is engineering work rather than conversion
work.

`evidence-dashboard` (B:34 of 41) and `dashboard-polling` (B:35 of 42) are almost entirely this.
Both are candidates to be **deleted wholesale and rewritten as component and timing tests** rather
than converted line by line.

## PROSE-COPY — a real class, and deleting it would lose a compliance check

23 assertions, 12 blocks. It divides in two, and the difference decides the treatment.

**Legally required disclosure — must survive as a test, never deleted:**

- SMS consent copy: `/STOP/`, `/rates may apply/i`, `/Message frequency varies/i`,
  `/Reply STOP to opt out/i` (in `consent-ui`, outside this sample but the origin of the class)
- *"it states its destination and its irreversibility BEFORE she sends"*
- *"the page states plainly that the file stays on the visitor device"*
- *"it publishes the key + algorithm so a court can verify without the page"*

These convert to a test asserting the **rendered output** contains the required disclosures —
render the component, assert on the DOM. Not "a file contains a string."

**Ordinary product copy — safe to delete:**

- *"the closure notice names the DTG, reusing the ONE formatter"* — the reuse is STRUCTURAL and
  worth keeping; the wording is not.
- *"the screen carries the SAME name as the entry that opened it"* — label consistency, better
  expressed as both sites importing one constant.

## STRUCTURAL — 32%, and this is the part that converts cleanly

82 assertions, and **40 of them are negative** — the highest negative ratio of any class. That is
the healthy direction: absence assertions fail loudly. Examples that convert directly with
`callsTo()` / `importsOf()`:

- *"the page imports nothing operational — it cannot reach the running system"*
- *"names no content table anywhere in the console routes"*
- *"mints only through createEnrollmentCode — no second generator"*
- *"no facade surface names any of the three, or imports their screens"*

`console-boundary` (S:28 of 36) is the model file — nearly all genuine structure, and the one to
convert first among the non-life-safety guards.

## CONFIGURAL — 11%, concentrated in one file

26 of 27 are in `currency-guards`, asserting over deploy scripts and build config. These convert to
parsing the script or config and asserting values, which `json()` already half-does.

## UNEXPRESSIBLE — none found in the sample

Not evidence there are none in the corpus. §D cases are likelier in the small facade guards
(byte-identical rendering, "no tell in Hidden") which this sample does not cover.

## What this implies for §C staging

The life-safety order in §C — trigger, dispatch/cascade, closure, capture, encryption, integrity —
maps onto files outside this sample. Two of the six sampled files are life-safety adjacent
(`report-destinations` covers capture acquisition, `dashboard-polling` covers coordinator relay),
and both are BEHAVIOURAL-heavy. That suggests the life-safety conversions are the ones most likely
to be "write the missing test" rather than "convert the assertion."

**Recommendation:** treat §C stage 2 as a test-writing exercise with a guard-deletion outcome, and
budget it accordingly. A mechanical conversion of those files would satisfy the letter of the brief
and leave the properties weaker than they are today.
