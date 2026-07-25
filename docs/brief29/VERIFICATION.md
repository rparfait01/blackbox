# Verifying a BLACK BOX certified report — independent specification

**Status:** normative. This document exists so that a court, an advocate, or an opposing
expert can verify a BLACK BOX certified report **without BLACK BOX**, without an account,
and without the verification page ever having existed.

The verification page at `https://www.blackboxsentinel.com/verification` is a convenience.
This document is the trust. If the two ever disagree, this document is correct.

---

## 0. What the signature does and does not claim

Read this section before relying on a certified report.

**The signature attests that:**

- the evidence section of this document is byte-for-byte what BLACK BOX signed, at the
  stated time, for the stated event;
- the per-chunk **plaintext commitments** shown in the document are the ones BLACK BOX
  recorded **at the moment of capture** — the server re-derives them from its own records
  when it signs, so they cannot be substituted afterwards;
- the recording, when decrypted on the survivor's device, hashed to exactly those
  commitments (`match: yes` per chunk).

**The signature does NOT claim:**

- that any particular thing happened, or that the recording depicts anything in particular.
  BLACK BOX does not interpret, transcribe, or assess the recording. It attests to the
  record's structure and integrity and hands you the record.
- that the **survivor statement** is true, or checked, or machine-verified. That section is
  deliberately outside the signature (see §4).
- that the document was not copied, shared, or shown selectively. Tamper-**evidence** is
  not tamper-**prevention**: anyone holding the file can alter any byte. The point is that
  altering the evidence section is *detectable*.

A report whose evidence cannot be honestly certified is not certified at all: BLACK BOX
refuses to sign when the event has no capture-time commitments to chain to.

---

## 1. The document

A certified report is a single self-contained HTML file with three parts:

| Part | Marker | Signed |
|---|---|---|
| Visible evidence text | `<pre id="blackbox-evidence-text"> … </pre>` | **yes** (as `renderedHash`) |
| Machine-readable payload | `<script type="application/json" id="blackbox-attestation"> … </script>` | **yes** (as `evidenceHash`) |
| Survivor statement | `<div id="blackbox-statement"><pre> … </pre></div>` | **no — deliberately** |

The payload is a JSON object:

```json
{
  "evidence":    { ... the evidence zone ... },
  "attestation": { ... the signed object ... },
  "signature":   "base64 Ed25519 signature",
  "publicKey":   "base64 SPKI public key"
}
```

Inside the `<script>` block, every `<` is escaped as the six characters `\u003c` so the JSON
cannot terminate the element. Un-escape it before parsing. In the visible blocks, `&`, `<`, and `>` are
HTML-escaped as `&amp;`, `&lt;`, `&gt;`; reverse in that order (`&amp;` **last**).

---

## 2. Canonical JSON

Both hashes are taken over a **canonical** serialization. It is a small, deliberately
boring subset of RFC 8785 (JCS), short enough to re-implement in any language:

1. Object keys are sorted ascending by **Unicode code point** of the raw key string.
2. Members whose value is `undefined` are omitted. `null` is kept, and serializes `null`.
3. **Array order is preserved** — order carries meaning (chunk sequence, notification order).
4. No insignificant whitespace anywhere: no spaces after `:` or `,`, no newlines.
5. Strings, numbers, and booleans use standard JSON encoding (RFC 8259).
6. Non-finite numbers (`NaN`, `±Infinity`) are invalid and never appear.

Reference implementation: `packages/shared/src/canonical.ts`.

---

## 3. The verification procedure

Let `doc` be the file's text.

### Step 1 — extract

- `payloadJson` ← text between `<script type="application/json" id="blackbox-attestation">`
  and the next `</script>`, with each literal `\u003c` sequence replaced by `<`.
- `payload` ← `JSON.parse(payloadJson)`.
- `evidenceText` ← text between `<pre id="blackbox-evidence-text">` and the next `</pre>`,
  HTML-unescaped.

If either marker is absent, the file is **not a BLACK BOX certified report**. That is a
different outcome from TAMPERED — report it as such.

### Step 2 — check the key is the published one

`payload.publicKey` **must equal** the published BLACK BOX key, fetched out-of-band from:

```
https://blackbox-api.stillpoint-dev.workers.dev/.well-known/blackbox-integrity-public-key.json
```

> **This step is not optional.** A document carries its own public key, so a forger can
> sign an altered report with a key they control and publish that key alongside it. Such a
> document is perfectly self-consistent and proves nothing. **Always pin the published key.**

### Step 3 — check the evidence data

```
sha256_hex( utf8( canonicalize( payload.evidence ) ) )  ==  payload.attestation.evidenceHash
```

### Step 4 — check the visible text

Normalize `evidenceText` by collapsing every run of whitespace (`\s+`) to a single space
and trimming both ends. Then:

```
sha256_hex( utf8( normalized ) )  ==  payload.attestation.renderedHash
```

Whitespace is normalized so that reflowing, re-saving, or printing the document is not
mistaken for tampering. Any change that survives normalization is a real change to what
the document asserts.

### Step 5 — check the visible text is what the data renders to

Re-render the evidence text from `payload.evidence` using the deterministic rendering in
`packages/shared/src/report-document.ts` (`renderEvidenceText`), normalize it as in step 4,
and confirm it equals the normalized `evidenceText`.

This catches a document that *displays* one thing while *carrying* another. If you are not
re-implementing the renderer, you can rely on steps 3 and 4 together plus reading the
document — but then read the evidence text, not the JSON, since the text is what a reader
sees.

### Step 6 — check the signature

```
Ed25519_verify(
  key       = payload.publicKey            (SPKI, base64)
  message   = utf8( canonicalize( payload.attestation ) )
  signature = payload.signature            (base64)
)
```

`canonicalize` is §2 — note that the signed message is the **canonical attestation**, not
the document bytes and not the JSON as it appears in the file.

With OpenSSL:

```sh
# public key: base64 SPKI → PEM
{ echo "-----BEGIN PUBLIC KEY-----"; fold -w 64 <<< "$PUBLIC_KEY_B64"; \
  echo "-----END PUBLIC KEY-----"; } > blackbox.pem

printf '%s' "$CANONICAL_ATTESTATION" > msg.bin
base64 -d <<< "$SIGNATURE_B64" > sig.bin
openssl pkeyutl -verify -pubin -inkey blackbox.pem -rawin -in msg.bin -sigfile sig.bin
```

### Verdicts

| Condition | Verdict |
|---|---|
| Markers absent / payload unparseable | **Not a BLACK BOX certified report** |
| Steps 2–6 all pass | **BLACK BOX CERTIFIED** — evidence verified, unaltered since generation |
| Any of steps 2–6 fails | **TAMPERED** — evidence altered; not certified by BLACK BOX |
| Ed25519 unavailable in your runtime | **Could not verify** — never report this as certified |

The last row matters. A verifier that cannot distinguish "unaltered" from "I could not
check" is worse than no verifier, because it prints a reassuring answer on faith.

---

## 4. The survivor statement is not signed, and that is deliberate

The statement zone is excluded from every hash above. Two consequences, both intended:

- The survivor may **revise her account at any time** — expand it, correct it, write it
  months later — and the certification of the evidence remains valid. Her evidence is not
  held hostage to the first words she managed to write.
- A court is told plainly that the statement **is her account, not machine-verified**. BLACK
  BOX does not vouch for it, and equally does not grade, score, or challenge it.

**Editing the statement must never be reported as tampering.** A verifier that flags an
edited statement is incorrect.

---

## 5. The attestation object

```jsonc
{
  "format":          "blackbox-certified-report/v1",
  "alg":             "Ed25519",
  "eventId":         "…",
  "evidenceHash":    "sha256 hex — computed on the survivor's device",
  "renderedHash":    "sha256 hex — computed on the survivor's device",
  "commitmentsHash": "sha256 hex — recomputed SERVER-side from its own records",
  "chainHead":       "integrity-chain head at signing, or null",
  "chainSeq":        41,
  "signedAt":        "UTC ISO-8601"
}
```

`commitmentsHash` is the canonical hash of the ordered commitment list
`[{ "plaintextHash": "…", "sequence": 0 }, …]`, sorted by `sequence`. It is derived by the
server from its own rows — **not** from anything the device sent. That is what makes the
certification non-circular: without it, the signature would attest only that the device
said what the device said.

`chainHead` ties the report to the append-only per-event integrity chain BLACK BOX has kept
since capture (Fix Brief 2 #C2), which is independently verifiable through the existing
custody export.

---

## 6. Zero knowledge

The server signs **two SHA-256 hashes and an event id**. It does not receive the evidence
zone, the recording, or the statement, and holds no key that could decrypt the recording.
The survivor's capture is decrypted on her own device with her own key; the document is
assembled there.

This means a BLACK BOX signature is a signature over a fingerprint the signer cannot invert.
It proves the fingerprint was signed; combined with `commitmentsHash` and `chainHead`, it
ties that fingerprint to what BLACK BOX witnessed at capture time.

> **Open crypto-review gate item.** That signing a device-computed hash preserves zero
> knowledge, and the custody arrangements for the signing key, are for the independent
> crypto reviewer to ratify — not for the implementation to self-certify. See
> `docs/brief26/THREAT_MODEL.md`.
