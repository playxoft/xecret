# 0002 — Root key custody: Phase.dev as source of truth, Cloudflare Secrets Store at runtime

**Status:** Accepted
**Date:** 2026-08-10

## Context

[ADR 0001](0001-trust-model.md) commits us to envelope encryption with a Root Key Encryption
Key (Root KEK) at the top of the hierarchy. That key can never be stored in the database it
protects. Where it lives, and how the Worker obtains it, is the decision here.

Constraints:

- Cloudflare Workers have **no filesystem and no `.env` at runtime**. Configuration is bound
  at deploy time.
- A Worker invocation may have only **6 outgoing connections in flight** simultaneously.
- The hot path (`xecret run`) must not gain a network round-trip.
- Self-hosters should not be forced to open accounts with three cloud vendors.
- The team already uses **Phase.dev** to manage its own application secrets.

## Options considered

### A. Root KEK in Cloudflare Secrets Store, read from a binding
Zero latency, zero subrequests, one vendor. Cloudflare holds the material. No HSM.

### B. Root KEK wrapped by an external KMS (AWS/GCP), unwrapped once per isolate
Split trust — neither Cloudflare nor AWS alone can decrypt. Costs a cold-start round-trip,
SigV4 signing inside a Worker, and an extra vendor for self-hosters.

### C. Per-request KMS unwrap
Rejected. Adds a network call to every secret read, consuming the 6-connection budget, and
provides little real benefit: an attacker with code execution in the Worker can simply ask
KMS themselves.

### D. Worker fetches the Root KEK from Phase.dev at runtime
Rejected, for four independent reasons — any one of which is disqualifying:
1. There is no `.env` to fetch *into*; Workers bind config at deploy time.
2. A Phase.dev outage becomes a total xecret outage — no secret is decryptable for anyone.
3. It is circular: calling Phase requires a Phase service token, itself a secret needing
   storage in the Worker. The problem is relocated, not solved, and a network hop is added.
4. It consumes the connection budget and adds cold-start latency to the hot path.

## Decision

**Option A, with Phase.dev as the system of record.**

```
Phase.dev  ──── deploy time, once per release ────▶  Cloudflare Secrets Store
(source of truth, human access, rotation)            (bound as env.XECRET_ROOT_KEYS)
                                                                  │
                                                       runtime, 0 ms, 0 subrequests
                                                                  ▼
                                                       Worker unwraps Org → Env → secret
```

- **Local development:** `phase run -- npm run dev`. No `.env` file ever exists on disk.
- **Deploy:** `phase run -- wrangler deploy`, or Phase's Cloudflare Workers sync integration.
- **Runtime:** binding only. The Worker never contacts Phase.dev.

> **Note, 2026-08-17 — the commands moved; the decision did not.** Deploying is now
> `phase run -- sh scripts/deploy-web.sh <env>`, and the Secrets Store entry is created once
> by `scripts/deploy-bootstrap.sh` rather than by the deploy. Two things forced the split. A
> `wrangler deploy` *binds* a Secrets Store entry, it does not create one, so the arrow above
> was never a single command's work. And a deployment turned out to be a build plus an upload
> that have to agree about which environment they are — the prerendered pages bake the
> deployment's origin in, and only the script reads it out of `wrangler.toml` and hands it to
> the build. Neither touches what this ADR decided: Phase.dev is still the system of record,
> the runtime is still a binding, and the Worker still never contacts Phase.dev. The bullets
> above are left as written because they are the record of what was decided; the current
> commands live in `.env.example` and [`docs/self-hosting.md`](../self-hosting.md).

Access is mediated by an interface so the provider can change without touching call sites:

```ts
interface KeyProvider {
  getRootKey(version: number): Promise<CryptoKey>   // non-extractable
  currentVersion(): number
}
```

`CloudflareSecretsStoreProvider` ships in v1. `KmsWrappedProvider` (Option B) and
`OrgScopedKmsProvider` (BYOK) are future implementations of the same interface.

## Consequences

### Positive
- No added latency or subrequests on any request path.
- Self-hosters need only a Cloudflare account; Phase.dev is our operational choice, not a
  requirement baked into the software.
- Humans never handle the raw key outside Phase.dev.

### Negative
- **Cloudflare can technically read the Root KEK.** Accepted for v1; Option B is the
  documented upgrade path.
- **Phase.dev becomes a permanent architectural dependency.** This is inherent, not
  incidental: xecret cannot store xecret's own root key, because reading it would require
  already having it. Every secret manager has this bootstrap problem (Doppler uses AWS KMS).
- **A lost Phase.dev account would be catastrophic** without escrow — every customer's data
  becomes permanently unrecoverable, and a database backup does not help, because ciphertext
  without the key is worthless.

### Mandatory mitigations
These are gates on Phase 2, not aspirations. See
[`docs/security/key-recovery.md`](../security/key-recovery.md).

1. Root KEK generated by a documented ceremony and split into **2-of-3 Shamir shares**,
   stored offline in physically separate locations. Never all digital, never all in one place.
2. A restore drill performed quarterly, assuming Phase.dev is unavailable.
3. `key_version` on every wrapped key and every ciphertext from the first migration, so
   rotation is possible without a data migration.
