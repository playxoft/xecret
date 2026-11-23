---
title: Frequently asked questions
navTitle: FAQ
description: Short answers about pricing, security, offline use, team access, migrating away, self-hosting and how xecret compares to .env files and other tools.
keywords: [xecret faq, secret manager questions, is it secure, end-to-end encrypted, offline, pricing, migrate away]
updated: 2026-11-22
schema: faq
---

Short answers, each linking to the page that gives the long one.

## Getting started

### Do I have to change my code?

No. `xecret run` puts secrets into your process's environment, and your code
keeps reading `process.env`, `os.Getenv` or whatever your language calls it.
There is no SDK to install.

### What happens to my existing `.env` file?

Import it, then delete it. The dashboard parses it in your browser and shows a
preview before anything is sent. See
[importing and exporting](guides/import-export.md).

### Can I still use `.env` alongside xecret?

You can, and you will regret it. Two sources of truth for the same
configuration is the problem xecret exists to remove. Import once and delete
the file.

### Does it work on Windows?

Yes — a native binary, with credentials in Windows Credential Manager.
PowerShell, `cmd.exe` and WSL all work. See [installing the CLI](install.md).

## Security

### Can xecret read my secrets?

No. Secret values and notes are end-to-end encrypted: your browser or the CLI
encrypts them before they are sent, under keys that leave your devices only
encrypted. We store ciphertext and hold nothing that opens it, and neither does
anyone who steals our database or orders us to hand it over.

We can see secret *names*, who read what and when, and your account details.
The full list, and the limits of the guarantee, are in
[what xecret can and cannot see](security/trust-model.md).

### What happens if your database is breached?

The attacker gets ciphertext, and the names and metadata beside it. The keys
that open your values were never on our servers to steal. What a stolen
database does allow is guessing at a person's master passphrase offline, which
Argon2id makes slow on purpose — so choose a strong one.

### What if I forget my master passphrase?

Use one of your five recovery codes, or a passkey. If you lose all of them, we
cannot get your vault back — nobody holds a copy of your keys, us included.
Teammates can share their environments with you again, and a reset keeps the
old vault recoverable for seven days. See
[resetting your vault](security/vault-archive.md).

### Are secrets ever written to my disk?

Only if you ask for it. `xecret run` never writes them. `xecret pull` does, by
design, and warns on stderr every time. The offline cache stores an encrypted
copy whose key is in your OS keychain — see
[the offline cache](cli/offline-cache.md).

### Can a teammate see my production secrets?

Not by default. Developers and viewers get `none` on production; reaching it
takes an explicit grant from somebody who manages members, and that grant is
audited. See [teams, roles and access](guides/teams.md).

### Who can see that I read a secret?

Owners and admins, in the [audit log](security/audit-log.md). Every fetch of a
value is recorded — yours included.

## Day to day

### Does xecret work offline?

For `xecret run`, yes. An encrypted local cache answers when the API cannot be
reached, printing its age to stderr. It does **not** answer when the server
actively refuses — a revocation must take effect immediately.

CI has no cache at all, deliberately. See
[the offline cache](cli/offline-cache.md).

### Do I need to be online to start my app?

Only for the first run in a given environment, which is what populates the
cache. After that, a network outage falls back rather than failing.

### Why does my app not see a changed secret?

The environment is injected when the process starts. Restart it — the same
moment you would have edited `.env.local`.

### Can I run different environments at once?

Yes:

```bash
xecret run --environment staging -- npm run dev
xecret run --environment production -- ./verify.sh
```

Each command gets its own environment; nothing is shared between them.

### Is `.xecret.yaml` safe to commit?

Yes, and you should. It contains two slugs and no secrets — the type that
models it has exactly two fields, so nothing in the CLI can write anything else
into it.

## Teams and CI

### How many people can I add?

As many as your plan allows — three on Free, counting the people you have
invited and not yet seen accept; Pro and above do not limit members. The seat
count is enforced when an invitation is sent and again when it is accepted,
inside the same transaction as the membership. Every other plan limit works the
same way and applies from the day it is published: adding one past it is
refused, naming the plan that allows more, and nothing you already have is
taken away. See [plan limits](api/reference.md#plan-limits).

### What is the difference between a CLI token and a service token?

A CLI token acts as *you* — your role, your grants. A service token is not a
person: it is pinned to one project and one environment, is read-only by
default, and can never delete a secret. See [tokens](api/tokens.md).

### Can CI write secrets?

Yes, with a `write` service token. It can never delete one. CI rotates a value
by writing a new version; destroying history is a human's decision.

### What do I do if a token leaks?

Revoke it, read the audit log to see what it read, then **rotate those secrets
at their source**. Revoking the token does not un-leak a value it already read.
The full sequence is in [tokens](api/tokens.md).

## Leaving and self-hosting

### Can I export everything?

Yes. `xecret pull` in five formats, or the export dialog in the dashboard. A
secret manager you cannot export from has taken your configuration hostage.
Version history is not part of a bulk export. See
[importing and exporting](guides/import-export.md).

### Can I run it myself?

Yes — it is AGPL-3.0 and self-hosting is a documented first-class path. It
needs Cloudflare Workers, PostgreSQL and a WorkOS account for identity. The
honest dependency list is in [self-hosting](self-hosting.md).

### What licence is it under?

The server is AGPL-3.0; the CLI is MIT. Run it yourself freely; if you modify
the server and offer it as a network service, publish your changes. The CLI is
unencumbered so it can ship inside your Docker images without licence friction.

### Is it production-ready?

Yes. xecret is built for production credentials: end-to-end encryption with a
published specification, production locked down by default, scoped and
revocable CI tokens, an append-only audit log, and an offline cache that keeps
a local run going through a network outage. Breaking changes are announced
before they ship, and Enterprise agreements add an SLA. See
[security at xecret](/security) and [the trust model](security/trust-model.md).

## Comparisons

### How is this different from a `.env` file?

A `.env` file is a copy, and copies are what you stop tracking: who has one,
whether it is current, and what was on the laptop that went missing. xecret
stores the value once and injects it. See
[what is xecret](what-is-xecret.md).

### How is this different from GitHub Actions secrets?

Those solve CI and nothing else. Your laptop, your containers and your other CI
provider are separate silos you keep in sync by hand. xecret is one store for
all of them, and CI reads it through a scoped token.

### How is this different from AWS Secrets Manager?

Cloud secret managers are built for infrastructure and usually need SDK calls
in your application. xecret is built for `npm run dev` and injects into the
process instead. They are complementary more often than competing.

## Next

- [Troubleshooting](troubleshooting.md) — for error messages rather than
  questions.
- [Quickstart](quickstart.md) — if you have not tried it yet.
- [Trust model](security/trust-model.md) — the security answers in full.
