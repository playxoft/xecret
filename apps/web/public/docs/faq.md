---
title: Frequently asked questions
navTitle: FAQ
description: Short answers about pricing, security, offline use, team access, migrating away, self-hosting and how xecret compares to .env files and other tools.
keywords: [xecret faq, secret manager questions, is it secure, offline, pricing, migrate away, doppler alternative]
updated: 2026-08-16
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

Yes, technically. xecret uses server-side envelope encryption: values are
decrypted inside a single request handler, and every decryption is audited.
This is the same model Doppler uses, and it is what makes team sharing, CI
tokens and browser import work.

If you need a provider that cannot read your secrets even in principle, you
need a zero-knowledge product. The full reasoning, including when to choose
something else, is in [what xecret can and cannot see](security/trust-model.md).

### What happens if your database is breached?

The attacker gets ciphertext. No key material is stored in the database at any
layer — the root key lives in a separate Cloudflare Secrets Store binding the
database has no access to. A breach of *both* is the scenario the model does
not defend against.

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

Owners and admins, in the [audit log](security/audit-log.md). Every decryption
is recorded — including yours.

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

As many as your plan allows; the seat count is enforced when an invitation is
accepted, inside the same transaction as the membership.

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
needs Cloudflare Workers, PostgreSQL and a Firebase project for identity. The
honest dependency list is in [self-hosting](self-hosting.md).

### What licence is it under?

The server is AGPL-3.0; the CLI is MIT. Run it yourself freely; if you modify
the server and offer it as a network service, publish your changes. The CLI is
unencumbered so it can ship inside your Docker images without licence friction.

### Is it production-ready?

Not yet. xecret is **pre-alpha**: feature-complete for its first version, but
it has not run against production infrastructure and has not had its security
pass. Do not store credentials you cannot afford to rotate.

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
