---
title: Core concepts
navTitle: Core concepts
description: Organisations, projects, environments, secrets, versions and tokens — the vocabulary every other page assumes, defined once.
keywords: [xecret concepts, organisation project environment, secret versions, access levels, service token, glossary]
updated: 2026-08-16
---

Six words carry the whole product. Learn them here and every other page reads
easily.

## The hierarchy

```text
Organisation            acme                 — a company or a person; billing and members live here
└── Project             checkout-api         — one application
    └── Environment     production           — one stage of that application
        └── Secret      STRIPE_SECRET_KEY    — one name, and a history of values
            └── Version v4                   — one value, immutable once written
```

Everything is addressed by **slug** — the lower-case, hyphenated name you see
in URLs — never by a numeric id. That is a security property rather than a
style choice: a slug only means something inside its parent, so the path
`/acme/checkout-api/production/STRIPE_SECRET_KEY` carries the whole ownership
chain and every lookup has to walk it.

### Organisation

A workspace. It owns projects, members, billing and audit history. You get a
personal one on sign-up, and can create more (a company, a client) or be
invited to somebody else's.

Slugs are 25 characters at most and drawn from `a–z`, `0–9` and hyphens.
A handful of words — `api`, `app`, `admin`, `settings`, `members` and similar —
are reserved because they would collide with application routes.

### Project

One application. If it has its own repository, it is probably its own project.

### Environment

One stage of one project: `development`, `staging`, `production`, or whatever
your deployments are actually called. Three are created for you with each new
project, and you can add more.

Two things make an environment more than a folder:

- **It has its own encryption key**, created in the same transaction as the
  environment itself.
- **One of them may be marked production**, which changes who can reach it by
  default. See [access levels](#access-levels) below.

### Secret

A named value inside an environment — `DATABASE_URL`, `STRIPE_SECRET_KEY`.

Names follow the same rule your shell does: letters, digits and underscores,
and never starting with a digit. Up to 256 characters. `MY_KEY` is valid;
`my-key` and `2FA_SECRET` are not.

A secret may also declare a **value type**, which is validated on every write:

`string` (the default, accepts anything) · `boolean` · `int` · `decimal` ·
`email` · `url` · `date` · `datetime` · `json` · `yaml` · `xml` · `ulid` ·
`uuidv4` · `uuidv7`

The failure this prevents is not a typo. It is the deploy where `PORT` was
saved as `3o30`, the service refused to start at 02:00, and the value looked
right to everyone who read it.

### Version

Every write appends. Updating `DATABASE_URL` creates version 5; version 4 is
still there, still readable by anyone who may read the environment, and still
restorable. Nothing is ever overwritten in place.

Writing a value identical to the current one is a no-op — detected without
decrypting anything — so a script that re-applies the same configuration does
not fill your history with noise.

Renaming a secret or changing its note does **not** create a version: declaring
a type is not a rotation, and neither is a rename.

## Who can do what

Two independent gates decide every request, and both must pass.

### Roles

Your role in an organisation says what *class* of action is available to you at
all. There are four, ordered `viewer` < `developer` < `admin` < `owner`.

| Role | Typically |
|---|---|
| `owner` | Created the organisation. The only role that can delete it. |
| `admin` | Manages members, tokens, projects and the audit log. |
| `developer` | Reads and writes secrets; cannot manage members. |
| `viewer` | Reads. Cannot write anywhere. |

Nobody can hand out a role above their own — an admin can appoint another
admin, but only an owner can create an owner.

### Access levels

Your role's capability is one gate; the level you hold on *this particular*
project or environment is the other. Levels are ordered
`none` < `read` < `write` < `admin`.

Where no grant says otherwise, your role supplies a default:

| Role | Non-production | Production |
|---|---|---|
| `owner` | admin | admin |
| `admin` | admin | admin |
| `developer` | write | **none** |
| `viewer` | read | **none** |

**Production is deny-by-default for developers and viewers.** A developer who
needs production must be granted it explicitly by somebody who manages members,
and that grant lands in the audit log with a name attached. The alternative —
production behaving like every other environment until somebody remembers to
lock it down — makes the safe state the one that requires work.

A grant may target a whole project or a single environment, and the more
specific one wins. `none` always denies, whatever the role default would have
said.

Full detail, including the effective-access preview: [teams, roles and
access](guides/teams.md).

## Credentials

Three ways to prove who you are. A request presents exactly one.

| Credential | Looks like | Who uses it |
|---|---|---|
| **Session** | a cookie | You, in the dashboard |
| **CLI token** | `xct_…` | `xecret login` on your machine |
| **Service token** | `xst_…` | CI jobs and containers |

A CLI token *acts as you* — it carries your role and your grants, and nothing
more. A service token is not a person: it is pinned to one organisation, one
project and one environment, is read-only unless you say otherwise, and can
never delete a secret. See [tokens](api/tokens.md).

## The audit log

Every mutation, every decryption, and **every denial** is recorded, in an
append-only table nobody can edit. A system that records only what succeeded
cannot detect an attack in progress.

The log names the actor — a person, a CLI token, or a service token — never
"whoever created the token". A CI write is recorded as the act of that token.
See [the audit log](security/audit-log.md).

## Two rules the CLI never breaks

Worth knowing before you read any command page:

1. **A secret value is never written** to stdout, stderr, a log, a temporary
   file, or a process argument — except by `xecret pull` and
   `xecret secrets get --plain`, whose stated purpose is producing one.
2. **Credentials live in the OS keychain**, never in a dotfile. Where no
   keyring exists, a `0600` file under `~/.xecret/` is used, and the CLI tells
   you it is doing that.

## What to read next

- [Quickstart](quickstart.md) if you have not run anything yet.
- [The CLI](cli.md) for how these concepts appear on the command line.
- [Teams, roles and access](guides/teams.md) to add people.
