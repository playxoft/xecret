---
title: Tokens and credentials
navTitle: Tokens
description: Sessions, CLI tokens and service tokens — what each can do, how they are scoped and stored, how to rotate them, and what happens when one leaks.
keywords: [service token, cli token xct, xst token, api authentication, token rotation, revoke token]
updated: 2026-11-22
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

You can see and revoke your active sessions under *Settings → Signed-in devices*, and
sign out everywhere at once.

### The vault lock

Signed in and unlocked are different things. Your secrets are decrypted in the
browser with keys your vault holds, and the vault locks when the session has
been idle for a while — an hour by default; 15 minutes, 4 hours, or until the
tab closes if you choose under *Settings → Unlock & auto-lock*. However active you are, an
unlock never lasts more than 8 hours. You can also lock it on demand, in this
browser or in every signed-in session at once.

A locked session keeps you signed in but refuses almost everything with
`session_locked` until you unlock it again with your master passphrase, a
passkey, or a device PIN you have set up on that browser. Unlocking happens in
the browser: the passphrase is never sent.

This is what makes it safe to stay signed in on a laptop you leave on a desk.
The cookie on its own carries no key, so somebody who copies it still cannot
decrypt a value. CLI and service tokens are not subject to the lock.

## CLI tokens

Created by `xecret login`, through a browser consent flow with PKCE. The token
is stored in your operating system's keychain. On a machine with none — or
with `XECRET_KEYRING=file`, for containers — it goes in a file readable only by
you, `~/.xecret/credentials.json`, and the CLI warns you that it has. The same
flow hands the CLI your vault's key, sealed to a key only that process holds,
so it decrypts on your machine; that key is kept in the same place.

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

The value is shown **once**. It carries two things: the part that
authenticates, which the server issues, and a private key your browser
generates, which opens this environment's data key. The server stores a hash of the first and only the
public half of the second, so `xecret run` decrypts on your runner, and there
is no listing that could return the token and no support process that can
recover it. Lost means mint a new one.

The same fact makes the token itself sensitive: whoever has the whole string
can read that environment, so keep it in your CI provider's secret store and
nowhere else.

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
