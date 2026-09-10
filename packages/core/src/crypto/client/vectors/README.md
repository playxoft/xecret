# E2EE cross-implementation test vectors

These files are the enforcement mechanism for
[`docs/security/e2ee-crypto-spec.md`](../../../../../../docs/security/e2ee-crypto-spec.md).
A specification nobody can test is a document; a specification with vectors is a contract.

Two independent implementations consume them:

- **TypeScript** — `packages/core/src/crypto/client/**`, running in the browser and in Workers.
- **Go** — `cli/internal/e2ee/**`, running on developer machines and CI runners.

The same JSON files are read by both suites. A blob written by the CLI must open in the
browser and vice versa, and the way that stops being an aspiration is that both are checked
against the same bytes.

---

## No value in here was written by hand

**Nothing in this directory fabricates a vector value.** No expected ciphertext, no derived
key, no signature, and no digest in these files was written by hand or produced by anything
other than a real implementation.

The order of work is:

1. **Phase 0** — the schema and this README. The *shape* of a vector file was fixed first, so
   that Phase 1 had something to generate into and Phase 4 has something to read.
2. **Phase 1 (done)** — the TypeScript implementation landed, and `build.ts` produces
   `e2ee-vectors.json` from it. The values are whatever that implementation actually computes,
   and the TypeScript suite checks every one of them back.
3. **Phase 4** — the Go implementation reads the same file and must reproduce every value
   independently. Any disagreement is a bug in one of them or an ambiguity in the spec, and
   all three get fixed before either ships.

A hand-written expected value would encode a guess about the spec into a file that then
*validates* the guess. Generating from an implementation and cross-checking with a second,
independently written one is what actually tests the specification — the vectors are a
consistency check between two readings of the same document, not an oracle handed down from
above.

If a vector and the spec disagree, the spec wins and the vector is regenerated.

---

## Files

| File | Contents |
|---|---|
| `e2ee-vectors.schema.json` | JSON Schema (2020-12) describing a vector file. Normative for the file's shape. |
| `e2ee-vectors.json` | The vectors themselves. Generated from the TypeScript implementation. |
| `build.ts` | Builds the vector object from `crypto/client/`. Pure — it writes nothing, so it stays browser-safe and inside the test suite's coverage. The pinned randomness lives here. |

The generator that puts `build.ts`'s output on disk is
[`packages/core/scripts/generate-vectors.ts`](../../../../scripts/generate-vectors.ts): a shell
that stamps `generatedAt` and the git sha and calls `writeFileSync`. Everything with
cryptography in it is in `build.ts`.

The schema is validated in CI against the vector file, so a generator that drifts from the
documented shape fails a test rather than quietly producing something the Go side cannot read.

It is JSON Schema draft 2020-12, and it compiles under Ajv in strict mode with
`strictRequired: false` — that one relaxation is needed because the schema uses `if`/`then` to
require `lookupHashHex` on recovery wraps and `credentialIdB64Url` on PRF wraps, a pattern
Ajv's `strictRequired` lint flags but the specification permits. The schema does more than
describe shape: it pins the Argon2 parameter bounds from spec §3.1, the full set of HKDF info
strings from §3.3, the Crockford alphabet from §7.1 (`U` is rejected, not aliased), and the
`xk2.` prefix of every blob, so a generator that drifts from the spec fails validation rather
than producing a file the Go side would faithfully reproduce the wrong way.

---

## File shape

```jsonc
{
  "$schema": "./e2ee-vectors.schema.json",
  "specVersion": "2.0",              // the spec revision these were generated against
  "blobVersion": "xk2",
  "generatedAt": "2026-…",           // ISO 8601 UTC
  "generator": "packages/core/scripts/generate-vectors.ts@<git sha>",
  "vectors": [ /* … */ ]
}
```

Every entry carries an `id`, a `kind`, a human-readable `description`, an `input` object and
an `expected` object:

```jsonc
{
  "id": "sealed-box/member-grant-edk",
  "kind": "sealed-box",
  "description": "EDK sealed to a member's X25519 public key, version 1 grant.",
  "input":    { /* everything needed to recompute the result, including the randomness */ },
  "expected": { /* what a conforming implementation must produce */ }
}
```

`id` is unique across the file and stable across regenerations. A test failure names the id, so
renaming one to something more descriptive costs the ability to compare against an earlier run.

---

## Encoding conventions

| Field suffix | Encoding |
|---|---|
| `…Hex` | Lowercase hexadecimal, no `0x`, no separators. Even length. |
| `…Blob` | A full `xk2.<algo>.<b64url>` string exactly as it would be stored. |
| `…B64Url` | Unpadded base64url (RFC 4648 §5), matching `crypto/encoding.ts`. |
| everything else | Plain JSON strings, numbers, and booleans. |

Hex rather than base64url for raw bytes, deliberately: a vector file is read by humans
debugging a cross-implementation mismatch, and hex is the encoding in which "the fourth byte
differs" is visible at a glance. Blobs stay in their native base64url form because the vector's
whole point is that the *stored string* matches byte for byte.

Strings destined for a KDF or an AEAD (passphrases, secret values, notes) appear as ordinary
JSON strings. The generator writes them already NFC-normalised, and at least one vector per
such kind MUST carry a string where NFC normalisation actually changes the bytes — a decomposed
`é`, for instance — because that is the case an implementation silently gets wrong.

---

## Randomness is an input, not an outcome

Every construction in the spec generates fresh randomness: AES-GCM IVs, Argon2 salts,
ephemeral X25519 keypairs, recovery-code entropy. A vector cannot be reproduced unless that
randomness is pinned.

So each vector's `input` carries **the exact random values the generator used** — `ivHex`,
`ephemeralPrivateKeyHex`, `saltHex`, and so on — and the implementation under test is expected
to expose an internal entry point that accepts them rather than generating its own.

This matters, and it is the one place a test suite can quietly defeat itself: **that
randomness-injecting entry point must never be reachable from production code.** In
TypeScript it is a non-exported function the test file imports directly; in Go it is an
unexported function tested from within its own package. The exported `seal` takes no IV, for
the reason `crypto/aead.ts` gives at length. A vector suite that forced an IV parameter into
the public API would have traded the property it exists to protect for the ability to check it.

---

## Vector kinds

Nine kinds, covering every construction in the spec. All are required to be present; a file
with no vectors of some kind fails schema validation.

| `kind` | Covers | Spec section |
|---|---|---|
| `argon2id` | Passphrase → SK, at two different parameter sets (see the carve-out below) | §3.1 |
| `hkdf` | Every info string in the derivation table, one vector each | §3.3 |
| `uk-wrap` | UK wrap and unwrap for all three kinds: `passphrase`, `recovery`, `prf` | §2.2 types 1–3 |
| `sealed-box` | Seal and open, to a member, a service token, and an invitation public key | §5 |
| `grant-signature` | Canonical signing payload bytes and the Ed25519 signature over them | §6 |
| `secret-value` | Value and note encryption under the EDK, with AAD | §2.2 types 9–10, §4 |
| `value-hmac` | EHK → HMAC key → `valueHmac` | §9 |
| `recovery-code` | Code generation, display grouping, check character, `codeBytes`, lookup hash, RCK | §7 |
| `blob-parse` | **Negative** cases: unknown version, unknown algo tag, truncated payload, bad base64url, AAD mismatch | §2 |

`grant-signature` vectors carry the canonical `signingPayloadHex` as well as the signature.
This is not redundant. Ed25519 is deterministic, so a signature mismatch tells you only that
*something* upstream differs; the payload bytes tell you which field the two implementations
disagreed about, which is where every cross-implementation bug in a canonicalisation scheme
actually lives.

`blob-parse` vectors assert that a parser **rejects**, and are the reason
`expected.rejected` exists. ADR 0009's definition of done requires that every parser refuses
every version it does not know; that requirement is only tested if a negative case is a
first-class vector rather than an ad-hoc unit test on one side.

---

## Coverage each kind must reach

The schema enforces shape. These are the cases the *generator* is responsible for producing,
and they belong here rather than in a code comment because the Go implementer reads this file:

- **Boundaries** — an empty-string secret value, a value at exactly `MAX_SECRET_VALUE_BYTES`,
  a recovery code whose 125-bit value is small enough to need left-padding to 25 characters.
- **Non-ASCII** — at least one passphrase, one secret value, and one note containing
  characters outside ASCII, including one whose NFC form differs from its input form.
- **Both grant recipients that are not a member** — service token and invitation, since
  `recipientKind` is part of both the AAD and the signing payload and is the field most likely
  to be hard-coded to `member` by accident.
- **A rotation pair** — an `edk-grant` at version 1 and at version 2 for the same environment
  and recipient, whose AADs and signatures must differ.
- **A check-character failure** — a `recovery-code` vector that is a single-character
  substitution away from a valid code, so the Luhn mod-32 implementation is tested for
  rejection and not only for agreement.

---

## The one carve-out: Argon2 parameters

`argon2id` vectors run **below** the OWASP floor the specification requires of production
records — `m = 8 MiB, t = 1` and `m = 16 MiB, t = 2`, where production is `m = 64 MiB, t = 3`.

That is deliberate, and it is the only place a vector's input is not a value the product would
write. Pure-JS Argon2id costs around a second per derivation at the production parameters (ADR
0009's measurement section), and a test suite that spends several seconds proving a library
computes a specified function is a suite people learn to skip — which costs more than the
coverage it buys. The parameters are an input to Argon2id, not part of its definition: the
same function, the same encoding, and the same NFC normalisation are exercised either way.

The floor itself is not thereby untested. It is a *client-side policy control* on
server-supplied parameters, it lives in `parseKdfParams`, and it has its own unit tests that
reject `m` below the floor, `t` out of range, `p ≠ 1`, `alg ≠ argon2id`, and unknown fields.
The vector generator reaches the Argon2id provider directly, beneath that policy, precisely so
that the two concerns stay separable.

The schema carves this out as `testArgon2Params`, whose memory range is **disjoint** from the
production `argon2Params` — strictly below 19456 KiB — so a production parameter set can never
validate as a test one by accident, and the carve-out is visible in the file that would
otherwise be the thing enforcing the floor. An implementation must never accept these bounds
from a server.

---

## Regenerating

Once the generator exists (Phase 1):

```bash
npm run -w @xecret/core vectors:generate
```

Regeneration rewrites every value, so a diff that touches vectors unrelated to the change
being made means the change was not as local as it looked. **Read that diff.** An unexplained
change in a vector file is the earliest and cheapest signal that a format changed by accident,
and it is far cheaper to read here than to diagnose as an undecryptable blob in production.

Changing a value that is already published under `xk2` is a breaking format change. It needs a
new blob version and a new spec section, not a regenerated file.
