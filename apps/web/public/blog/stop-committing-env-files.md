---
title: Stop committing .env files: how to get secrets out of your repository without slowing your team down
description: The .env file is a default, not a discipline problem. Why copies escape .gitignore, the four ways it actually goes wrong, and a migration you can do today.
keywords: [.env file, secrets in git, environment variables, gitignore env, remove env from git, dotenv alternative]
published: 2026-08-12
author: The xecret team
role: Playxoft
category: Practices
---

Nobody has ever sat down and decided that database passwords belong in a git
repository. That is not how it happens. It happens because `.env` is the
shortest distance between "this needs an API key" and "this runs on my
machine", and every tool in the ecosystem has spent a decade making that
distance shorter.

## The file is a default, not a failure of discipline

Treating leaked `.env` files as a training problem is the reason the problem
never goes away. The people involved already know secrets should not be in
version control. They put the value in a file anyway, because the file is what
the framework reads, the file is what the README tells a new hire to create,
and the file is what a working application requires in the next four minutes.

Look at what the alternative asks for at the moment somebody needs the key. A
vault means a login, a CLI, a permission grant and a concept to learn. A file
means one line in an editor. Given a deadline, the file wins every time — and
it should, because at that moment the file genuinely is the better tool for
the job in front of them.

So the useful question is not "how do we make people stop", it is "what has to
be true for the safe path to be the shortest one". That is a design question,
and it has a real answer.

## Why the copies multiply faster than you can ignore them

The single most misunderstood thing about `.gitignore` is what it protects.
It protects *a path*. It does not protect a value, and it does not follow that
value anywhere else it goes.

A secret enters a codebase once and then spreads by ordinary, well-intentioned
work:

- A new engineer joins. Somebody pastes the block into a Slack DM, because the
  alternative is a twenty-minute call. Slack is now a secret store with search
  enabled and no expiry.
- Someone needs to test a migration against staging, so they copy `.env` to
  `.env.staging.bak` and edit two lines. `.gitignore` says `.env`. It does not
  say `.env.staging.bak`.
- The Dockerfile does `COPY . .` and the build context contains everything the
  `.dockerignore` did not name. The value is now a layer in a registry, and
  `docker history` will show it to anybody who can pull the image.
- Someone debugs a CI failure by adding a step that prints the environment.
  The build log is retained for ninety days and readable by every contributor.

None of these are careless. Each one is a reasonable act by a person solving
the problem in front of them. The file is the thing that made all four
possible.

| A copy that lives… | Covered by `.gitignore`? | Readable by |
|---|---|---|
| `.env` in the repository root | Usually, yes | Anyone with that laptop |
| `.env.backup`, `.env~`, `.env.save` | No — `.env` alone matches none of them | Anyone with that laptop |
| A Slack message from onboarding | Not a file, so no | Everyone in the workspace, via search, indefinitely |
| The Docker build context | Irrelevant — `.dockerignore` decides | Anyone who can pull the image |
| A CI job that echoed the environment | Irrelevant | Anyone who can read a build log |
| A former colleague's disk image | No | Them |

### The patterns almost every repository misses

Here is a `.gitignore` block that covers the shapes people actually create,
rather than only the one the framework documents:

```bash
# Every dotenv variant, including the ones nobody plans to make
.env
.env.*
*.env

# Editor and shell leftovers that .env.* does not match
.env~
.env.swp
.envrc

# Re-admit the files that are supposed to be committed
!.env.example
!.env.*.example

# Credentials that are not called .env at all
*.pem
*.p12
*.pfx
service-account*.json
gha-creds-*.json
```

Two things about that block. First, `.env` on its own matches nothing else —
not `.env.local`, not `.env.production`, not `.env.backup`. If your ignore file
has one line, it is covering one file. Second, the negations have to come
after the broad patterns, and they cannot re-admit a file whose parent
directory is ignored. If you keep secrets under `config/`, ignoring `config/`
means `!config/example.env` will not work.

> **Warning** — `.gitignore` has no effect on a file git is already tracking.
> If `.env` was committed before the pattern was added, git keeps happily
> committing every change to it, silently, forever. The pattern only governs
> untracked files.

## Getting the file out, without breaking anybody's afternoon

Start by finding out what is actually tracked, rather than what you believe is
tracked:

```bash
# Every tracked file that looks like an env file, anywhere in the tree
git ls-files | grep -E '(^|/)\.env($|\.)|\.env$|\.pem$'

# Is one specific file tracked? Exit code 0 means yes.
git ls-files --error-unmatch .env

# Env files that were tracked at some point and later deleted —
# still in history, still readable
git log --all --diff-filter=D --name-only -- '.env*' | sort -u
```

If something comes back, untrack it without deleting your working copy:

```bash
git rm --cached .env .env.local
printf '\n.env\n.env.*\n*.env\n!.env.example\n' >> .gitignore
git add .gitignore
git commit -m "chore: stop tracking env files"
```

`--cached` is the important flag. It removes the file from the index while
leaving it on disk, so your colleague who pulls this commit does not lose their
working configuration — they simply stop sharing it.

Be clear with yourself about what that commit achieved. It stops *future*
commits from carrying the file. Every value that was ever committed is still in
the repository's history, still fetchable by anyone with a clone, and — this is
the part people miss — still live at the provider. Removing a key from a file
does not revoke it. If anything came back from that `--diff-filter=D` search,
you have a rotation job on your hands, and we wrote a separate runbook for
exactly that: [finding a leaked API key in git history](/blog/find-leaked-api-keys-in-git-history).

## Replacing the file rather than banning it

Deleting the file only works if something takes over its job on the same day.
The job is narrow and specific: put a set of key-value pairs into a process's
environment before that process starts. Anything that does that job can replace
the file without a single line of application code changing, because your code
is reading `process.env`, not reading a file.

That is the whole design of the xecret CLI. You store the values once, and the
CLI injects them into whatever you run:

```bash
xecret login                     # browser approval; the credential goes to your OS keychain
xecret init                      # writes .xecret.yaml — a project slug and an environment slug
xecret run -- npm run dev        # your command, with the environment already populated
```

`.xecret.yaml` contains two slugs and no secrets, so you commit it. That single
committed file is what makes the safe path the short path: a new engineer
clones, runs `xecret run -- npm run dev`, and is working. Nobody pastes
anything into Slack, because there is nothing to paste. The full sequence,
including CI, is in the [quickstart](/docs/quickstart), and every flag is in the
[CLI command reference](/docs/cli/commands).

Migrating what you already have does not require retyping it. Drag the existing
`.env` into the import dialog in the dashboard; it is parsed in your browser and
shows you a dry-run of what would be created before anything is sent. A pasted
blob of production credentials never becomes a request body.

> **Tip** — Do the migration one environment at a time and leave the `.env`
> file on disk until the new path has survived a full working day. A migration
> that can be abandoned at 16:00 on a Tuesday is one people will actually
> start.

### The order that keeps the team moving

1. **Development first.** Lowest stakes, and it is where everyone will notice
   whether the new flow is faster or slower than the old one.
2. **CI second**, with a service token scoped to one project and one
   environment. This is where the biggest sprawl usually lives, because CI
   configuration accumulates copies nobody audits.
3. **Production last**, and only after the first two have been boring for a
   week.
4. **Then rotate.** Every value that lived in a file that was shared around is
   a value whose custody you cannot account for. Migrating it moves it; only
   rotation makes the old copies worthless.

Framework-specific notes matter mostly for build-time variables — a
`NEXT_PUBLIC_` value has to exist during `next build`, not during
`next start` — and that is covered in the
[Next.js guide](/docs/guides/nextjs).

## What this does and does not fix

Getting secrets out of files buys you three concrete things: one place a value
is edited, a record of who read what, and revocation that actually takes effect
because there is no file on a laptop that keeps working after you revoke.

It does not make the values unreadable by us. xecret uses server-side envelope
encryption, which means the service can technically decrypt your secrets. That
is the same model Doppler uses, and it is what makes team sharing, CI tokens
and browser-side import work without a key exchange ceremony. If your threat
model requires a provider that cannot read your data even in principle, you
want a zero-knowledge product, and we would rather you knew that before
migrating than after — the whole model is written out in the
[trust model](/docs/security/trust-model).

It also does not stop your own code from leaking. If your application logs
`process.env` or a crash reporter ships it, nothing upstream can help.

## Where xecret fits

This is the product pitch, kept in its own section so you can skip it. xecret
is open-source secret management built around one command: you store
environment variables once, per environment, and `xecret run` injects them into
whatever you were going to run anyway — locally, in CI, in production. The
server is AGPL-3.0 and self-hosting holds nothing back; the CLI is MIT. It is
pre-alpha, which we say plainly, and while it is, every paid feature is on for
everybody with no card collected — the [pricing page](/pricing) sets out what
changes at 1.0. If it turns out not to be for you, the `.gitignore` block
above is still worth ten minutes of your afternoon.
