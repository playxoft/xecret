# 0001 — Server-side envelope encryption over end-to-end encryption

**Status:** Accepted
**Date:** 2026-08-10

## Context

xecret stores customer secrets. The single most consequential decision in the product is
**who holds the keys**, because it determines the database schema, the API surface, the
dashboard UX, the CLI login flow, invitation handling, and the marketing claims we are
allowed to make. It is extremely expensive to change later.

Two established models exist in this market:

- **Doppler model** — the server encrypts and decrypts. The service operator can technically
  read customer secrets.
- **Phase model** — the client encrypts. The server stores ciphertext it cannot read
  ("zero-knowledge").

The original brief cited both products as inspiration without noticing they sit on opposite
sides of this line.

## Options considered

### A. Server-side envelope encryption (Doppler model)

- ✅ Secrets can be read by the API, which makes server-rendered dashboards, `xecret run`,
  CI service tokens, search, import, and integrations all straightforward.
- ✅ Password reset and account recovery work normally — losing a device is not fatal.
- ✅ Team sharing is a database row, not a key-exchange protocol.
- ✅ Ships in weeks, not months.
- ❌ A full compromise of the Worker plus the root key exposes all customer secrets.
- ❌ We must be honest in marketing: we *can* decrypt.

### B. End-to-end / zero-knowledge encryption (Phase model)

- ✅ Strongest possible claim: a database breach yields nothing, and we cannot be compelled
  to hand over plaintext.
- ❌ Every client (browser, CLI, CI runner) needs key material, and key distribution to CI is
  genuinely hard — the CI runner must get a decryption key from somewhere.
- ❌ Team member addition/removal becomes a key re-wrap operation across every secret.
- ❌ Lost device or forgotten password can mean permanent data loss without a recovery-key
  ceremony that most users will skip.
- ❌ Server-side features (search, audit of *values*, integrations, web-based import) become
  impossible or must move to the client.
- ❌ Roughly 3× the implementation effort and far more ways to get it subtly wrong.

### C. Hybrid — server-side by default, opt-in E2E per environment

- ✅ Best of both, in theory.
- ❌ Two complete code paths for crypto, sharing, CI, and UI from day one. The worst option to
  start with; a reasonable option to *end* with.

## Decision

**Option A — server-side envelope encryption.**

Key hierarchy:

```
Root KEK ──wraps──▶ Org Master Key ──wraps──▶ Env Data Key ──encrypts──▶ Secret Version
```

Every layer carries a version number so any layer can be rotated independently.

The crypto layer is written behind interfaces (`KeyProvider`, and encryption confined to
`packages/core/crypto`) so that adding an opt-in E2E mode later is an additive change rather
than a rewrite.

## Consequences

### Positive
- The golden path (`xecret run -- npm run dev`) is a simple authenticated read.
- CI works with a single scoped token and no key distribution problem.
- Team management is ordinary CRUD.
- Import, search, and rotation are all server-side and simple.

### Negative
- **We can read customer secrets.** This must be stated plainly in `SECURITY.md`, the privacy
  docs, and the landing page — not buried. Attempting to imply otherwise would be dishonest
  and would eventually be discovered.
- We are a higher-value breach target than a zero-knowledge service.
- Some security-conscious customers will choose a zero-knowledge competitor. That is an
  acceptable trade for v1.

### Mitigations required
- Root key never in the database (see [0002](0002-root-key-custody.md)).
- Decrypt only on demand, never in bulk for a dashboard render.
- Every decryption produces an audit event.
- Least-privilege database credentials; database compromise alone yields only ciphertext.

### Revisit when
Enterprise deals start requiring zero-knowledge, or we have the team to maintain two crypto
paths correctly. Track demand; do not build speculatively.
