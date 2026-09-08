# 0009 — Zero-knowledge encryption: the client holds the keys

**Status:** Accepted
**Date:** 2026-09-08
**Supersedes:** [0001](0001-trust-model.md)

## Context

[ADR 0001](0001-trust-model.md) chose server-side envelope encryption — the Doppler model —
and said so plainly: *"We can read customer secrets."* It also said when to revisit:

> Enterprise deals start requiring zero-knowledge, or we have the team to maintain two crypto
> paths correctly.

That moment has arrived, and it arrived from the product side rather than the engineering
side. The claim a secrets manager is bought on is *"even we cannot read them"*, and every
competitor xecret is compared against — Bitwarden, Proton, MEGA, Phase — can make it. We
cannot, and 0001's honest `SECURITY.md` paragraph saying so is a line item in every security
review a prospect runs.

0001 also left the door deliberately unlocked. Encryption was confined to
`packages/core/src/crypto` behind `KeyProvider`, `aead.ts`, and `aad.ts` specifically so that
moving the trust boundary later would be additive rather than a rewrite. This ADR walks
through that door.

The threat this closes is **T7 and T9** from the [threat model](../security/threat-model.md):
Worker compromise and the xecret insider. Both are currently mitigated only by detection,
because a Worker holding the Root KEK can decrypt anything and no technical control stops the
person who holds production access. Under this ADR neither can, because neither ever holds a
key that opens anything.

## Options considered

### A. Stay on server-side envelope encryption

- ✅ Zero work. Everything already built keeps working.
- ✅ Server-side search, import, rendering, and dashboards stay simple.
- ❌ The insider and Worker-compromise risks stay exactly where they are, permanently.
- ❌ The marketing claim stays unavailable, permanently.

Rejected. This is the decision being revisited; restating it is not an option, it is a no-op.

### B. Opt-in zero-knowledge per environment (0001's option C, revived)

- ✅ Existing data is never touched. No migration.
- ❌ Two complete crypto paths, forever, in the server, the web client, and the CLI.
- ❌ The claim becomes *"we cannot read your secrets, if you ticked the box"*, which is worth
  approximately nothing in a security review and is a support burden in every other
  conversation.
- ❌ Every feature is built twice and tested twice, at half the confidence in each.

Rejected as a *destination*. It is, however, an unavoidable *transition state* — see the
phasing note below, where dual-mode exists on purpose and has a scheduled removal date.

### C. Full zero-knowledge for all secret values

- ✅ One trust story, one claim, one set of tests that mean what they say.
- ✅ A database dump plus the Root KEK plus the full Worker source yields nothing.
- ❌ Forgotten passphrase with no recovery code left is unrecoverable, by us, for that user.
  There is no support ticket that fixes it.
- ❌ Team sharing becomes a key-exchange protocol rather than a database row.
- ❌ Import, export, format rendering, and version diffing all move to the client.
- ❌ Substantially more code, and every line of it is code where a subtle mistake is silent.

**Chosen.** The costs are real, and every one of them is listed again individually under
Consequences rather than allowed to disappear into a decision. What tips it is that the ❌
items here are *work* — finite, schedulable, testable — while the ❌ items under option A are
*permanent properties of the product*.

## Decision

**All secret values and notes are encrypted on the client, under keys the server never sees.**

Secret **names** stay plaintext. That is a deliberate, documented trade — see Trade-offs.

### Key hierarchy

```
USER SIDE (per user)
  Master Passphrase ──Argon2id──► Stretched Key (SK, 32B)      [client only, never leaves]
                                     │
  Recovery Code #n ──HKDF──► RCKn    │        Passkey PRF ──HKDF──► PK
  (high entropy, no Argon2 needed)   │
                                     ▼
              ┌── wrap #1: AES-GCM(UK, HKDF(SK))    "passphrase wrap"
  User Key ◄──┼── wrap #2..6: AES-GCM(UK, RCKn)     "recovery wraps" (one-time)
  (UK, 32B)   └── wrap #7: AES-GCM(UK, PK)          "passkey wrap"  (optional)
      │
      ├─ encrypts ─► User X25519 private key   (encryption; public key stored plaintext)
      ├─ encrypts ─► User Ed25519 private key  (signing;    public key stored plaintext)
      └─ HKDF ────► unlock verifier (sent to server for lock-screen gating)

SHARING SIDE (per environment)
  Environment Data Key (EDK, 32B, random, client-generated, rotates on revocation)
  Environment HMAC Key (EHK, 32B, random, client-generated, long-lived — survives rotation)
      ├─ EDK+EHK sealed to each authorized member's X25519 public key
      ├─ EDK+EHK sealed to each service token's X25519 public key   (same sealed box)
      │     └─ every grant row carries an Ed25519 signature by its creator
      │        (verification deferred — see Trade-offs)
      ├─ EDK encrypts every secret value + note in that environment (AES-256-GCM + AAD)
      └─ HKDF(EHK) ─► per-env HMAC key ─► valueHmac (computed client-side,
                                          stable across EDK rotations)
```

Three properties are worth reading twice, because they are what make the design affordable:

- **Changing a passphrase re-wraps one 32-byte key.** Nothing else re-encrypts. The UK is
  unchanged, so sessions on other devices stay valid and no secret is touched.
- **Per-environment EDKs are required, not an optimisation.** Access is granted per
  project and per environment — production is deny-by-default — so a developer without
  production access must simply *not hold* the production EDK. A single org-wide key would
  make the authorization model decorative.
- **Service tokens survive EDK rotation.** A token carries an X25519 *private* key in its
  string; the server stores only the public half and the auth hash. Rotation re-seals the
  new EDK to every remaining principal, members and tokens alike, because every principal
  has a public key the rotating client can read. Revoking a member does not break CI.

### Algorithms and parameters

Pinned here. Changing any of them later requires a new blob version, and every parser
rejects versions it does not know.

| Purpose | Choice | Notes |
|---|---|---|
| Passphrase KDF | **Argon2id**, m=64 MiB, t=3, p=1, 16B salt, 32B output | Client-side. Per-user params are stored so they can be raised later, with a `needsUpgrade` re-wrap on next unlock — the same shape as the retired `pinNeedsRehash`. Browsers are single-threaded for this, so p=1. Above the OWASP 2025 floor and level with Bitwarden's defaults. Go: `golang.org/x/crypto/argon2`. Library choice for the browser: see the Argon2 measurement section below. |
| Symmetric | AES-256-GCM, 12-byte IV, 128-bit tag | `crypto/aead.ts` verbatim. No new AEAD, no new IV convention. |
| Asymmetric — sealing EDK/EHK to members, tokens, and invites | **X25519 via `@noble/curves`, unconditionally** — browser, Worker, everywhere | No feature detection, no P-256 fallback, one code path to review. Go: `crypto/ecdh`. The blob format is versioned (`xk2.x25519.…`) so a future curve change stays possible without inheriting this decision's complexity. |
| Signing — grant authenticity | **Ed25519 via `@noble/curves`.** Every grant row is signed by its creator at creation | Go: `crypto/ed25519`. **Verification is deferred** — the keys and signature columns exist from day one so enabling it later is a client update, not a data migration. See Trade-offs. |
| Sealed box | ephemeral X25519 → ECDH → HKDF-SHA256 → AES-256-GCM; payload = `ephemeralPub ‖ iv ‖ ct` | Deterministic and dependency-light; no libsodium. Cross-implemented in TypeScript and Go against shared test vectors. One construction for member, token, and invite grants. |
| Subkeys and the unlock verifier | HKDF-SHA256 with explicit `info` domain separation (`xecret.v2.unlock-verifier`, `xecret.v2.uk-wrap`, `xecret.v2.value-hmac`, `xecret.v2.prf-wrap`, …) | No key is ever used raw for two purposes. The full enumeration is normative in the [crypto spec](../security/e2ee-crypto-spec.md). |
| Environment HMAC Key (EHK) | 32B random, generated at environment creation, sealed alongside the EDK, **never rotated by default** | Its only job: `valueHmac = HMAC-SHA256(HKDF(EHK, "xecret.v2.value-hmac"), plaintext)` stays stable across EDK rotations, so no-op write detection keeps working. Deriving it from the EDK instead was considered and rejected — it costs one spurious version bump per secret after every rotation. |
| Recovery codes | 5 codes, 125-bit, Crockford base32, `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-C` with a Luhn mod-32 check character | High entropy, so HKDF rather than Argon2. Each code independently wraps the UK. The server stores a lookup hash, the wrap, and `usedAt`. |
| Blob format | `xk2.<algo>.<base64url payload>` on every stored crypto artifact | Follows the `xecret-share-v1.` precedent in `crypto/escrow.ts`. Every parser rejects unknown versions loudly rather than guessing. |
| AAD | `xecret.aad.v2.<purpose>|<component>|…`, extending `crypto/aad.ts` | Binds every ciphertext to the row that holds it, so a relocated ciphertext fails to decrypt instead of silently succeeding. Same rationale as v1, new purposes. |

The byte-level definition of all of this — every info string, every payload layout, the
signature canonicalisation, the check-character algorithm — is
[`docs/security/e2ee-crypto-spec.md`](../security/e2ee-crypto-spec.md). This ADR records the
decision; that document is what an independent Go implementation or a third-party auditor
reads.

### Argon2 measurement

The plan called for a measurement, not a bake-off, with a bar of roughly 1.5 s on a
mid-range phone. Here is what was measured, and it did not go the way the default assumed.

**Bench machine:** Intel Core i9-14900KS (32 logical cores), 31.7 GiB RAM, Windows 10 19045,
Node v22.19.0 / V8 12.4.254.21. Node on desktop V8 is the proxy for browser V8; it is a
*generous* proxy, because this is a fast desktop core.

Eight runs after a warm-up, `dkLen = 32`:

| Library | Parameters | min | median | mean | max |
|---|---|---|---|---|---|
| `@noble/hashes` 2.4.0 | m=64 MiB, t=3, p=1 *(target)* | 931 ms | **963 ms** | 1015 ms | 1431 ms |
| `@noble/hashes` 2.4.0 | m=19 MiB, t=2, p=1 *(OWASP floor)* | 296 ms | 302 ms | 305 ms | 315 ms |
| `hash-wasm` 4.12.0 | m=64 MiB, t=3, p=1 *(target)* | 174 ms | **178 ms** | 178 ms | 183 ms |
| `hash-wasm` 4.12.0 | m=19 MiB, t=2, p=1 | 35 ms | 38 ms | 37 ms | 39 ms |

The two libraries produce **byte-identical output** at the target parameters — checked, not
assumed. Argon2id is a specified function; the library is an implementation detail of speed,
not of format. Switching is a dependency change, not a migration.

**What the numbers say.** Pure-JS Argon2id costs **963 ms at the target parameters on a
top-of-the-range desktop CPU**. A mid-range phone runs single-threaded JS somewhere between
three and five times slower, which puts noble at an estimated 3–5 s there. That is not near
the 1.5 s bar; it is several times past it. `hash-wasm` at 178 ms on the same machine has
roughly an 8× budget before it reaches the bar.

**What we are doing about it.** The plan's default — `@noble/hashes`, on the strength of it
being a dependency we already want for `@noble/curves` — stands *provisionally*, and the
honest expectation recorded here is that it will not survive the phone test.

- **The phone measurement is a Phase 2 gate, not a nice-to-have.** Before any vault UI ships,
  Argon2id at m=64 MiB / t=3 / p=1 is timed in a real browser on a real mid-range phone. The
  numbers go in this section.
- **If it exceeds ~1.5 s there, we move to `hash-wasm`,** which the desktop numbers say it
  will. Parameters do not change; the derived key does not change; stored blobs do not change.
- **One thing must be verified before that switch, and it is not performance.** The
  production Content Security Policy (`apps/web/src/lib/csp.ts`) carries `'unsafe-inline'` in
  `script-src` for the RSC flight payload, but it carries neither `'unsafe-eval'` nor
  `'wasm-unsafe-eval'`. WebAssembly compilation is gated on `script-src` independently of
  `'unsafe-inline'`, so **hash-wasm will be refused by the policy as it stands today.**
  Adopting it means adding `'wasm-unsafe-eval'` to `script-src` — a real widening of the
  policy that ADR 0008's constraints already make hard to compensate for elsewhere, and one
  that `csp.test.ts` will force to be a deliberate two-place edit rather than a silent one.
  That trade is to be made explicitly in Phase 2, with the phone numbers in hand, not
  discovered during a deploy.

Lowering the parameters instead is **not** on the table. A database dump hands an attacker an
offline Argon2 oracle against every user's passphrase, and that passphrase is the only thing
standing between the dump and the whole vault. The cost is the control.

## Consequences

### Positive

- A database dump, plus the Root KEK, plus every server-side secret, plus the full Worker
  source, produces **no secret value**. This is testable, and Phase 6 ships the test.
- T9 — the xecret insider — stops being a residual risk we manage by policy and becomes one
  the architecture forecloses. Same for T7 inside the secrets path: code running in the
  Worker has ciphertext and public keys, and nothing that opens them.
- The claim becomes available, and unlike most products making it, ours will be backed by a
  published byte-level spec and a CLI a customer can build themselves.
- Compelled disclosure has nothing to disclose.
- The CLI's offline cache improves as a side effect: it stores ciphertext and sealed grants
  rather than plaintext, so a stolen laptop's cache is no longer plaintext at rest.

### Negative — every one of these is real

- **A user who loses their passphrase and all five recovery codes is unrecoverable.** Not
  "hard to recover" — unrecoverable, by anyone, including us. Their org's data survives as
  long as another member holds a grant, and the answer is that teammates remove and re-invite
  them. The UI must say this in those words, at setup, and mean it.
- **Team sharing is a key-exchange protocol.** Adding a member is a seal-to-their-public-key
  operation performed by a client that holds the key, which means it can be *pending* when no
  such client is online. That is a queue, a banner, and a state machine that a database row
  did not need.
- **Removing a member requires an EDK rotation**, which is a multi-step ceremony with a
  progress modal and failure modes, not a `DELETE`.
- **Import, export, format rendering, version diffing, and secret search-by-value all move
  client-side or cease to exist.** `packages/core/importer` and `format` are already
  runtime-agnostic, which is the only reason this is a port rather than a rewrite.
- **Argon2 is a visible pause.** Unlock is no longer instant; it is a spinner and a sentence
  explaining what is happening. See the measurement section for how visible.
- **Every crypto bug is now silent and client-side.** A server-side envelope bug throws a 500.
  A client-side one writes a blob nobody can ever open again. This is why Phase 0 exists at
  all, why the format is versioned everywhere, and why cross-implementation test vectors are a
  gate rather than a nicety.
- **`secrets-service.ts` loses its distinguishing comment.** It is currently *"the only module
  in xecret where a plaintext secret exists"*; after cutover that sentence is true of no
  module, which is the entire point, and the comment goes.

### Trade-offs accepted deliberately

Each of these is a place where we could have spent more and chose not to. They are listed
here rather than buried so that a reader can disagree with a specific one.

**1. Secret names stay plaintext.** Only values and notes are encrypted. `STRIPE_LIVE_KEY`
existing in `production` remains visible to anyone with database access, and that is genuine
intelligence about a customer's stack. Bought with it: server-side listing, searching,
sorting, and the entire secret-browsing UI staying a normal query. Encrypting names would
mean either downloading every name to search, or a searchable-encryption scheme with its own
leakage profile. Revisit if customers ask; do not build speculatively.

**2. Public keys are trusted on first use.** A malicious server can hand a client the wrong
public key for a member and intercept every grant sealed afterwards. Mitigations are TOFU
pinning in local storage, an audit event on every key change, and key fingerprints shown in
the members UI for out-of-band comparison. Key transparency and cross-signing are explicitly
out of scope. **Residual risk: a server willing to be actively malicious can intercept
*future* grants for a member whose key it swaps.** It cannot read anything sealed before the
swap, and the fingerprint change is visible to anyone who looks.

**3. Grant signatures are created but not verified.** Every `env_key_grants` row carries an
Ed25519 signature by its creator over the environment, the EDK version, the recipient, and
the sealed blobs. Nothing checks it yet. Verification needs a trust root for signer keys —
which is trade-off 2 one level up — and a failure UX that does something more useful than
locking a user out of their own org because a teammate reinstalled. **Residual risk: until
verification is on, `wrappedBy` is a server-asserted field, and a malicious server could
insert its own grant and read everything written afterwards.** Signing from day one is what
makes turning verification on later a client update rather than a data migration; that is the
whole reason the columns exist now.

**4. A removed principal keeps an equality oracle.** The EHK is deliberately not rotated when
a member or token is revoked — that is what keeps `valueHmac` stable and no-op write detection
working across EDK rotations. The consequence: a removed principal who kept the EHK, and who
later obtains a database dump, can **confirm** whether a current value equals one they already
know or can guess. They cannot decrypt anything, and they cannot read anything new. An org
that finds this unacceptable can rotate the EHK too, at the cost of one round of spurious
"changed" detections across every secret. Documented rather than defaulted, because the
default should not silently degrade a feature every user relies on.

**5. Freshness is not protected. The server can lie by omission.** Signatures prove origin,
not recency. A malicious or compromised server can serve *stale* grants, or silently omit
recent `secret_versions`, and the client has no way to tell — it sees a well-formed,
correctly-signed, correctly-decrypting response that is simply out of date. **Residual risk:
rollback and stale-serve attacks are undetected in v1.** The named future mitigation is a
**client-tracked monotonic version counter** per environment: the client remembers the highest
version it has seen and refuses any response whose maximum regresses. It is not being built
now, but API responses carry the current max version from Phase 3 onward *specifically* so
that adding it later is a client change with no API change.

**6. Recovery is strictly one-time codes. There is no escrow.** No org-admin recovery, no
support-side reset, no key held anywhere on our side. This was decided by the product owner
and is not a gap to be filled later — filling it would reintroduce exactly the party this ADR
exists to remove. The cost is paid by the user who loses everything, and it is a real cost;
the mitigations are a mandatory recovery-code ceremony at setup that will not let itself be
skipped, a downloadable Emergency Kit, and codes that can be regenerated at any time from the
Security screen.

**7. A web-delivered E2EE app's trust anchor is the JavaScript we serve.** This is the
honest asterisk on the entire claim, and stating it plainly is not optional. Every mitigation
above assumes the client is running the code we published. A server willing to serve one
poisoned bundle to one targeted user defeats all of it, and no amount of client-side crypto
changes that. What we can do, and will:

- A strict CSP, kept as tight as the stack permits — and read
  [`csp.ts`](../../apps/web/src/lib/csp.ts) and the threat model's T1 section for an honest
  account of what it does *not* enforce, because `'unsafe-inline'` is in `script-src` and ADR
  0008 explains why it cannot be removed.
- Subresource Integrity where the framework permits it.
- Reproducible builds, long-term.
- **The CLI as the verifiable client.** It is Go, it is MIT-licensed, releases are signed
  with cosign, and a customer who does not want to trust a bundle they cannot pin can build
  it from source and never open the dashboard. This is the real answer, and it is the same
  one MEGA and Proton give.

This belongs in `SECURITY.md` in these terms, not softened.

### Sequencing — and the one rule that matters

Phases 0–4 ship zero-knowledge for **new environments only**. Every existing environment stays
on the server envelope, untouched, and both paths run side by side on purpose. Phase 5 —
migrating existing data — **does not begin until the new path has run in production for a
meaningful soak period** with no crypto-path incidents.

Migration is the step that reads every historical secret, re-encrypts it, and deletes the
original. It must not be the code path that discovers a bug. Dual-mode is the transition
state option B would have made permanent; here it has a scheduled removal.

The marketing claim is gated on the end of Phase 5, not on the merge of this ADR. Until the
last environment is migrated and the envelope decrypt path is deleted, we can read *some*
customer secrets, and saying otherwise would be the one mistake this ADR cannot survive.

### Revisit when

- The phone Argon2 numbers arrive (Phase 2) — the library decision and possibly the CSP
  change with them.
- A signer trust root exists, at which point grant-signature verification turns on
  (trade-off 3).
- Rollback protection is wanted badly enough to build the monotonic counter (trade-off 5).
- Customers ask for encrypted secret names (trade-off 1).
