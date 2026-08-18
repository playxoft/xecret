---
title: Tokens and credentials
navTitle: Tokens
description: Sessions, CLI tokens and service tokens — what each can do, how they are scoped and stored, how to rotate them, and what happens when one leaks.
keywords: [service token, cli token xct, xst token, api authentication, token rotation, revoke token]
updated: 2026-08-16
---

Three ways to prove who you are. Choosing the right one is most of the security
work.

## The three credentials

| | Session | CLI token | Service token |
|---|---|---|---|
| **Prefix** | — (a cookie) | `xct_` | `xst_` |
| **Created by** | signing in | `xecret login` | the dashboard |
| **Acts as** | you | you | itself |
| **Scope** | your whole account | one organisation | one org, project **and** environment |
| **Stored** | browser cookie | OS keychain | your CI provider's secret store |
| **Expires** | on sign-out or revoke | on `xecret logout` or revoke | optionally, at a date you set |
| **Can mint credentials** | yes | no | no |
| **Offline cache** | — | yes | no |

## Sessions

What the dashboard uses. A `__Host-`prefixed cookie, plus a CSRF cookie whose
value must be echoed in the `X-Xecret-Csrf` header on every mutation.

You can see and revoke your active sessions under *Settings → Security*, and
sign out everywhere at once.

### The PIN lock

A session can be locked with a PIN separately from being signed out. An
unlocked session lasts 8 hours; a locked one keeps you signed in but refuses
anything sensitive with `session_locked`.

This is what makes it safe to stay signed in on a laptop you leave on a desk.
Setting, changing and resetting the PIN are on the same settings page; a reset
emails a single-use link to your own address and still requires the session, so
there is no way to use it to probe whether an account exists.

## CLI tokens

Created by `xecret login`, through a browser consent flow with PKCE. The token
is stored in your operating system's keychain, never in a dotfile.

**A CLI token adds no authority.** It acts as you: your role, your grants, and
nothing more. That is why creating one requires only active membership rather
than the permission to create *service* tokens — it hands out no power the
holder did not already have.

Consequences worth knowing:

- Change somebody's role, and every device they own changes with it, at once.
- Remove them from the organisation, and every device stops working, at once.
- A CLI token cannot mint another credential. It cannot create a service token,
  invite anybody, or create an organisation.

### Managing devices

*Tokens → Your devices* lists your own CLI tokens by the device name you gave
at login, including recently revoked ones so a revocation you just performed is
visible.

Revoke your own from there or with `xecret logout`. An admin can revoke
anyone's without browsing their device names first.

Give devices names you will recognise. "MacBook" is useless when you have had
three.

## Service tokens

For CI, containers and anything else with no human at the keyboard.

*Tokens → New service token*, then:

| Field | Notes |
|---|---|
| Name | Appears in the audit log against every action the token takes |
| Project + environment | The pin. Cannot be widened later. |
| Access level | `read` (default) or `write`. `admin` is not representable. |
| Expiry | Optional, and worth setting |
| IP allowlist | Optional; use it if your runners have stable egress addresses |

The value is shown **once**. Only its hash is stored, so there is no listing
that could return it and no support process that can recover it. Lost means
mint a new one.

### What a service token cannot do

- **Delete a secret.** Ever, at any access level. CI rotates a value by writing
  a new version; destroying history is a human's decision.
- **Act as a person.** Writes are attributed to the token itself, in a separate
  column from the one that names a user, with a database constraint requiring
  exactly one of the two. A CI write is never recorded under the name of
  whoever minted the token.
- **Mint another credential.** No token can.
- **Leave its pin.** Passing `--environment production` to a job whose token is
  pinned to `staging` fails with a 404, server-side.
- **See the organisation list.** `GET /api/orgs` is refused: a service token is
  pinned to one organisation and has no switcher.

### Introspection

A token can ask what it is:

```bash
curl https://xecret.playxoft.com/api/tokens/self \
  -H "Authorization: Bearer $XECRET_TOKEN"
```

```json
{
  "token":       { "name": "ci-build", "accessLevel": "read" },
  "organization": { "slug": "acme",        "name": "Acme" },
  "project":      { "slug": "checkout-api", "name": "Checkout API" },
  "environment":  { "slug": "production",   "name": "Production" }
}
```

The answer derives from the credential row alone — there is no parameter to lie
in. This is how `XECRET_TOKEN=… xecret run` learns its scope with no
configuration file.

## How to scope them

One token per *(project, environment, purpose)*. It is more tokens, and it is
the right number:

```text
acme/checkout-api/production   read    "deploy-production"
acme/checkout-api/staging      read    "deploy-staging"
acme/checkout-api/test         read    "ci-test"
acme/marketing-site/production read    "deploy-marketing"
```

The reason is blast radius. When one leaks, you want the answer to "what could
it reach?" to be one environment of one project — and the answer to "who was
using it?" to be one pipeline you can fix without breaking four others.

Use `write` only where a job genuinely writes secrets, which is rarer than it
first seems. A deploy reads.

## Rotation

```text
1. Mint a new token with the same scope.
2. Update the consumer (CI variable, orchestrator secret, container env).
3. Revoke the old one.
```

In that order. Revocation is immediate — the lookup filters on "not revoked" in
SQL, so an in-flight job on the old token fails on its next request.

Rotate on a schedule, and always when somebody with access to the CI
configuration leaves.

## If one leaks

1. **Revoke it.** *Tokens → Service tokens → Revoke*. It stops working at once.
2. **Read the audit log** for that token's name: every read it performed, with
   timestamps. This is what tells you which secrets to treat as compromised.
3. **Rotate those secrets** at their source — the database password, the API
   key at the provider. Revoking the xecret token does not un-leak a value it
   already read.
4. **Mint a replacement** and fix whatever exposed the first one.

Step 3 is the one people skip. A token that read your Stripe key has already
given away your Stripe key.

## Next

- [Secrets in CI](../guides/ci.md) — tokens in practice.
- [The audit log](../security/audit-log.md) — reading what a token did.
- [Endpoint reference](reference.md) — the token routes themselves.
