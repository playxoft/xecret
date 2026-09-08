# xecret E2EE Crypto Format Specification

**Version:** 2.0 · **Date:** 2026-09-08 · **Status:** normative
**Implements:** [ADR 0009](../adr/0009-zero-knowledge-encryption.md)

This document defines every cryptographic artifact xecret stores or transmits under the
zero-knowledge model, at the byte level. It is written to be sufficient for an independent
implementation — the Go CLI is one such implementation and is developed against this text,
not against the TypeScript source — and for a third-party audit.

**Conformance language.** MUST, MUST NOT, SHOULD, and MAY are used in the RFC 2119 sense.
Where this document and any implementation disagree, this document is wrong or the
implementation is; resolve it here first and then in code, never the other way round.

**Scope.** Everything under the `xk2.` blob version and the `xecret.aad.v2.` AAD version.
The v1 server-side envelope (`crypto/keys.ts`, `crypto/secrets.ts`, `xecret.aad.v1.`) is
unchanged by this document and is retired at the end of the migration, not by this spec.

---

## 1. Conventions

### 1.1 Primitives

| Name | Definition |
|---|---|
| `AES-256-GCM` | AES in Galois/Counter Mode, 256-bit key, **12-byte IV**, **128-bit tag**. The tag is appended to the ciphertext, as Web Crypto does. This is `crypto/aead.ts` unchanged. |
| `HKDF-SHA256` | HKDF (RFC 5869) with SHA-256. Always written `HKDF(ikm, salt, info, L)`. |
| `HMAC-SHA256` | RFC 2104 with SHA-256. |
| `SHA-256` | FIPS 180-4. |
| `X25519` | RFC 7748 Diffie-Hellman. Public and private keys are 32 bytes. |
| `Ed25519` | RFC 8032 PureEdDSA (no pre-hash). Public keys 32 bytes, private seeds 32 bytes, signatures 64 bytes. |
| `Argon2id` | RFC 9106, version 0x13 (19). |

**IV generation.** Every AES-256-GCM IV in this specification is 12 fresh bytes from a
cryptographically secure random source, generated at the moment of encryption. **No exported
function MAY accept an IV as a parameter**, and no implementation may derive one from a
counter or reuse one. IV reuse under one key breaks GCM completely — it leaks the XOR of the
two plaintexts and enables forgery — which is why `crypto/aead.ts` generates it internally and
offers no way to supply one.

The single exception is the test-vector suite, which must pin randomness to be reproducible.
It reaches an *unexported* entry point from inside the module's own package; that entry point
must never be re-exported. See the vectors README for why this distinction is the whole of the
protection.

**Randomness.** All random values MUST come from a CSPRNG: `crypto.getRandomValues` in the
browser and Workers, `crypto/rand.Read` in Go.

**Zeroization.** Implementations SHOULD overwrite buffers holding key material once they are
no longer needed. As `crypto/encoding.ts` already documents, this narrows the window in which
a heap snapshot yields a usable key; it does not close it, and it is not a control to rely on.

### 1.2 Notation

- `a ‖ b` — byte concatenation.
- `u32be(n)` — `n` as a 4-byte unsigned big-endian integer.
- `utf8(s)` — the UTF-8 bytes of string `s`, with no BOM and no terminator.
- `b64url(x)` — base64url per RFC 4648 §5, **without padding**. This is `toBase64Url` in
  `crypto/encoding.ts`. Decoders MUST reject any input containing a character outside
  `[A-Za-z0-9_-]`, and MUST reject padding characters.
- `random(n)` — `n` CSPRNG bytes.
- UUIDs are always written in **canonical lowercase 36-character text form**
  (`8-4-4-12` hexadecimal with hyphens), never as 16 raw bytes. This is deliberate: the text
  form has no byte-order question, which removes an entire class of TypeScript/Go
  disagreement, and it matches what `crypto/aad.ts` already does.

### 1.3 Encoding of text inputs

Any human-supplied string entering a KDF — the master passphrase above all — MUST be
**Unicode NFC-normalised and then encoded as UTF-8** before use.

This is not decoration. A passphrase containing `é` is two code points on macOS (NFD) and one
on Windows (NFC); without normalisation, the same passphrase typed on two machines derives two
different keys and the second machine reports "wrong passphrase" forever. TypeScript:
`s.normalize('NFC')`. Go: `golang.org/x/text/unicode/norm.NFC.String(s)`.

---

## 2. Blob format

Every stored cryptographic artifact is a single ASCII string:

```
xk2.<algo>.<b64url payload>
```

Three dot-separated fields. Neither the version nor the algorithm tag can contain a dot, and
the base64url alphabet excludes it, so the encoding is unambiguous without escaping or length
prefixes — the same reasoning as the `xecret-share-v1.` format in `crypto/escrow.ts`.

**Parsers MUST reject anything they do not recognise, loudly.** An unknown version prefix, an
unknown algorithm tag, a payload shorter than the minimum for its type, or a payload that is
not valid unpadded base64url is a hard error, never a fallback and never a guess. A blob
written by a future version must fail to parse rather than be misread as this one.

### 2.1 Algorithm tag registry

The tag names the *construction*, not the purpose. Purpose is carried by the AAD (§4) and by
the column the blob lives in; a blob moved to the wrong column fails to decrypt because its
AAD no longer matches.

| Tag | Construction | Payload layout | Min bytes |
|---|---|---|---|
| `gcm` | AES-256-GCM under a key the reader already holds | `iv(12) ‖ ciphertext‖tag` | 28 |
| `x25519` | Sealed box to an X25519 public key (§5) | `ephemeralPub(32) ‖ iv(12) ‖ ciphertext‖tag` | 60 |
| `ed25519` | Detached Ed25519 signature (§6) | `signature(64)` | 64 |

No other tag is defined at `xk2`. Adding one is a spec change.

### 2.2 Blob types

Every artifact xecret stores, with its prefix, its key, and its AAD. `AAD` values are defined
in §4; `HKDF` info strings in §3.

| # | Artifact | Storage | Prefix | Encryption key | AAD |
|---|---|---|---|---|---|
| 1 | Passphrase UK wrap | `user_key_wraps.wrap` (kind `passphrase`) | `xk2.gcm.` | `HKDF(SK, "", "xecret.v2.uk-wrap", 32)` | `uk-wrap` / passphrase |
| 2 | Recovery UK wrap (×5) | `user_key_wraps.wrap` (kind `recovery`) | `xk2.gcm.` | `RCK` = `HKDF(codeBytes, "", "xecret.v2.recovery-wrap", 32)` | `uk-wrap` / recovery |
| 3 | Passkey PRF UK wrap | `user_key_wraps.wrap` (kind `prf`) | `xk2.gcm.` | `PK` = `HKDF(prfOutput, "", "xecret.v2.prf-wrap", 32)` | `uk-wrap` / prf |
| 4 | Encrypted X25519 private key | `user_keys.encPrivateKeyEnc` | `xk2.gcm.` | `UK` | `privkey-enc` |
| 5 | Encrypted Ed25519 private key | `user_keys.signPrivateKeyEnc` | `xk2.gcm.` | `UK` | `privkey-sign` |
| 6 | EDK sealed to a principal | `env_key_grants.edkSealed` | `xk2.x25519.` | sealed box to the principal's X25519 public key | `edk-grant` |
| 7 | EHK sealed to a principal | `env_key_grants.ehkSealed` | `xk2.x25519.` | sealed box to the principal's X25519 public key | `ehk-grant` |
| 8 | Grant signature | `env_key_grants.signature` | `xk2.ed25519.` | Ed25519 by the creator's signing key | n/a (§6) |
| 9 | Secret value ciphertext | `secret_versions.ciphertext` | `xk2.gcm.` | `EDK` | `secret-value` |
| 10 | Secret note ciphertext | `secrets.encNote` | `xk2.gcm.` | `EDK` | `secret-note` |
| 11 | CLI hand-off UK wrap | **nowhere** — loopback URL only (§13.2) | `xk2.x25519.` | sealed box to the CLI's ephemeral X25519 public key | `cli-handoff` |

Types 6 and 7 are the same construction to the same public key with different AAD and
different plaintext. They are stored in separate columns rather than as one sealed pair
because the EHK is re-sealed unchanged across an EDK rotation while the EDK is replaced.

**Plaintexts.** Types 1–3 encrypt the 32-byte UK. Types 4–5 encrypt the 32-byte private key
(the X25519 scalar, and the Ed25519 32-byte seed respectively — not the 64-byte expanded
form). Type 6 encrypts the 32-byte EDK, type 7 the 32-byte EHK. Types 9–10 encrypt the
NFC-normalised UTF-8 bytes of the value or note. Type 11 encrypts the 32-byte UK, like types
1–3, but asymmetrically and to a key that exists for one login and is then discarded.

**Size limit.** `MAX_SECRET_VALUE_BYTES` (64 KiB, `crypto/secrets.ts`) applies to the
*plaintext* on the client and to the *ciphertext* on the server, which can no longer see the
plaintext. The server therefore enforces a slightly larger ciphertext bound; a client MUST
still refuse an oversized plaintext before encrypting it.

That larger bound is derived, not chosen, so the two limits cannot drift apart. The longest
conforming blob is the prefix plus the base64url of an IV, the maximum plaintext, and the tag:

```
MAX_SECRET_BLOB_LENGTH = len("xk2.gcm.") + ceil((12 + MAX_SECRET_VALUE_BYTES + 16) / 3) * 4
                       = 8 + 87_420 = 87_428 characters
```

Exported as `MAX_SECRET_BLOB_LENGTH` from `crypto/client`. A server validating a request body
compares against this; a client refuses the oversized plaintext long before it gets there.

---

## 3. Key derivation

### 3.1 Argon2id — passphrase to Stretched Key

```
SK = Argon2id(
        password = utf8(NFC(passphrase)),
        salt     = kdfSalt,          // 16 bytes, random per user, stored plaintext
        m        = kdfParams.m,      // KiB
        t        = kdfParams.t,
        p        = kdfParams.p,
        version  = 0x13,
        dkLen    = 32,
        secret   = <empty>,          // no pepper
        ad       = <empty>)
```

`SK` is 32 bytes and never leaves the client. It is not itself a key: it is HKDF input
keying material for exactly two branches (§3.3), and it MUST NOT be used to encrypt anything
directly.

**Current parameters.** `m = 65536` (64 MiB), `t = 3`, `p = 1`, `dkLen = 32`, 16-byte salt.

**Stored form.** `user_keys.kdfSalt` holds the 16 raw salt bytes. `user_keys.kdfParams` holds
a JSON object with exactly these keys and no others:

```json
{ "alg": "argon2id", "v": 19, "m": 65536, "t": 3, "p": 1, "len": 32 }
```

| Field | Type | Meaning |
|---|---|---|
| `alg` | string | MUST be `"argon2id"`. Argon2i and Argon2d are not accepted. |
| `v` | integer | Argon2 version. MUST be `19` (0x13). |
| `m` | integer | Memory cost in **KiB**, matching the RFC 9106 reference convention. |
| `t` | integer | Time cost (passes). |
| `p` | integer | Parallelism (lanes). |
| `len` | integer | Output length in bytes. |

**Parameter validation is mandatory and is a client-side security control.** These parameters
arrive from the server, and a client that runs a KDF with unvalidated server-supplied cost
parameters can be made to allocate arbitrary memory by a hostile or compromised server. Before
invoking Argon2id, a client MUST reject anything outside:

| Field | Accepted range |
|---|---|
| `alg` | exactly `"argon2id"` |
| `v` | exactly `19` |
| `m` | `19456` … `1048576` (19 MiB … 1 GiB) |
| `t` | `1` … `10` |
| `p` | exactly `1` |
| `len` | exactly `32` |

The lower bound on `m` is the OWASP 2025 floor; a record below it is either corrupt or
hostile, and in both cases refusing is correct.

**Upgrade path.** A stored `kdfParams` that differs from the current defaults in **any**
field marks the record as needing an upgrade. On the next successful unlock the client
re-derives `SK` at the current parameters with a fresh salt and re-wraps the UK. `!==`, not
`<`, deliberately — the same reasoning the retired `pinNeedsRehash` had: an upgrade must
also be able to *lower* a cost, if a parameter was ever set to a value some platform cannot
reach.

### 3.2 HKDF calling convention

All derivations use HKDF-SHA256 with an **empty salt** unless stated otherwise, because every
input keying material in this specification is already a uniformly-random 32-byte value or a
KDF output — none is a password or otherwise low-entropy. The one exception is the sealed box
(§5), which puts the two public keys in the salt.

Output length `L` is 32 bytes throughout.

### 3.3 The complete info-string table

This table is exhaustive. **An implementation MUST NOT introduce an info string that does not
appear here**, and every string is written exactly as shown, ASCII, no trailing whitespace.

| Info string | IKM | Salt | L | Produces |
|---|---|---|---|---|
| `xecret.v2.uk-wrap` | `SK` (32B, §3.1) | empty | 32 | AES-256-GCM key wrapping the UK in the **passphrase** wrap (blob type 1) |
| `xecret.v2.unlock-verifier` | `SK` (32B, §3.1) | empty | 32 | `unlockVerifier`, sent to the server at setup and at every unlock (§8) |
| `xecret.v2.uk-unlock-verifier` | `UK` (32B) | empty | 32 | `ukUnlockVerifier`, sent to the server by an unlock that opened the UK without a passphrase (§8.2) |
| `xecret.v2.recovery-wrap` | `codeBytes` (16B, §7) | empty | 32 | `RCK`, the AES-256-GCM key wrapping the UK in one **recovery** wrap (blob type 2) |
| `xecret.v2.prf-wrap` | WebAuthn PRF output (32B) | empty | 32 | `PK`, the AES-256-GCM key wrapping the UK in the **passkey** wrap (blob type 3) |
| `xecret.v2.value-hmac` | `EHK` (32B) | empty | 32 | HMAC-SHA256 key for `valueHmac` (§9) |
| `xecret.v2.invite-key` | invite fragment seed (16B, §10) | empty | 32 | The invite keypair's X25519 private scalar |
| *(the blob's full AAD string)* | X25519 shared secret (32B) | `ephemeralPub ‖ recipientPub` (64B) | 32 | AES-256-GCM key for one sealed box (§5) |

Two branches from `SK` — the wrap key and the verifier — is the reason `SK` is HKDF input
rather than a key. The verifier is handed to the server; if it were the wrap key, or derived
from it by anything invertible, a server holding verifiers would hold wrap keys. It is a
sibling branch, and HKDF's guarantee is that one branch reveals nothing about another.

The UK has two uses: it is an AES-256-GCM key for blob types 4 and 5, with distinct AAD for
each, and it is the IKM for exactly one HKDF branch — `xecret.v2.uk-unlock-verifier`. That
branch exists because **an unlock does not always involve a passphrase.** A passkey unlock
opens blob type 3, and blob type 3 holds the UK; there is no derivation from the UK back to
`SK`, by construction, because that one-way relationship is what makes a passphrase change a
single re-wrap. So a client that has genuinely opened the vault with a passkey holds no value
the `xecret.v2.unlock-verifier` branch could produce, and without a second branch it could
decrypt everything and still not be able to tell the server it had unlocked.

**Deriving an unlock proof from the UK gives away nothing**, and this is the point worth being
precise about rather than taking on trust. The server's own gate is not what protects a secret
under this model — the wraps are. Anyone who can produce `HKDF(UK, "", "xecret.v2.uk-unlock-verifier", 32)`
already holds the UK, and therefore already holds every private key and every environment key
the account can reach. The proof is strictly weaker than the capability it attests to, so a
server storing its digest learns nothing it could use, and a client presenting it claims
nothing it cannot already do.

The branch is kept **separate from the `SK` one** rather than reusing
`xecret.v2.unlock-verifier` with different IKM, for the reason the registry exists at all: two
derivations that produce interchangeable 32-byte blobs are two things a server cannot tell
apart. Distinct info strings mean the two verifiers hash to distinct stored columns
(`unlock_verifier_hash` and `uk_unlock_verifier_hash`), so a value captured from one path can
never be replayed down the other, and an implementation that confuses them fails closed at the
comparison rather than silently accepting the wrong proof.

The UK is otherwise never HKDF input. Any further use would need a new registered branch and a
change to this table.

---

## 4. Additional Authenticated Data

### 4.1 Format

```
xecret.aad.v2.<purpose>|<component>|<component>|…
```

The AAD is the **UTF-8 bytes of that string**, with no terminator. It is passed as
`additionalData` to AES-256-GCM, which authenticates it without encrypting it, so a ciphertext
moved to a different row fails to decrypt rather than silently succeeding. This is the v1
mechanism from `crypto/aad.ts`, with v2 purposes and the same rationale — see that file's
header for the concrete attack it defeats.

**The delimiter invariant is load-bearing.** Every interpolated component MUST match
`^[0-9a-zA-Z_-]+$`. `|` cannot appear inside a component, so the encoding is unambiguous and
needs no length prefixes. An implementation MUST assert this on every component before
constructing the AAD, and MUST throw without including the offending value in the message —
these paths handle secret identifiers and error messages reach logs. UUIDs satisfy it
(`[0-9a-f-]`), as do lowercase-hex hashes, base64url strings, and the fixed enum words below.

**Enumerated component values**, all lowercase ASCII:

- `recipientKind` ∈ { `member`, `token`, `invite` } — corresponding to
  `env_key_grants.memberUserId`, `.serviceTokenId`, `.invitationId`.
- `wrapKind` ∈ { `passphrase`, `recovery`, `prf` } — `user_key_wraps.kind`.

Integers (`version`, `edkVersion`) are rendered as base-10 ASCII with no sign, no padding, and
no separators, and MUST be non-negative.

### 4.2 The complete purpose table

| Purpose | AAD string | Used by blob type |
|---|---|---|
| `secret-value` | `xecret.aad.v2.secret-value\|<orgId>\|<environmentId>\|<secretId>\|<version>` | 9 |
| `secret-note` | `xecret.aad.v2.secret-note\|<orgId>\|<environmentId>\|<secretId>` | 10 |
| `edk-grant` | `xecret.aad.v2.edk-grant\|<environmentId>\|<edkVersion>\|<recipientKind>\|<recipientId>` | 6 |
| `ehk-grant` | `xecret.aad.v2.ehk-grant\|<environmentId>\|<recipientKind>\|<recipientId>` | 7 |
| `uk-wrap` (passphrase) | `xecret.aad.v2.uk-wrap\|<userId>\|passphrase` | 1 |
| `uk-wrap` (recovery) | `xecret.aad.v2.uk-wrap\|<userId>\|recovery\|<lookupHashHex>` | 2 |
| `uk-wrap` (prf) | `xecret.aad.v2.uk-wrap\|<userId>\|prf\|<credentialIdB64Url>` | 3 |
| `privkey-enc` | `xecret.aad.v2.privkey-enc\|<userId>` | 4 |
| `privkey-sign` | `xecret.aad.v2.privkey-sign\|<userId>` | 5 |
| `cli-handoff` | `xecret.aad.v2.cli-handoff\|<codeChallengeB64Url>\|<handoffPublicKeyB64Url>` | 11 |

Notes on the less obvious choices:

- **`secret-note` carries no version.** Notes live on the `secrets` row, not on the
  append-only `secret_versions` row. Binding a version that does not exist would be a
  fabricated component that the two implementations would eventually disagree about.
- **`ehk-grant` carries no version.** The EHK is not versioned; it is created once per
  environment and never rotated by default (ADR 0009, trade-off 4). If an org ever elects to
  rotate it, that is a delete-and-recreate ceremony, not a version bump.
- **`edk-grant` carries `edkVersion`.** Rotation produces a new `env_data_keys` row with an
  incremented version, and a grant for version 3 must not open as a grant for version 4.
- **Recovery wraps are bound to their own code** via `lookupHashHex` (lowercase hex, §7). All
  five recovery wraps hold the same UK, so without this a row swap would go undetected; with
  it, a swapped row fails loudly. `credentialIdB64Url` plays the same role for passkey wraps.
- **The `orgId` in `secret-value` and `secret-note`** is redundant given `environmentId`, and
  is included anyway to match `xecret.aad.v1.secret` exactly. The v1 AAD binds the org, and
  dropping it in v2 would make the migration's before/after comparison harder to reason about
  for no gain.

---

## 5. Sealed box

The construction used to seal the EDK and the EHK to a member, a service token, or an
invitation. It is anonymous — the recipient learns nothing about who sealed it from the box
itself, which is what the grant signature (§6) is for.

### 5.1 Seal

```
seal(recipientPub, plaintext, aad):
    require len(recipientPub) == 32

    (ephPriv, ephPub) = X25519.generateKeyPair()
    shared            = X25519(ephPriv, recipientPub)          // 32 bytes
    require shared is not all-zero                             // §5.3

    key = HKDF(ikm  = shared,
               salt = ephPub ‖ recipientPub,                   // 64 bytes
               info = aad,                                     // the §4 AAD, UTF-8
               L    = 32)

    iv = random(12)
    ct = AES-256-GCM.encrypt(key, iv, plaintext, aad)          // tag appended

    zeroize(ephPriv); zeroize(shared); zeroize(key)
    return "xk2.x25519." + b64url(ephPub ‖ iv ‖ ct)
```

### 5.2 Open

```
open(recipientPriv, blob, aad):
    (version, tag, payload) = parse(blob)
    require version == "xk2" and tag == "x25519"
    require len(payload) >= 60

    ephPub = payload[0:32]
    iv     = payload[32:44]
    ct     = payload[44:]

    recipientPub = X25519.publicKeyOf(recipientPriv)
    shared       = X25519(recipientPriv, ephPub)
    require shared is not all-zero

    key = HKDF(shared, ephPub ‖ recipientPub, aad, 32)
    return AES-256-GCM.decrypt(key, iv, ct, aad)               // uniform failure
```

Every failure that **depends on key material** — wrong recipient, wrong AAD, flipped bit,
forged tag, an ephemeral key yielding an all-zero shared secret — MUST surface as one
indistinguishable error carrying no detail, exactly as `DecryptionError` does in
`crypto/types.ts`. Distinguishing them tells an attacker probing the API which part of their
guess was wrong.

Failures of **format** are the one exception, and they are a separate class: a string that is
not a well-formed `xk2.x25519` blob — unknown version, unknown algorithm tag, payload below
the minimum, invalid base64url — is rejected by the parser of §2 before any key is touched,
loudly and with a distinct error type. Nothing is learned from that rejection: it is a fact
about a string the attacker already holds, derivable by reading §2. Collapsing it into the
uniform decryption error would trade a real diagnostic — the one that tells an operator a
column holds the wrong kind of value — for no security at all, and would sit badly with §2's
requirement that a parser reject what it does not recognise *loudly*. The vector schema records
the distinction as `expected.errorClass`, `format` or `decryption`.

### 5.3 Rationale, and two requirements that are easy to skip

**The public keys go in the HKDF salt.** A plain `HKDF(shared, "", info, 32)` would derive the
same key for any pair producing the same shared secret, and would leave the transmitted
`ephPub` outside the KDF's view. Binding `ephPub ‖ recipientPub` into the salt makes the
derived key specific to the exact ephemeral/recipient pair — the same property libsodium's
`crypto_box_seal` gets by hashing both keys into its nonce, and the same one HPKE gets through
its KEM context. The order is fixed as **ephemeral first, recipient second**; reversing it
produces a different, non-interoperable key.

**The AAD is used twice, deliberately** — as the HKDF `info` and as the GCM `additionalData`.
The first binds the *key* to the context, so a relocated blob derives the wrong key. The
second binds the *ciphertext*, so a relocated blob also fails authentication. Either alone
would be sufficient; both cost nothing and mean an implementation that drops one still fails
closed.

**All-zero shared secrets MUST be rejected.** X25519 returns all zeros for low-order input
points, and continuing past that would derive a key an attacker chose. Go's `crypto/ecdh`
returns an error for this case; `@noble/curves` throws. An implementation MUST NOT catch and
ignore it.

**Ephemeral keys are single-use.** A fresh keypair per `seal` call, never cached, never reused
across recipients or across the EDK and EHK of the same grant. Two boxes sealed under one
ephemeral key to one recipient would derive one AES key, and the IVs alone would then be
carrying the whole separation.

---

## 6. Grant signatures

Every `env_key_grants` row is signed by its creator at creation. Verification is deferred
(ADR 0009, trade-off 3); **creation is not** — a row written by the new code path without a
signature is a defect.

### 6.1 Canonical signing payload

Ed25519 signs a message, so the message must be a canonical byte string that two
implementations cannot disagree about. Every field is length-prefixed, including the
fixed-width ones:

```
lp(x) := u32be(len(x)) ‖ x
```

```
signingPayload :=
      lp(utf8("xecret.v2.grant-sig"))     // 19 bytes, domain separation tag
    ‖ lp(utf8(environmentId))             // 36 bytes, canonical lowercase UUID text
    ‖ lp(u32be(edkVersion))               // 4 bytes
    ‖ lp(utf8(recipientKind))             // "member" | "token" | "invite"
    ‖ lp(utf8(recipientId))               // 36 bytes, canonical lowercase UUID text
    ‖ lp(recipientPublicKey)              // 32 raw bytes, the X25519 u-coordinate
    ‖ lp(utf8(edkSealedBlob))             // the full "xk2.x25519.…" ASCII string
    ‖ lp(utf8(ehkSealedBlob))             // the full "xk2.x25519.…" ASCII string

signature := Ed25519.sign(signerPrivateSeed, signingPayload)     // 64 bytes
stored    := "xk2.ed25519." + b64url(signature)
```

Verification recomputes `signingPayload` from the row's own columns and checks the signature
against `user_keys.signPublicKey` for `env_key_grants.signedByUserId`.

### 6.2 Why it is shaped this way

**Uniform `u32be` length prefixes, even on fixed-width fields.** The alternative — prefixing
only the variable-length fields — requires every implementation to agree on which fields are
fixed, and that agreement is exactly the sort of thing that holds until someone changes a UUID
representation. Four redundant bytes per field removes the question. The payload is
unambiguously parseable, which also means it is unambiguously *constructible*, which is the
property that matters.

**UUIDs as canonical text, not 16 raw bytes.** Go's `uuid.UUID` is `[16]byte` and TypeScript's
is a string; converting one to the other introduces a byte-order convention that RFC 9562
specifies but that implementations get wrong often enough to be a known class of bug. The
36-character text form has no such convention. It also matches `crypto/aad.ts`, so there is
one representation of a UUID in xecret's cryptographic inputs rather than two.

**Signing the full blob strings, prefix included.** Not the decoded payload bytes. This covers
the `xk2.x25519.` version prefix, so a downgrade to a future weaker algorithm cannot reuse a
signature; and it means a verifier does not have to re-encode anything, which is one fewer
place for the two implementations to differ.

**Both sealed blobs, not one.** ADR 0009's source design named "the sealed blob" singular, but
the row carries two — `edkSealed` and `ehkSealed`. Signing only the EDK would leave the EHK
unauthenticated in a row that claims to be authenticated, which is worse than not signing at
all.

**`recipientKind` and `recipientId`, beyond the recipient's public key.** The public key alone
does not pin *which principal row* the grant belongs to. Including the kind and the id means a
server cannot relabel a service-token grant as a member grant, or move a valid grant between
two principals that share a public key, without invalidating the signature. This is a
deliberate strengthening of the field list.

**A domain-separation tag.** The same Ed25519 key will eventually sign other things. Without a
tag naming this structure, a signature produced for one purpose could be presented as a
signature for another whose canonical encoding happened to collide.

---

## 7. Recovery codes

Five codes are generated at vault setup. Each independently wraps the UK, each is single-use,
and using any one invalidates the whole set (a fresh set of five is issued immediately).

### 7.1 Alphabet

**Crockford base32**, 32 symbols, excluding `I`, `L`, `O`, and `U`:

```
0123456789ABCDEFGHJKMNPQRSTVWXYZ
```

Symbol value is the zero-based index into that string.

**Decoding is forgiving in exactly the ways Crockford specifies, and no others.** A parser
MUST, in this order: strip all hyphens and Unicode whitespace; upper-case; then map `I` → `1`,
`L` → `1`, `O` → `0`. Any remaining character outside the alphabet — including `U`, which is
excluded precisely because it is confusable and is never valid in any position — is a parse
error.

`U` is rejected rather than aliased. Crockford reserves it as part of the mod-37 check-symbol
set, which this specification does not use (§7.4), so it has no meaning here at all.

### 7.2 Generation and layout

```
generateRecoveryCode():
    b    = random(16)
    b[0] = b[0] & 0x1F                      // clear the top 3 bits → 125 significant bits
    n    = big-endian integer of b          // 0 ≤ n < 2^125
    data = Crockford-base32(n) as exactly 25 characters, left-padded with '0'
    check= luhnMod32(data)                  // §7.3, one character
    return data ‖ check
```

`codeBytes` is `b` — the full 16 bytes, top three bits zero. That is the canonical byte form
of a code, and it is what §3.3 and §7.5 take as input.

**125 bits, not 128.** Twenty-five base32 characters carry exactly 125 bits, and 25 characters
is what the five-group display holds. Rather than pad to 26 characters and introduce two
meaningless bits that two implementations could encode differently, the code is defined as a
125-bit value. 125 bits is not a meaningful reduction from 128 for any adversary that exists:
both are far past any brute-force horizon, and the code's practical exposure is a rate-limited,
audited server lookup, not an offline attack.

**Canonical display form**, and the only form the UI, the Emergency Kit `.txt`, and the print
sheet may render:

```
XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-C
```

Five groups of five data characters, then a single-character group holding the check
character. Thirty-one characters including hyphens. The check character is given its own group
on purpose: it is not part of the secret, and a user comparing two codes should be able to see
where the entropy stops.

Input is normalised per §7.1 before anything else looks at it, so a user may type it in lower
case, without hyphens, or grouped differently, and it will be accepted.

### 7.3 The check character: Luhn mod 32

The check character detects transcription errors so a mistyped code produces *"that code has a
typo"* rather than *"invalid recovery code"*. It is a **usability control, not a security
control** — a code that passes the check is still verified by the server's lookup hash and
then by GCM authentication, and the check character adds nothing to either.

Let `v(c)` be the symbol value of character `c` (0–31), and `s(k)` the symbol for value `k`.

**Computing the check character** over the 25 data characters `d[0..24]`:

```
factor = 2
sum    = 0
for i = 24 down to 0:
    addend = factor * v(d[i])
    factor = (factor == 2) ? 1 : 2
    addend = (addend / 32) + (addend mod 32)      // integer division
    sum    = sum + addend
check  = (32 - (sum mod 32)) mod 32
return s(check)
```

**Validating a full 26-character code** `f[0..25]` (data plus check):

```
factor = 1
sum    = 0
for i = 25 down to 0:
    addend = factor * v(f[i])
    factor = (factor == 2) ? 1 : 2
    addend = (addend / 32) + (addend mod 32)
    sum    = sum + addend
valid  = (sum mod 32) == 0
```

This is the standard Luhn mod N algorithm at N = 32. It detects every single-character
substitution and the large majority of adjacent transpositions.

### 7.4 Why Luhn mod 32 and not Crockford's own mod-37

Crockford base32 specifies a check *symbol* computed mod 37, using five additional symbols —
`*`, `~`, `$`, `=`, and `U` — beyond the 32 data symbols. Mod 37 is arithmetically the
stronger choice: 37 is prime, so it catches all transpositions rather than most.

It is rejected here because of what it drags in. The alphabet was chosen so a human can
transcribe a code from a printed sheet without ambiguity, and four of those five extra symbols
are punctuation that is awkward to type on a phone keyboard, easy to lose to a copy-paste that
trims trailing characters, and prone to mangling by the chat and email clients an Emergency
Kit passes through. The fifth is `U`, which the data alphabet excludes for being confusable
with `V`. A single alphabet, typed on a single keyboard, with a single normalisation rule
covering every character including the check, is worth more than the transposition cases mod
37 additionally catches — especially for a control whose job is a better error message.

### 7.5 Server-side storage

For each code the server stores:

| Column | Value |
|---|---|
| `lookupHash` | `SHA-256(utf8("xecret.v2.recovery-lookup") ‖ codeBytes)`, 32 bytes |
| `wrap` | blob type 2 (§2.2) |
| `usedAt` | null until redeemed |

**A fast hash is correct here**, for the same reason `auth/tokens.ts` gives for storing token
hashes as plain SHA-256: the input is a 125-bit uniformly random value with no structure to
attack, so there is nothing a slow KDF would buy, and the lookup stays a single indexed query.
The domain-separation prefix ensures this digest can never collide with another SHA-256 use
over the same bytes.

Lookups MUST be rate-limited and audited. Use the `nextUnlockFailure` backoff from
`auth/vault.ts` — five free attempts, then exponential 60 s → 60 min — against a counter kept
**separate** from the passphrase one, so a mistyped code cannot spend the budget protecting the
passphrase. Emit
`vault.recovery_used` on success.

### 7.6 RCK derivation

```
RCK = HKDF(ikm = codeBytes, salt = "", info = "xecret.v2.recovery-wrap", L = 32)
```

`RCK` is the AES-256-GCM key for that code's UK wrap (blob type 2). Argon2 is deliberately not
used: the input is 125 bits of uniform randomness, not a passphrase, and a memory-hard KDF
over it would cost the user a second and an attacker nothing.

---

## 8. The unlock verifiers

### 8.1 The passphrase verifier

```
unlockVerifier = HKDF(ikm = SK, salt = "", info = "xecret.v2.unlock-verifier", L = 32)
```

The client sends `unlockVerifier` at vault setup and on every unlock that derived `SK`. The
server stores `SHA-256(unlockVerifier)` and compares in constant time (`timingSafeEqual`).

### 8.2 The User Key verifier

```
ukUnlockVerifier = HKDF(ikm = UK, salt = "", info = "xecret.v2.uk-unlock-verifier", L = 32)
```

Sent by an unlock that opened the User Key **without deriving `SK`** — today, a passkey
unlock (blob type 3). The client sends it at vault setup as well, alongside the passphrase
verifier, so both are recorded from the same ceremony; the server stores
`SHA-256(ukUnlockVerifier)` in its own column and compares it the same way.

Both verifiers attest to the same thing — *this client can open this vault* — so a server
MUST apply **one** attempt counter and one lockout across both. Counting them separately would
hand an attacker two budgets against one gate.

The two are **never interchangeable**. A `ukUnlockVerifier` presented where an
`unlockVerifier` is expected fails the comparison, because the stored digests are of different
HKDF branches; §3.3 explains why that separation is deliberate rather than incidental.

A `ukUnlockVerifier` survives a passphrase change and a recovery, and this follows from the
hierarchy rather than being a special case: both re-wrap the UK and neither replaces it, so the
value the branch derives from is unchanged. A client MUST NOT send a new one on those paths,
and a server MUST NOT expect one.

### 8.3 What a verifier is, and is not

**Why a plain SHA-256 is enough on the server side.** The input is already a 32-byte KDF
output — an Argon2id derivation for §8.1, a random 32-byte key for §8.2 — uniformly random from
the server's point of view, with no structure to attack. An attacker holding the stored hashes
gains nothing usable against the wraps, because each verifier is a *sibling* HKDF branch of the
wrap key rather than a parent of it: HKDF's guarantee is that learning one branch reveals
nothing about another.

**What they are and are not for.** Neither is the thing that decrypts anything, and possessing
either opens no vault. Unlock is fundamentally a client-side question — *can I unwrap the UK?*
— and the answer never leaves the browser. A verifier exists so the server can maintain
`vaultUnlockedAt` for API gating, apply the `nextUnlockFailure` backoff to unlock attempts, and
record an audit trail. That is defence in depth and audit fidelity, exactly as `isUnlocked()`
does today, and nothing more.

**A client MUST NOT send `SK`, the UK, any wrap key, or any private key to the server**, under
any circumstance, including diagnostics and error reports.

---

## 9. valueHmac

```
hmacKey  = HKDF(ikm = EHK, salt = "", info = "xecret.v2.value-hmac", L = 32)
valueHmac = HMAC-SHA256(hmacKey, utf8(NFC(plaintext)))          // 32 bytes
```

Computed on the client and sent alongside the ciphertext. The server compares it against the
previous version's `valueHmac` to detect a no-op write, exactly as it does today, and never
learns the plaintext.

**Keyed, not a bare digest.** A plain `SHA-256(plaintext)` would be an offline brute-force
oracle: most secrets are structured or low-entropy enough — short API keys, connection strings
with dictionary passwords — that an attacker holding a database dump could confirm guesses at
high speed. Keying it makes the tag useless without the key hierarchy while still answering
*"is this the same value?"* server-side.

**Keyed from the EHK, not the EDK.** This is the entire reason the EHK exists. The EDK rotates
whenever a principal is revoked; if the HMAC key rotated with it, the first write to every
secret after a rotation would be recorded as a change when nothing changed. The EHK is
long-lived, so `valueHmac` is stable across rotations and no-op detection keeps working.

**No `environmentId` in the info string.** The v1 derivation
(`xecret.hkdf.v1.value-hmac|<environmentId>`) bound the environment so that the same value in
two environments produced different tags. That property is preserved here by the EHK itself:
it is a per-environment random key, so two environments already derive unrelated HMAC keys.
Binding the id as well would add a component two implementations could disagree about, for a
property that is already guaranteed.

---

## 10. The invite key fragment

Invitations are split across two channels (ADR 0009 and the invitation flow): the emailed link
carries only the `xin_…` token, and the **key fragment** travels separately — copied from the
UI and sent over a different medium. A leaked email alone decrypts nothing.

The fragment is generated by the inviter's client and **never reaches the server**. It is
entered client-side on the accept page, or carried in the URL `#fragment`, which browsers do
not transmit.

```
generateInviteFragment():
    seed  = random(16)                        // 128 bits, all of them — no bit clearing
    data  = Crockford-base32(seed) as exactly 26 characters, left-padded with '0'
    check = luhnMod32(data)                   // §7.3, over the 26 data characters
    return data ‖ check

deriveInviteKey(seed):
    invitePrivateKey = HKDF(ikm  = seed,
                            salt = "",
                            info = "xecret.v2.invite-key",
                            L    = 32)        // the X25519 private scalar
    invitePublicKey  = X25519.publicKeyOf(invitePrivateKey)
```

The display form is six groups: `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XC`. Normalisation on input is
exactly §7.1 — strip hyphens and whitespace, upper-case, alias `I`/`L` → `1` and `O` → `0`,
reject anything else including `U`.

The inviter uploads `invitePublicKey` with the invitation and seals the relevant EDK and EHK
grants to it, with `recipientKind = "invite"` and `recipientId = invitationId`. The invitee
signs in, completes vault setup, derives the same private key from the fragment, opens the
grants, re-seals each EDK and EHK to their own public key, and uploads; the invite grants are
then deleted.

**On 128 bits for a key-exchange key.** This is lower than the 256-bit security level of the
rest of the system, and it is bounded deliberately rather than accidentally: an invitation
expires, is single-use, and its token half is independently rate-limited server-side. An
attacker needs the token *and* the fragment, and the fragment's window is the invitation's
lifetime. Raising it would lengthen a string a human copies into a chat message, which is the
one part of this flow where friction translates directly into people sending both halves down
the same channel — the failure this design exists to prevent.

The fragment uses the same alphabet, grouping, and check character as a recovery code so that
one normalisation routine and one "you mistyped this" message serve both. Its `seed` uses all
128 bits, unlike a recovery code's 125: it is 26 base32 characters rather than 25, because
there is no five-group display convention to fit.

---

## 11. Package layout

The E2EE primitives live in a new browser-safe subtree:

```
packages/core/src/crypto/client/
```

**Rules for everything under that directory:**

- **No Node-only APIs.** No `node:crypto`, no `Buffer`, no `fs`, no `process`. Web Crypto,
  `@noble/hashes`, `@noble/curves`, and plain JavaScript only — the same discipline
  `crypto/encoding.ts` already documents, now enforced by directory.
- **Tree-shakeable.** This code ships to browsers. Named exports, no side effects at module
  scope, no barrel that pulls in the whole subtree for one function.
- **The server-side envelope code stays untouched beside it.** `keys.ts`, `secrets.ts`,
  `envelope-service.ts`, and `key-provider.ts` continue to serve `server`-mode environments
  until the migration completes, and are removed then — not now.

**Subpath export.** `packages/core/package.json` exposes each area as its own subpath
(`"./crypto"`, `"./authz"`, `"./audit"`, …). The client subtree gets one more, in the same
style:

```json
"./crypto/client": "./src/crypto/client/index.ts"
```

A separate subpath rather than a re-export from `"./crypto"`, so that importing the client
primitives cannot drag the server envelope — and its `KeyProvider` and Secrets Store binding
types — into a browser bundle.

**This change is Phase 1, not Phase 0.** `package.json` is deliberately not modified by the
commit that introduces this specification; the export is added alongside the first module it
exports.

---

## 12. Test vectors

Cross-implementation test vectors live in
[`packages/core/src/crypto/client/vectors/`](../../packages/core/src/crypto/client/vectors/)
and are consumed by both the TypeScript and Go test suites. The schema, the file layout, and
the generation procedure are described in the README there.

The vectors are the mechanism by which this document is enforced rather than merely written.
Every construction defined above has a corresponding vector kind, and both implementations
MUST pass all of them before either ships.

**One carve-out, recorded here so the file and this document do not appear to disagree.** The
`argon2id` vectors run at parameters *below* the §3.1 floor — `m = 8 MiB` and `m = 16 MiB` —
because a pure-JS derivation at the production parameters costs about a second, and a suite
that spends several of those is a suite people skip. The parameters are an input to Argon2id,
not part of its definition, so the vectors still exercise the same function, encoding, and
normalisation. The floor of §3.1 is a client-side policy control over server-supplied values;
it is enforced by the parameter validator, tested there, and the vector generator deliberately
reaches the Argon2id primitive *beneath* that validator. The vector schema marks the exception
explicitly, with a memory range disjoint from the production one, and the README in that
directory explains it at length. **No implementation may accept these parameters from a
server.**

---

## 13. Credential formats

Two strings that are not blobs, and are specified here because both carry key material
between an unlocked client and a headless one, and neither may be reconstructed by guessing.

### 13.1 The service token

A service token is the only principal in this system that holds an environment's keys without
a person behind it. It therefore carries its own X25519 private key, and the only place that
key can live is in the token string itself — a CI runner has no vault, no passphrase, and
nowhere to keep a secret that the token string is not already keeping.

```
xst_<live|test>_<authHalf>k<keyHalf>

authHalf := b64url(random(32))        // exactly 43 characters
keyHalf  := b64url(random(32))        // exactly 43 characters
```

Eighty-seven characters after the environment segment: 43, one `k`, 43.

**Parsing is by offset, never by search.** `k` is a member of the base64url alphabet, so both
halves routinely contain one, and `indexOf('k')` finds the wrong separator roughly half the
time. A parser MUST take the separator at index 43 of the secret segment, MUST require exactly
one character there, MUST require it to be `k`, and MUST require the total secret segment to be
exactly 87 characters. Anything else is not a v2 service token.

The separator is a character rather than a third `_` because `_` is also in the alphabet and the
existing `isWellFormedToken` splits on the first two underscores; a third would have changed how
every other token kind parses. A fixed offset with a fixed sentinel is checkable in one
comparison and cannot be made ambiguous by any value of either half.

**The two halves are independent 32-byte CSPRNG values.** Neither is derived from the other,
so a server that holds `SHA-256(authHalf)` learns nothing about `keyHalf`, and this is the
whole design:

| Half | Where it goes | What the server stores |
|---|---|---|
| `authHalf` | The `Authorization: Bearer` header, hashed on arrival | `SHA-256("xst_<env>_" + authHalf)` in `service_tokens.token_hash` |
| `keyHalf` | **Nowhere.** It never leaves the client, is never transmitted, never logged, and never written to disk by the server | nothing |

A client transmits `xst_<env>_<authHalf>` and nothing else. The full string is a credential
*and* a key; the half that authenticates is the only half any endpoint ever sees. An
implementation that sends the whole token in an `Authorization` header has handed the server
every secret in the environment and defeated the entire model — this is the single most
important sentence in this section.

**The key half is the X25519 private scalar directly**, not a seed run through a KDF. X25519
clamps internally, so any 32 bytes are a valid scalar; this is exactly what
`generateEncryptionKeyPair` does with `random(32)`. Deriving instead would require a new
registered HKDF branch, which §3.3 forbids without a change to that table, and would buy
nothing: the input is already 32 uniformly random bytes with no other use.

**Token creation.** The creator's browser holds an unlocked vault, so it — not the server —
mints the token string, derives `publicKey = X25519.publicKeyOf(keyHalf)`, uploads
`publicKey` and `keyAlgorithm = "X25519"` alongside the token record, and seals and signs an
EDK+EHK grant to that public key through the ordinary §5/§6 machinery with
`recipientKind = "token"`. For a `server`-mode environment none of that happens and the token
carries no key half, which is what keeps the legacy shape working.

**The legacy shape stays valid.** A token minted before this section — `xst_<env>_<43>`, with
no separator and no key half — is still a well-formed service token and still authenticates. It
simply has no `public_key`, so no grant can be sealed to it, and it cannot read an e2ee
environment. Rotation excludes such tokens from its required set deliberately: a credential
nobody can re-key must not block a rotation for ever.

### 13.2 The CLI hand-off wrap

`xecret login` ends with a CLI process that holds a bearer token and no key material. Under
this model that is not enough — a CLI token acts as its user, and its user's grants are sealed
to a public key whose private half is wrapped under the User Key. The UK has to cross from the
browser, which has just unlocked it, to the CLI process, which cannot.

It crosses sealed, over the loopback redirect that already carries the authorization code, and
**never through the server**:

1. The CLI generates an ephemeral X25519 keypair and puts the public half in the authorize URL
   as `handoff=<b64url(32)>`, alongside the existing `challenge`, `port`, `device`, and `state`.
2. The consent screen, with the vault unlocked, seals the 32-byte UK to that public key —
   an ordinary §5 sealed box — under
   `xecret.aad.v2.cli-handoff|<codeChallenge>|<handoffPublicKey>`.
3. The resulting `xk2.x25519.` blob rides the loopback redirect as a `handoff` query parameter:
   `http://127.0.0.1:<port>/callback?code=…&state=…&handoff=xk2.x25519.…`
4. The CLI opens it with the ephemeral private key it never wrote down, stores the UK in the OS
   keyring, and discards the ephemeral pair.

**A query parameter, not a fragment.** Fragments are not transmitted, which is exactly why the
browser uses them and exactly why one cannot be used here: the loopback listener is an HTTP
server, and a fragment would never reach it. The destination is `127.0.0.1`, the request never
leaves the machine, and the value is a sealed box that is useless without a private key held
only by the process listening on that port.

**The AAD binds the two things that identify this login.** The PKCE code challenge names the
authorization attempt — only the process holding the verifier can complete it — and the
hand-off public key names the recipient. A wrap captured from one login cannot be replayed into
another, and a hostile page cannot substitute a wrap sealed to a key it chose, because it would
have to know a challenge it never saw. Neither component is a UUID, so both are carried as
base64url, which §4.1's component pattern already admits.

**The server never sees the wrap, sealed or otherwise.** It is produced in the browser and
consumed on `127.0.0.1`. `POST /api/cli/authorize` returns only the authorization code, exactly
as before, and no request in this flow carries the UK in any form. §8's prohibition is
unchanged and unweakened: a client MUST NOT send `SK`, the UK, any wrap key, or any private key
to the server.

**A hand-off is optional.** A CLI that omits `handoff` gets the old behaviour and can still read
`server`-mode environments; it simply cannot open a member grant. The consent screen omits the
parameter when the CLI did not ask for one, and never treats its absence as an error.

---

## 14. Review log

| Date | Change |
|---|---|
| 2026-09-08 | Initial version. Phase 0 of the zero-knowledge migration; normative for ADR 0009. |
| 2026-09-08 | Phase 1 (TypeScript implementation). Three clarifications, all found by writing the code against this text: §2.2 now derives the server's ciphertext bound rather than calling it "slightly larger"; §5.2 separates format failures from key-dependent ones, which the vector schema's `errorClass` already assumed and the prose did not; §12 records the Argon2 parameter carve-out the vector file uses. No format, no derivation, and no byte layout changed. |
| 2026-09-08 | Phase 2a (server side of the user vault). The two references to `nextPinFailure` in `auth/pin.ts` now name `nextUnlockFailure` in `auth/vault.ts`, which replaced it when the PIN was retired, and §7.5 records that the recovery counter is kept separate from the passphrase one. No format, no derivation, and no byte layout changed. |
| 2026-09-08 | Phase 2b (passkey unlock). Adds `xecret.v2.uk-unlock-verifier` to §3.3 — the first and only HKDF branch taking the UK as input keying material — and splits §8 into the two verifiers, with one shared attempt counter across both. Closes a gap the client half surfaced: a passkey unlock opens blob type 3 and therefore holds the UK, never `SK`, so it could decrypt everything and still not prove an unlock. No existing format, derivation, or byte layout changed; the new branch is additive. |
| 2026-09-08 | Phase 4 (Go CLI and service-token E2EE). Adds §13, which specifies two strings the earlier phases had no headless client to need: the service token's `xst_<env>_<43>k<43>` layout, parsed by offset because `k` is in the base64url alphabet, with only the auth half ever transmitted; and the CLI hand-off wrap that carries the User Key from an unlocked browser to a `xecret login` process over the loopback redirect. The hand-off adds blob type 11 to §2.2 and the `cli-handoff` purpose to §4.2, both reusing the §5 sealed box unchanged. No existing format, derivation, or byte layout changed; the additions are additive, the legacy service-token shape stays valid, and no new HKDF branch was introduced — the token's key half is the X25519 scalar directly, precisely so §3.3's closed registry did not have to grow. |
