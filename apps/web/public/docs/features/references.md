---
title: Secret references and environment inheritance
navTitle: References and inheritance
description: Build one secret from others with ${env.KEY} templates, and let an environment inherit from a parent — resolved on your machine, never on our servers.
keywords: [secret references, environment inheritance, secret templates, interpolation, environment variables composition]
updated: 2026-10-21
---

Two ways to stop copying the same value into five places: a **template** that
refers to other secrets, and an environment that **inherits** from another.
Both are on the Pro plan and above.

## Templates

A secret whose type is `template` is text with references in it:

```text
postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:5432/app
```

| Reference | Means |
|---|---|
| `${KEY}` | `KEY` in the environment being read |
| `${env.KEY}` | `KEY` in another environment of the same project |
| `${project.env.KEY}` | `KEY` in an environment of another project |
| `$${` | A literal `${` — not a reference |

Names follow the secret-name rules (`[A-Za-z_][A-Za-z0-9_]*`). Anything that
looks like a reference but is malformed — an unclosed `${`, an empty one, four
parts — is refused when you save it, never discovered when a process starts.

Set one from the dashboard by choosing the *template* type, or from the CLI:

```bash
printf '%s' 'https://${API_HOST}/v1' | xecret secrets set API_URL --type template
```

### Where an unqualified reference looks

`${KEY}` resolves in the view of the environment **being read**, not the one the
template is stored in. A template in a parent environment saying `${DB_HOST}`
therefore picks up each child's own `DB_HOST` — which is usually exactly why you
put it in the parent. A qualified `${staging.DB_HOST}` always means staging.

### What is checked before anything is stored

Your client parses the template and declares its references beside the
encrypted value. The server cannot read the template — it is end-to-end
encrypted like every other value — so the declaration is what it checks, before
storing, against the graph as it would be after the write:

- every reference names an environment that exists and **that you can read** —
  a template is not a way round a grant you do not hold;
- no loop: `A → B → A` is refused, in every view that can see the template;
- no chain deeper than **five** references;
- at most **50** references in one template.

Deleting or renaming a secret a template depends on, or deleting an environment
one points into, is refused with the template named.

When a template is read, the client compares its decrypted text against the
declaration stored beside it and refuses a mismatch, so the declaration a server
holds cannot say something the text does not. What that check does **not**
prove is that the server answered each reference honestly: which environment a
slug means, and which stored secret a name means, are things the client learns
from the server. A server that misbehaved could therefore answer
`${staging.DB_HOST}` with a different value — but only one the reader can
already decrypt, from an environment whose key they hold. It cannot make up a
value, because it holds no key to encrypt one, and it cannot reach into an
environment the reader has no key for. The [trust model](../security/trust-model.md)
lists this as a residual risk.

## Inheritance

An environment can name a **parent** in the same project
(*environment settings → Inherits from*). Reading it gives the parent's secrets
with the child's own on top: the child's value wins where both set a key, and a
key the child does not set falls through.

```text
base          DB_HOST=db.internal   LOG_LEVEL=info
└─ staging    LOG_LEVEL=debug       → DB_HOST=db.internal LOG_LEVEL=debug
   └─ qa      DB_HOST=qa-db         → DB_HOST=qa-db       LOG_LEVEL=debug
```

The chain is at most five parents deep, a loop is refused, and setting a parent
needs read access to it. Clearing a parent is always allowed, on any plan.

## Production reading from elsewhere {#production-reading-from-elsewhere}

Linking a **production** environment to one that is **not** — making it
inherit from staging, or giving it a template that reads `${staging.DB_HOST}` —
is allowed, and asked about. The reason is a trust consequence that is easy to
miss: the link is a write path onto production for everybody who can change the
source. A developer who may edit staging but not production changes what
production reads the moment production inherits staging's value — without
production's grants, its deny-by-default for developers, or anybody with
production access being asked.

So such a link is never made silently:

- The first attempt is refused with a warning that names the source and **who
  can write it** — the people, and any write service tokens pinned to it.
- The dashboard shows that warning and asks again (*Inherit anyway*, or saving
  the template a second time); the CLI takes `--confirm-link`; the API takes
  `confirmCrossesProtection: true`.
- A confirmed link is recorded as its own `environment.link_crosses_protection`
  audit event, against production, naming the source.

The same question is asked when an environment's production mark changes
underneath a link that was already there, in whichever direction makes it
cross: marking an environment production while it already inherits from, or
already holds a template reading, one that is not; or removing the mark from
an environment a still-production one — in this project or another — already
inherits from or reads through a template. Nothing about the link moved; only
which side now answers to production's rules did, and that is exactly as much
a new write path onto (or out from under) production as making the link
itself.

Only the link being made, or the flag change that newly crosses one, is asked
about. Re-saving a template with a reference it already had, a production
environment inheriting from another production one, and staging reading from
production ask nothing. If you want production's values to come only from
places production's own rules govern, keep the production environments'
parents and references production too — including a production environment
of *another* project: it answers to that project's own writers, not to this
one's, so a link into it is exactly as much a crossing as a link into staging.

## Resolution happens on your machine

Every value stays encrypted under its own environment's key. `xecret run` and
`xecret pull` fetch one bundle holding the environment, its ancestors and only
the referenced secrets from elsewhere — a reference to `shared.DB_HOST` carries
`DB_HOST`, not the rest of `shared` — open each with your own grant for that
environment, and resolve the result locally. Nothing is re-encrypted and nothing
moves between environments; the server never sees a resolved value.

Every read is recorded where it happened: a pull of `staging` that reads a
secret from `production` through a template writes a `secret.read` against
production, naming the referring secret, so production's own audit trail is
complete.

## Service tokens

A service token is pinned to one environment and can read nothing else, so it
could never resolve an inherited value or a reference into another environment.
Rather than letting that fail during a deploy, xecret refuses it up front:

- a token cannot be minted for an environment that inherits or that holds a
  template reaching outside it;
- an environment with an active token cannot be given a parent, and cannot gain
  a template reaching outside it.

Keep CI environments self-contained, or give the pipeline a login of its own.

## If your plan changes

Nothing stops working. An environment keeps its parent and every template keeps
resolving on any plan; only *setting* a parent or *writing* a template needs the
plan that includes them.

## Next

- [Personal overrides](overrides.md) — your own value for one key, on your machine only.
- [Promotion and point-in-time restore](promotion-and-restore.md) — moving values between environments, and back in time.
- [The trust model](../security/trust-model.md) — what the server can and cannot see.
