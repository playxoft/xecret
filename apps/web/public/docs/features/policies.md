---
title: Policies and new-address read alerts
navTitle: Policies and alerts
description: Require IP allowlists and short lifetimes on tokens, enforce secret naming and strength rules, disable plaintext export, and get told when a new address reads production.
keywords: [secret policy, token ip allowlist, token expiry policy, disable env export, read alerts, secret entropy rules]
updated: 2026-10-20
---

Rules an organisation sets for itself, and a notification it can ask for. Each
is off until somebody turns it on.

## The rule every policy follows

The plan decides who may **turn a policy on or tighten it**. Once on, it is
enforced whatever the plan says next: a downgrade never switches a security
control off, because somebody may be relying on it. Loosening a policy, or
switching it off, never needs a plan.

No policy ever blocks a read. A build that worked yesterday reads its secrets
today, whatever was decided in between.

## Token policy

*Organisation settings → Token policy*, owners and admins, Pro and above.

| Rule | Effect |
|---|---|
| Require an IP allowlist | A new service token is refused unless it names the addresses it may be used from |
| Cap token lifetime | A new service token must expire within the cap, and a new `xecret login` is issued with the cap as its expiry |

The rules apply when a token is **minted**, never when one is used: turning the
policy on must not break every pipeline at once. Tokens minted before it keep
working, and the token list marks the ones outside the policy so you can replace
them deliberately. Setting an allowlist or an expiry on an individual token has
always been available on every plan, and still is.

## Secret naming and strength {#secret-naming-and-strength}

*Organisation settings → Secret naming and strength*, owners and admins, Team
and above. It ships with a sensible default ruleset, switched off:

| Rule | Default |
|---|---|
| Names must match | `[A-Z][A-Z0-9_]*` — the whole name |
| Minimum entropy | 64 bits, for names containing `SECRET`, `PASSWORD`, `PASSWD`, `TOKEN`, `PRIVATE_KEY` or `API_KEY` |
| Forbidden words | `changeme`, `password`, `letmein`, `default`, `123456`, in any case |

The policy can apply to every environment or only to production ones.

**The name rule** is enforced by the server on every write that introduces a
name — a create, a rename, an import, a promotion — whatever client sent it.

**The value rules** need the value, which the server never sees in an
end-to-end encrypted environment. The dashboard and `xecret secrets set` apply
them before encrypting, from the same rules and the same test fixtures, so both
accept and refuse the same values; in a server-side-encrypted environment the
server enforces them as well. A modified client could skip them, and this page
does not pretend otherwise: they are a guard rail for honest mistakes, not a
boundary against a member who means to get round them.

Existing names and values that break the rules are **warnings** in the dashboard,
never errors. A policy adopted today is not a reason to make yesterday's value
unreadable.

Entropy is estimated as the value's length times the Shannon entropy of its own
characters — a 32-character random token scores about 150 bits, `password1`
about 27. It rewards length and variety and is easy to explain, which matters
more for a rule people have to satisfy than precision does.

## Disabling plaintext export {#disabling-plaintext-export}

*Environment settings → Plaintext export*, owners and admins, Team and above.

With export disabled, `xecret pull`, `xecret export` and the dashboard's
download refuse for that environment, naming the policy and who can change it.
`xecret run` is never affected: it puts values into a process without writing
them anywhere, which is the habit this policy exists to encourage.

What it can and cannot do, plainly: anybody who may read a value can still write
it down — they hold it in plaintext the moment they read it. What the policy
removes is the one-command route from a vault to an unencrypted file on a
laptop, which is how most leaked `.env` files begin.

## New-address read alerts

*Environment settings → Read alerts*, Pro and above.

The first time an environment is read from an address — or by a device — that
has not read it before, the organisation's owners and admins are emailed. A CLI
login and a CI token each count as a device; a browser counts as its person; an
IPv6 address counts as its /64, so a laptop's rotating privacy addresses are one
address.

- **On by default for production**, off elsewhere. Each environment can be
  switched either way, or back to the default.
- **Digest-throttled**: at most one email an hour per organisation. Everything
  else seen in the hour waits for the next digest, so a CI fleet on rotating
  addresses produces one email listing them, never one per runner.
- **Recorded after the response.** A read is never slower, and never refused, for
  being noted.

The environment's settings list its recent new addresses, whether or not mail
reached anybody. If the plan stops including alerts, nothing is recorded or sent
until it does again.

## Next

- [Teams, roles and access](../guides/teams.md) — who may change these.
- [Service tokens](../api/tokens.md) — the credentials the token policy governs.
- [The audit log](../security/audit-log.md) — `org.policy_changed` and `environment.policy_changed`.
