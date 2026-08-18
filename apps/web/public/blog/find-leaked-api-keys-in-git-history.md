---
title: There is an API key in your git history. Here is how to find it, and what to do in the ninety minutes after you do.
description: A key deleted in a later commit is still live and still readable. How to find secrets in git history, plus the rotate-first runbook that keeps production up.
keywords: [leaked API key, git history secrets, secret scanning, gitleaks, trufflehog, rotate credentials, incident runbook]
published: 2026-07-29
author: The xecret team
role: Playxoft
category: Security
---

The commit that deleted the key is the one that makes people relax. It should
not. Git is a content-addressed store with an append-only habit: the commit
that removed the file added a new snapshot in which the file is absent, and
left the snapshot in which it is present exactly where it was. Anyone with a
clone can read it, and no amount of removal at the top of the branch changes
that.

More importantly, none of this has anything to do with whether the credential
still works. A string in a repository is a copy. The original lives at your
cloud provider, your payment processor, your database — and it is still
accepting requests.

## What a key in history actually means

Three properties, and each one changes what you should do first.

**It is live.** Removal is not revocation. The only thing that stops a leaked
key being usable is the provider marking it invalid.

**It has already been copied more times than you can enumerate.** Every clone
on every laptop, every CI runner cache, every fork, every mirror, every backup
of the git host. If the repository was ever public, assume scrapers found it
within minutes: cloning public repositories and grepping them is cheap and
thoroughly automated, by researchers and attackers alike.

**Git cannot tell you whether it was used.** Git records that the value
existed. Only the provider's own audit or usage log records whether somebody
authenticated with it. That distinction drives the runbook below.

## Finding it: three passes, cheapest first

### Pass 1 — what is tracked right now

Before history, check the present. This takes five seconds and finds the
majority of real cases:

```bash
# Files that look like credentials and are currently tracked
git ls-files | grep -E '(^|/)\.env($|\.)|\.pem$|\.p12$|service-account.*\.json$'

# Env files that were tracked once and later deleted — the classic case
git log --all --diff-filter=D --name-only -- '.env*' '*.pem' | sort -u
```

### Pass 2 — git's own history search

`git log -S` is the pickaxe: it finds commits where the *number of occurrences*
of a string changed, which means it finds the commit that introduced a value
and the commit that removed it, without walking every blob by hand.

```bash
# Every commit on every ref that added or removed this string
git log -S 'sk_live_' --oneline --all

# The same, as a regular expression, showing the diff that matched
git log -G 'AKIA[0-9A-Z]{16}' -p --all

# Which files ever contained it, across every reachable commit
git rev-list --all | xargs -n 40 git grep -I -n -E 'AKIA[0-9A-Z]{16}' -- | head
```

That last one is the blunt instrument: it greps the tree of every commit
reachable from any ref. Slow on a large repository, and blind to unreachable
blobs — a commit that was rebased away, for instance — but it answers "where
has this string ever lived" more completely than `-S` does.

Search for the shapes credentials have, not for the word `secret`. Provider
prefixes are the highest-signal thing you have: `sk_live_`, `AKIA`, `ghp_`,
`xoxb-`, `AIza`, `-----BEGIN` for private keys, and `postgres://` or
`mongodb+srv://` for connection strings carrying their own password.

### Pass 3 — the scanners

Two open-source tools do this properly, and they are what most teams reach for:

- **gitleaks** — a Go binary with a large rule set of provider-specific
  patterns, designed to run over a repository's whole history and also as a
  pre-commit hook.
- **trufflehog** — scans history similarly, and its distinguishing feature is
  *verification*: for many providers it will call the provider's API with the
  candidate credential to see whether it is still live, which turns a list of
  four hundred maybes into a list of three definites.

```bash
# Whole history, redacted output so the findings are not themselves a leak
gitleaks detect --source . --redact

# Only findings the tool could confirm are still active
trufflehog git file://. --only-verified
```

> **Note** — Both projects have reorganised their subcommands between major
> versions. Run `gitleaks --help` and `trufflehog --help` on the version you
> actually installed rather than trusting a command copied from a blog post,
> including this one.

Verification is the feature worth caring about. A history scan of an old
repository routinely produces hundreds of hits, most of them test fixtures,
example values and long-rotated keys. A list you cannot triage is a list
nobody triages.

## Why rewriting history is step four, not step one

The instinct on finding a key is to make it disappear. Resist it for an hour,
because rewriting history is slow, disruptive, and buys you almost nothing
while the key is still valid.

- It revokes nothing. An attacker who cloned the repository last Tuesday is
  unaffected by what you do to your copy today.
- It rewrites every commit hash from the offending commit onwards, breaking
  every open branch, every pull request and every clone your colleagues have.
  Doing that mid-incident costs you the people you need.
- On most hosts an unreferenced commit stays fetchable by its SHA until the
  host garbage-collects it, and pull request refs can keep it reachable
  indefinitely. Purging it properly means contacting support. That is a
  ticket, not a command.

Rewriting history is worth doing. It is worth doing fourth.

## The runbook

| Minutes | Do this | Because |
|---|---|---|
| 0–10 | Rotate the credential at the provider | It is the only step that makes the leaked string worthless |
| 10–30 | Read the provider's audit or usage log | It is the only source that says whether it was used |
| 30–60 | Contain: revoke sessions, check for resources created, narrow scopes | Limits what an attacker who already got in can keep |
| 60–90 | Rewrite history, force-push, tell the team to re-clone | Stops the next scan finding the same thing |
| Afterwards | Add a pre-commit hook and a CI scan; move the value out of files | Prevention is the only step that scales |

### Rotation order for a key that is live in production

This is where teams either take an unnecessary outage or leave a live key in
the wild for three days. The order depends on one judgement, made deliberately.

**If the provider supports two active credentials** — AWS access keys, Stripe
restricted keys, most OAuth applications, most database users — there is no
reason to take downtime:

1. Mint the new credential. Do not touch the old one yet.
2. Deploy the new value everywhere it is used: production, staging, CI, any
   scheduled job, any container image built with it baked in. Missing one is
   how the cutover becomes an outage.
3. Confirm at the provider that the *old* credential's usage has dropped to
   zero. Most providers show a "last used" timestamp. Wait for it to go stale.
4. Revoke the old credential.
5. Watch for failures for an hour. The forgotten consumer always turns up at
   this step, and now it fails against a revoked key rather than against
   nothing.

**If the provider allows only one active credential, or the blast radius is
severe** — root or admin cloud credentials, a signing key, a database
superuser, anything that can create more credentials — invert it. Revoke
first and take the outage. The rule of thumb is simple: revoke first whenever
the cost of ten more minutes of an attacker's access exceeds the cost of ten
minutes of downtime. For a read-only analytics key, rotate gracefully. For
something that can spend money or grant itself more access, pull the plug.

Either way, rotate at the source and then write the new value into wherever
your team reads configuration from. A new value that only exists in one
engineer's terminal is not a rotation.

### Assessing blast radius honestly

The provider's log is the evidence. Everything else is inference.

Look for authentications from addresses or regions you do not recognise, calls
to endpoints your application never calls, and the two things that indicate an
attacker settling in rather than passing through: **new credentials created**,
and **permissions changed**. A leaked key used once to list buckets is a very
different morning from a leaked key that created an IAM user.

If the repository was public, check whether your host recorded clones or forks
in the relevant window. If it was private, its audit log tells you who had
access — a much smaller and much more answerable question.

> **Important** — Write down what you found while you are finding it. Provider
> audit logs have retention limits, and the window you need is always the one
> that just expired. Export the relevant range before you close the tab.

## What an audit log would have told you

Here is the honest version of the tie-in, because the limits matter as much as
the capability.

For a credential sitting in git, nothing we build can tell you who read it.
That value's custody chain ran through clones and laptops, and it left no
trace anywhere. The best you get is your git host's access log, which tells
you who *could* have read it.

For a credential held in a secret manager, the question has an actual answer.
Every decryption in xecret writes an append-only audit record naming the
actor — a person, a CLI token or a CI service token — the environment, and
the time. So step two of the runbook stops being archaeology: you filter the
log by that secret, and you have the list of everyone who ever retrieved it
and when. Denials are recorded too, because a system that logs only successes
cannot show you an attack in progress.

That does not prevent the leak. Somebody who can read a secret can still paste
it somewhere careless. What changes is that the blast-radius question becomes
a filter rather than a guess, and revocation becomes real — there is no file
on a former colleague's disk that keeps working after you revoke their device.

## Preventing the next one

Three things, in increasing order of how much they actually help:

1. **A pre-commit hook**, catching the value before it exists in a commit.
   Cheap, and it fails open — anyone can pass `--no-verify`.
2. **A CI scan on every pull request**, so a bypassed hook is visible to
   somebody other than the person who bypassed it.
3. **Not having the value in a file at all.** A scanner is a smoke detector:
   worth installing, and not a fire-suppression system.

The third is the structural fix, and it is the one that removes the class of
incident rather than shortening it. If you want the practical version of that
migration, we wrote it up separately in
[stop committing .env files](/blog/stop-committing-env-files).

## Where xecret fits

Kept to one paragraph. xecret is open-source secret management: values are
stored per environment and injected by `xecret run -- your-command`, so there
is no file to commit and every read is audited — see
[the quickstart](/docs/quickstart) and the
[CLI reference](/docs/cli/commands). It is not zero-knowledge: xecret uses
server-side envelope encryption, so the service can technically decrypt your
values, and we would rather you read the
[trust model](/docs/security/trust-model) now than discover the model later.
It is pre-alpha, everything is currently on for everyone with no card
collected, and [the feature set](/features) is public before you decide.
