---
title: What xecret can and cannot see
navTitle: Trust model
description: The encryption model stated plainly — envelope encryption, the key hierarchy, what a database breach yields, and when you should choose a zero-knowledge product instead.
keywords: [envelope encryption, zero knowledge alternative, secret manager security, aes-256-gcm, key hierarchy, threat model]
updated: 2026-08-16
---

A security product that overstates its guarantees has broken the only thing it
sells. So this page says what xecret protects you from, and what it does not,
before you put a real credential in it.

## The short version

**xecret uses server-side envelope encryption. The service can technically
decrypt your secrets.**

This is the same model Doppler uses. It is what makes team sharing, CI tokens
and browser-side import work without every user performing a key exchange.

If you need a provider that *cannot* read your secrets even in principle, you
need a zero-knowledge product, and you should know that now rather than after
migrating.

## The key hierarchy

```text
Root key  ──wraps──▶  Organisation key  ──wraps──▶  Environment key  ──encrypts──▶  Secret version
```

Four layers, each versioned so any one can be rotated independently.

| Layer | Where it lives |
|---|---|
| Root key | Cloudflare Secrets Store, bound to the Worker. **Never in the database.** |
| Organisation key | In the database, encrypted under the root key |
| Environment key | In the database, encrypted under its organisation's key |
| Secret version | In the database, encrypted under its environment's key |

Values are encrypted with **AES-256-GCM**, and each ciphertext is bound to its
exact position in the hierarchy. A secret row moved from `staging` to
`production` does not decrypt: the authentication tag covers the identity of
the environment it belongs to. The same technique protects the CLI's [offline
cache](../cli/offline-cache.md).

## What each kind of compromise yields

| An attacker who gets… | Gets |
|---|---|
| A database backup | **Ciphertext only.** No key material at any layer is stored in the database. |
| The database *and* the root key | Everything. This is the scenario the model does not defend against. |
| Your CLI token | What you can reach, until it is revoked — and every use is audited. |
| A CI service token | One environment of one project, read-only unless you made it otherwise. |
| Your session cookie | Your account, subject to the PIN lock on anything sensitive. |

The design goal is that the database and the key never sit in the same place:
the database is a managed PostgreSQL instance, and the root key is in a
Cloudflare Secrets Store binding that the database has no access to.

## The rules the implementation follows

These are enforced structurally, not by convention:

- **Decryption happens in one place.** The masked listing and the reveal
  endpoint are separate routes, so "where can a plaintext be produced?" has an
  answer a reviewer can verify by searching the code.
- **Nothing is decrypted in bulk for a page render.** A dashboard listing shows
  names, versions and timestamps; values are fetched one at a time, on demand,
  and each fetch is audited.
- **Every decryption produces an audit event.** An audit row therefore always
  means a plaintext actually left the server.
- **Every denial is audited too.** A system that records only what succeeded
  cannot detect an attack in progress.
- **Audit metadata cannot contain a value.** The type describing it is a fixed
  allowlist of field names with no catch-all, so a secret cannot be placed in a
  record — the compiler rejects it rather than a reviewer having to notice.
- **Error messages are fixed strings.** Nothing derived from an exception, a
  database error, or the rejected input reaches a client, because the rejected
  input may itself be a secret.
- **The database role is least-privilege.** The application's credentials
  cannot alter the audit table, which is append-only by grant rather than by
  discipline.

## What xecret does not protect you from

Stated plainly, because these are the failures people are surprised by:

- **A compromised laptop.** If somebody has your machine and your unlocked
  keychain, they have what you have. Revoke the device; the audit log tells you
  what it read.
- **Your own code leaking values.** `xecret run` puts secrets into your
  process's environment. If your app logs `process.env`, or a crash reporter
  ships it, xecret cannot stop that.
- **`xecret pull` writing a file.** The command warns each time. What happens
  to that file afterwards is yours.
- **Anything a browser can read.** `NEXT_PUBLIC_` and `VITE_` variables are
  inlined into bundles you serve to the public. Managed and versioned, yes;
  private, no. See [React / Vite](../guides/react-vite.md).
- **Us.** We can decrypt. That is this page's first sentence.

## If you self-host

Self-hosting does not change the model — it changes **who** you are trusting
from us to your own Cloudflare account, your own database, and your own key
custody.

That is a real improvement if you can operate key custody well, and a real
downgrade if you cannot. The root key is the whole ballgame:

> **Important** — Lose the root key and every secret is permanently
> unrecoverable. There is no support ticket that fixes it. Generate it, split
> it, and escrow the shares in physically separate places **before** the first
> real secret is stored.

See [self-hosting](../self-hosting.md).

## Choosing something else

You should pick a zero-knowledge product instead if:

- a regulator or contract requires that the provider be technically incapable
  of reading your data; or
- your threat model includes the provider being compelled to hand over
  plaintext; or
- you are storing secrets whose exposure would be unrecoverable regardless of
  rotation.

You are fine here if:

- your main problem is `.env` files sprawling across laptops and Slack;
- you need CI, teams and rotation to be simple; and
- you are willing to trust an operator with credentials you can rotate.

We would rather write that paragraph than have you discover it later.

## Reading the source

The server is AGPL-3.0 and the CLI is MIT. The cryptography and authorisation
logic live in a package that imports nothing runtime-specific, so both can be
audited and unit-tested in isolation rather than read through a web framework.

## Next

- [The audit log](audit-log.md) — what is recorded and how to read it.
- [Tokens](../api/tokens.md) — scoping credentials, and what to do if one leaks.
- [Self-hosting](../self-hosting.md) — moving the trust to yourself.
