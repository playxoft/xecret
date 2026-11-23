---
title: What is xecret?
navTitle: What is xecret?
description: A plain-English explanation of the problem xecret solves, who it is for, and how it compares to keeping a .env file.
keywords: [what is a secret manager, dotenv alternative, env file problem, secret management explained]
updated: 2026-11-22
---

If you have ever pasted a database password into Slack, or asked a teammate to
"send me your `.env`", this page is for you. It assumes you know what an
environment variable is and nothing beyond that.

## The problem, in one paragraph

Applications need configuration they cannot publish: database passwords, API
keys, signing secrets. The traditional home for these is a file called `.env`
sitting in your project folder, ignored by Git so it never reaches the
repository. That works perfectly right up until a second person joins. Then the
file has to travel — over chat, over email, over a USB stick — and from that
moment nobody can answer three questions that matter:

- **Who has a copy?** Every place the file was pasted still has it.
- **Is mine current?** A teammate rotated the API key on Tuesday. Your file
  says otherwise, and you find out when production breaks.
- **What happened?** Somebody's laptop was stolen. Which credentials were on
  it, and did anyone read them before you rotated?

`.env` files are not insecure because they are files. They are insecure because
they are *copies*, and a copy is something you have stopped tracking.

## What xecret does instead

xecret stores each environment's variables once, on a server, encrypted on
your own device before they leave it. Your app never reads them from a file — a command-line tool fetches them and hands
them to your program as it starts:

```bash
xecret run -- npm run dev
```

That command fetches the current secrets, decrypts them on your machine, puts
them into the environment of the process it starts, and runs your app. Your code is
unchanged: it still reads `process.env.DATABASE_URL`, or `os.Getenv`, or
whatever your language calls it. What changed is where the value came from.

Three consequences follow, and they are the whole product:

| | |
|---|---|
| **No file on disk** | Nothing to leak, nothing to accidentally commit, nothing to forget to delete. |
| **One current version** | Rotate a key in the dashboard and every teammate's next `xecret run` has it. There is no "your copy". |
| **Every read is recorded** | The audit log names who read which environment and when. When a laptop goes missing, that question has an answer. |

## Who this is for

xecret is aimed at people who write and ship software: solo developers who are
tired of `.env.example` drifting out of date, and teams who need production
credentials to be something an admin grants rather than something everyone
inherits.

It is *not* a password manager for humans — it does not autofill your bank
login. It is for credentials that programs use.

## How this compares to what you may be using now

| Approach | What it costs you |
|---|---|
| **`.env` files** | Copies you cannot track, no rotation story, no audit trail. Free and fine for a solo hobby project. |
| **CI provider secrets** (GitHub Actions secrets, etc.) | Fine for CI, but they do not help on your laptop, and each provider is a separate silo you keep in sync by hand. |
| **Cloud KMS / Secrets Manager** (AWS, GCP) | Powerful, and built for infrastructure rather than for `npm run dev`. Usually needs SDK changes in your app. |
| **xecret** | One store for laptop, CI and production, injected without code changes, audited — and end-to-end encrypted, so the server holding it cannot read it. |

## Who can read your secrets

You, and the people you share an environment with. Not us.

Every value is encrypted in your browser or by the CLI before it is sent, with
a key that belongs to its environment. That key is sealed to each person and
each CI token allowed to read it, and only they hold the private keys that
unseal it.
xecret's servers store ciphertext and hold nothing that opens it — so a breach
of our database, somebody at Playxoft, or a court order has no values to give
up.

What we can see is the shape around them: secret names, project and
environment names, who is a member, and the audit log of who read what. The
details, and the limits of the guarantee, are in
[what xecret can and cannot see](security/trust-model.md).

> **Note** — For how xecret protects your data end to end — encryption, access
> control, the audit log and vulnerability disclosure — see
> [security at xecret](/security). [The trust model](security/trust-model.md)
> says exactly what the service can and cannot see.

## What to read next

- [Quickstart](quickstart.md) — from sign-up to a running app, about five
  minutes.
- [Core concepts](concepts.md) — the five words the rest of these pages use.
- [What xecret can and cannot see](security/trust-model.md) — the security
  model in full, before you trust it with anything real.
