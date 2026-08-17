---
title: CLI command reference
navTitle: Command reference
description: Every xecret command and flag — login, init, projects, secrets, versions, import, pull, export, run, audit, tokens and cache — with examples and the exact behaviour of each.
keywords: [xecret command reference, xecret run flags, xecret secrets set, xecret secrets versions, xecret audit, xecret import, xecret pull, cli reference]
updated: 2026-08-18
---

Every command the `xecret` binary accepts. Run `xecret help` for the same list
in your terminal, or `xecret <command> --help` for one command's flags.

Two flags recur on every command that reads secrets:

```text
--project SLUG        override .xecret.yaml
--environment SLUG    override .xecret.yaml
```

## Authentication

### `xecret login`

```bash
xecret login [--api-url URL] [--name DEVICE]
```

Authenticates this machine through your browser.

The CLI opens a consent page, listens on `127.0.0.1` on a random port for the
one-time code that page redirects back, and exchanges that code — together with
a PKCE verifier only this process knows — for a credential it stores in your OS
keychain. It never talks to Firebase directly; the consent screen and the token
exchange are both xecret's own.

| Flag | Effect |
|---|---|
| `--api-url URL` | Which deployment to sign in to. Stored with the credential, so you pass it once. |
| `--name DEVICE` | The device name shown on the consent screen and in the dashboard. Defaults to your hostname. |

```bash
xecret login --name "work laptop"
xecret login --api-url https://secrets.your-company.com
```

The device name is what you will look for later when revoking access from
*Tokens → Your devices*, so make it something you will recognise.

### `xecret logout`

```bash
xecret logout
```

Revokes this device's credential **server-side**, clears the keychain entry,
and wipes the encrypted offline cache. Refused while `XECRET_TOKEN` is set: a
service token was not minted by this machine and is not this machine's to sign
out. Revoke one with [`xecret tokens revoke`](#xecret-tokens) or in the
dashboard.

### `xecret whoami`

```bash
xecret whoami [--json]
```

Asks the server who you are, rather than reading the stored credential. That
distinction matters: a credential revoked from the dashboard reads as signed
out here, instead of confidently reporting a stale identity.

```text
Signed in as   ada@example.com
Organisation   acme
This device    work laptop
Server         https://xecret.playxoft.com
```

Under `XECRET_TOKEN` it answers with the token's pinned scope instead of a
person:

```text
Credential     service token "ci-build" (read)
Organisation   acme
Project        checkout-api
Environment    production
Server         https://xecret.playxoft.com
```

### `xecret orgs`

```bash
xecret orgs [list] [--json]
xecret orgs use SLUG
```

Your credential works in every organisation you are a member of. `use` chooses
which one the other commands address:

```text
SLUG      NAME          ROLE
acme      Acme Ltd      owner     current
side      Side Project  developer
```

`use` is a local change — one field stored beside the token. It makes no network
call beyond checking that you are actually a member, revokes nothing, and
switching back is another `use`. Refused under `XECRET_TOKEN`, which is pinned
to one organisation server-side.

## Project setup

### `xecret init`

```bash
xecret init [--project SLUG] [--environment SLUG] [--force]
```

Interactive picker that writes `.xecret.yaml` in the current directory — two
slugs, never secrets, safe to commit.

| Flag | Effect |
|---|---|
| `--project SLUG` | Skip the project prompt |
| `--environment SLUG` | Skip the environment prompt |
| `--force` | Overwrite an existing `.xecret.yaml` |

```bash
xecret init                                        # prompts for both
xecret init --project checkout-api --environment development
```

Refused under `XECRET_TOKEN`: a CI job needs no config file, because the
token's own scope already answers the question.

### `xecret projects`

```bash
xecret projects [list] [--json]
xecret projects create NAME [--slug SLUG] [--description TEXT]
xecret projects delete SLUG [--yes]
```

Lists the projects you can see in your organisation, and creates or removes one.

Creating a project also creates its default environments — development, staging
and production — each with its own encryption key, in a single transaction. A
project with no environments has nowhere to put a secret, and an environment
without a key cannot be repaired from inside the product, so neither half is
ever created alone.

```bash
xecret projects create "Checkout API" --slug checkout-api
```

The slug is permanent: it appears in every URL, in `.xecret.yaml` and in the CI
configuration of everyone who consumes the project, so renaming it would break
every consumer that is not redeployed at the same instant. Pass `--slug` if you
do not want one derived from the name.

Deleting is soft, and asks you to type the slug back unless you pass `--yes`.

### `xecret environments`

```bash
xecret environments [list] [--project SLUG] [--json]
xecret environments create NAME [--slug SLUG] [--production] [--project SLUG]
xecret environments delete SLUG [--yes] [--project SLUG]
```

Lists, creates and removes the environments of one project. Without
`--project`, uses `.xecret.yaml`.

```bash
# a throwaway environment for one pull request
xecret environments create "PR 412" --slug pr-412
xecret import .env.example --environment pr-412 --strategy overwrite
xecret environments delete pr-412 --yes
```

`--production` marks the environment as production at creation, which narrows
who can read it and makes deleting it ask for the slug. *Flipping* the flag
later is an admin-level change and lives in the dashboard: reclassifying an
environment that already holds production secrets is a different act from
labelling an empty one.

## Secrets

### `xecret secrets list`

```bash
xecret secrets list [--project P] [--environment E] [--json]
```

Names, value types, current version numbers, when each was last updated and by
whom. **No values** — this endpoint never decrypts anything.

### `xecret secrets get`

```bash
xecret secrets get NAME [--version N] [--plain] [--json]
```

Masked by default:

```text
Name      DATABASE_URL
Type      url
Version   v4
Updated   2026-08-14 09:12
Note      primary read-write connection
```

`--plain` prints the decrypted value to stdout and nothing else, so it composes:

```bash
psql "$(xecret secrets get DATABASE_URL --plain)"
```

Every `--plain` read is audited server-side as `secret.revealed`. An audit row
therefore always means a plaintext actually left the server — which is what
makes the log worth reading during an incident.

`--version N` reveals one earlier value instead of the current one, and requires
`--plain`, because the value is the only thing it adds over
[`secrets versions`](#xecret-secrets-versions):

```bash
xecret secrets get STRIPE_SECRET_KEY --version 3 --plain
```

A warning goes to stderr when the version is not the current one. It is worth
reading: a rotated secret is usually still live at whoever issued it, so an old
value is a working credential, not an archive entry.

### `xecret secrets set`

```bash
xecret secrets set NAME [--type TYPE] [--note TEXT] [--from-file PATH] [--generate[=BYTES]]
```

Reads the value from stdin, or prompts for it with the input hidden. **Never
from a command-line argument**, where it would land in your shell history and
in `ps` output for every user on the machine.

```bash
# interactive — the prompt hides your typing
xecret secrets set STRIPE_SECRET_KEY

# from a pipe, for scripts
openssl rand -hex 32 | xecret secrets set SESSION_SECRET

# from a file, byte for byte
xecret secrets set GOOGLE_SERVICE_ACCOUNT --from-file key.json

# have one generated — 32 bytes of entropy, never printed
xecret secrets set SESSION_SECRET --generate

# declare a type and a note
xecret secrets set PORT --type int --note "the container listens here"
```

| Flag | Effect |
|---|---|
| `--type TYPE` | Declares the value's shape: `string` `boolean` `int` `decimal` `email` `url` `date` `datetime` `json` `yaml` `xml` `ulid` `uuidv4` `uuidv7`. Future writes that do not match are refused by the server. |
| `--note TEXT` | A note shown beside the secret in the dashboard. |
| `--from-file PATH` | Take the file's bytes as the value, verbatim — trailing newline included. A pipe's final newline is the shell's framing and is stripped; a file's is part of the file, and a PEM key ends in one. Limited to 64 KB, the server's ceiling on one secret. |
| `--generate[=BYTES]` | Mint a random value with the OS entropy source and write it without ever printing it. 32 bytes by default, rendered as 43 url-safe characters. Use `--generate=48` — with the `=` — to choose a length. |

Writing the same value again is a no-op rather than a new version.

### `xecret secrets annotate`

```bash
xecret secrets annotate NAME [--note TEXT] [--type TYPE] [--rename NEW]
```

Changes what is *said about* a secret without touching what it holds, and
**appends no version**. Declaring `PORT` an integer is not a rotation, and
neither is a rename, so neither may bump the number that answers "when did this
credential last actually change?".

```bash
xecret secrets annotate PORT --type int
xecret secrets annotate DATABASE_URL --note "primary read-write connection"
xecret secrets annotate DATABASE_URL --note ""        # clears the note
xecret secrets annotate API_KEY --rename STRIPE_API_KEY
```

The version history follows the secret through a rename. Everything that reads
the old name stops finding it at once, so update your code and CI in the same
change.

### `xecret secrets versions`

```bash
xecret secrets versions NAME [--json]
```

The history of one secret — **metadata only**.

```text
VERSION           WRITTEN           BY
v4       current  2026-08-17 09:12  user
v3                2026-06-02 14:40  service token
v2                2026-04-11 08:03  user
```

No values, and that is the point rather than a limitation. A rotated secret
usually keeps working at the provider that issued it until somebody disables it
there, so a listing that returned values would hand out a page of live
credentials under an interface people reason about as an archive. Reading the
past is one version at a time, through `secrets get --version N --plain` or
`secrets restore` — and each of those is audited.

### `xecret secrets restore`

```bash
xecret secrets restore NAME --version N
```

Re-appends an earlier value as the new current version.

```bash
xecret secrets versions DATABASE_URL
xecret secrets restore DATABASE_URL --version 3
```

```text
✓ Restored DATABASE_URL from v3 as v5 in checkout-api/production.
History was not rewritten — v3 is still there.
```

The old row stays exactly where it is: the history stays able to say "this value
was current between Tuesday and Friday, then again from Monday". The value is
decrypted and re-encrypted rather than copied, because the encryption is bound
to the version number — bytes produced for v3 and stored as v5 would fail to
decrypt for the rest of their life.

### `xecret secrets delete`

```bash
xecret secrets delete NAME [--yes]
```

Soft-deletes a secret. Without `--yes` you are asked to type the secret's name
to confirm — a `y/n` prompt is too easy to answer by reflex for something that
takes a value out of a running system.

Always refused for service tokens: CI rotates a value by writing a new one, and
destroying history is a human's decision.

## Moving secrets in bulk

### `xecret import`

```bash
xecret import FILE [--format dotenv|json|yaml|shell] [--strategy skip|overwrite|rename] [--dry-run] [--json]
```

Sends a file of secrets to one environment. The format is auto-detected;
`--format` overrides that when detection guesses wrong.

| `--strategy` | On a name that already exists |
|---|---|
| `skip` *(default)* | Leave the existing value alone |
| `overwrite` | Append a new version with the imported value |
| `rename` | Import under a suffixed name, keeping both |

```bash
xecret import .env --dry-run          # see the plan, write nothing
xecret import .env --strategy overwrite
```

`--dry-run` prints the exact plan the real import would execute, produced by
the same planning code the real import runs — so the preview cannot disagree
with the outcome. Always dry-run first against production.

Files are limited to 1 MB.

### `xecret pull`

```bash
xecret pull [--format env|json|yaml|shell|docker] [-o FILE]
```

Prints every current secret in the chosen format.

```bash
xecret pull --format json | jq 'keys'
xecret pull -o .env.production          # creates the file 0600
```

> **Warning** — `pull` writes plaintext secrets somewhere they persist. That is
> a downgrade from `xecret run`, and the command says so on stderr every time.
> `-o` at least creates the file with `0600` permissions. Use it for legacy
> pipelines that cannot be changed, and use `run` everywhere else.

### `xecret export`

```bash
xecret export [--format env|json|yaml|shell|docker] [-o FILE] [--force]
```

The same data as `pull`, written to a file. Without `-o` the name is derived
from the format — `.env`, `secrets.json`, `secrets.yaml`, `secrets.sh`,
`docker.env` — and an existing file is never overwritten without `--force`.

The file is mode `0600` whether it was created or overwritten. A `--force` over
a `.env` that some earlier `xecret pull > .env` left at `0644` narrows it before
anything is written to it, rather than filling a world-readable file.

```bash
xecret export                          # → .env, mode 0600
xecret export --format json -o config/secrets.json
```

It is a separate command from `pull` rather than a flag on it because the two
are separate endpoints: the request path is what distinguishes "a build read
its configuration" from "somebody took a copy" in the audit log. Both are
recorded as `secret.read` with a count.

> **Warning** — Exporting is a deliberate downgrade in security posture, and the
> command exists anyway. The file is not encrypted, it outlives the session that
> produced it, backup and sync tools will copy it, and no access grant can be
> revoked after the fact, because the copy is no longer ours. It exists because
> the alternative is worse: a team that cannot export pastes values into chat
> one at a time, which is less safe and completely unaudited. Add the file to
> `.gitignore` and delete it when you are done.

## The golden path {#run}

### `xecret run`

```bash
xecret run [--project P] [--environment E] [--offline] [--no-cache] -- COMMAND [ARGS…]
```

Fetches the environment, injects it into the child process, forwards signals,
and exits with the child's exit code. Secrets never touch disk, argv or stdout.

```bash
xecret run -- npm run dev
xecret run --environment staging -- ./deploy.sh
xecret run -- go test ./...
```

Everything after `--` is your command. The `--` is required: without it the CLI
cannot tell your flags from its own.

| Flag | Effect |
|---|---|
| `--offline` | Use the encrypted cache without calling the API. Refused under `XECRET_TOKEN`, which never writes a cache. |
| `--no-cache` | Neither read nor refresh the cache. |

The API is authoritative; the cache answers only when the API *cannot* — a
network failure or a 5xx. A 401, 403 or 404 is a *decision* (a revocation,
above all), and decisions are never softened by a local file. Full behaviour:
[the offline cache](offline-cache.md).

## Administration

### `xecret audit`

```bash
xecret audit [--action ACTION] [--project P] [--environment E] [--outcome success|denied|error]
             [--since 24h|7d|TIMESTAMP] [--until 1h|7d|TIMESTAMP] [--limit N] [--json]
```

Reads the organisation's audit log — who did what, when, and whether it worked.

`--since` and `--until` take the same spellings: a duration counting back from
now (`24h`, `7d`), or an RFC 3339 timestamp, normalised to UTC before it is
sent. A window that cannot contain anything — a negative duration, a `--since`
after `--until`, a `--since` in the future — is refused here rather than sent.
The server collapses a backwards range to a single instant, so each of those
would otherwise come back as "No matching events", which reads exactly like
"nothing happened".

```bash
xecret audit --action secret.revealed --since 7d
xecret audit --outcome denied --limit 100 --json | jq '.events[].actorLabel'
```

```text
WHEN              ACTION           OUTCOME  ACTOR             SUBJECT
2026-08-17 11:00  secret.revealed  success  ada@example.com   checkout-api/production/API_KEY
2026-08-17 10:30  secret.read      success  ci-build          checkout-api/production
```

Owners and admins hold `audit.read`; developers deliberately do not, because the
log spans projects a developer cannot see and records every denial anyone ever
received. A 403 here is the policy working.

The window actually scanned is printed after the table. The server clamps any
range to ninety days, and a query for "the last year" that quietly answered for
three months would be worse than useless during an incident. `--limit` is
honoured exactly, and the command says so when more events matched than it read.

`--since` takes a duration (`24h`, `7d`) or an RFC 3339 timestamp.

### `xecret members`

```bash
xecret members [--json]
```

Who is in the organisation, their roles, and the seat count. Read-only:
inviting, suspending and changing a role require a browser session server-side,
so there is nothing here that could do them.

### `xecret tokens`

```bash
xecret tokens list [--kind cli|service] [--json]
xecret tokens revoke ID --kind cli|service [--yes]
```

The credentials that can reach your organisation.

- **`cli`** tokens are devices — what `xecret login` writes. The listing shows
  your own devices only, revoked ones included, because a CLI token acts as its
  user and confers nothing of its own. Your own device: always revocable.
  Someone else's: needs the revoke permission.
- **`service`** tokens are the CI credentials behind `XECRET_TOKEN`. They belong
  to the organisation rather than to a person, so revoking one takes the same
  authority that could have minted it.

```bash
xecret tokens list --kind service
xecret tokens revoke 7f3c… --kind service --yes
```

Revocation is immediate: the next request carrying that token fails
authentication. It is idempotent, so revoking a dead token succeeds without
writing a second audit record.

**Creating** a service token is deliberately not a CLI command. The server
requires a browser session for it — a token that could mint another token would
turn one leaked credential into a permanent foothold, so the chain has to start
with a person. Create them in the dashboard under *Settings → Tokens*.

## Housekeeping

### `xecret cache clear`

```bash
xecret cache clear
```

Removes every cached environment from this machine. `xecret logout` does this
for you.

### `xecret completion`

```bash
xecret completion bash | zsh | fish
```

Prints a completion script for commands, subcommands and the common flags.

```bash
# bash — this session, or append to ~/.bashrc
source <(xecret completion bash)

# zsh — needs a directory on $fpath
xecret completion zsh > "${fpath[1]}/_xecret"

# fish
xecret completion fish > ~/.config/fish/completions/xecret.fish
```

Secret names are deliberately not completed: that would mean an API call — and a
listing request against a server that rate-limits and audits — on every press of
the Tab key.

### `xecret doctor`

```bash
xecret doctor [--json]
```

Checks this machine's setup and says what is wrong: which credential store is in
use, whether you are signed in, which deployment the commands resolve to and
*why*, whether the server is reachable, whether the credential is still
accepted, which `.xecret.yaml` applies, and what is in the offline cache.

```text
     xecret 1.2.0 (commit a1b2c3d, built 2026-08-17, darwin/arm64, go1.25.5)
✓    credential store: OS keychain
✓    signed in as ada@example.com, organisation acme
     server: https://xecret.playxoft.com (stored with the credential at login)
✓    server reachable — xecret 0.1.0 (commit a1b2c3d)
✓    credential accepted by https://xecret.playxoft.com
✓    /work/checkout/.xecret.yaml → checkout-api/development
✓    offline cache: 2 environment(s) in ~/.xecret/cache
```

It prints no credential. The keyring check writes and deletes a probe value of
its own rather than reading yours. Paste the output into a bug report.

`doctor` exits non-zero when a check fails, so `xecret doctor || exit 1` works
as a start-up guard in a container. Warnings — no `.xecret.yaml` in this
directory, an unreadable cache — are not failures. With `--json` every verdict
comes back in a `checks` array of `{name, status, ok, detail}`, alongside a
top-level `ok`:

```bash
xecret doctor --json | jq -r '.checks[] | select(.ok | not) | .detail'
```

### `xecret upgrade`

```bash
xecret upgrade [--json]
```

Asks GitHub whether a newer release has been published, and prints the command
to install it.

Nothing checks in the background. A version check is a request describing which
machine runs which build of a secret-management client, and making it a side
effect of `xecret run` would ship that from inside every CI job. It happens when
you ask.

It also does not replace the binary. Every published archive is checksummed and
signed, and the installer verifies the checksum before unpacking; a secret
manager that silently overwrites its own executable is exactly the supply-chain
shape nobody should accept.

### `xecret version`

```bash
xecret version
```

Version, commit, build date, platform and Go version. Include this in any bug
report.

### `xecret help`

```bash
xecret help
xecret secrets help
```

## Quick reference

```bash
# first time in a repository
xecret login
xecret init

# daily
xecret run -- npm run dev

# look at things
xecret projects
xecret environments
xecret secrets list
xecret secrets versions API_KEY

# change things
xecret secrets set API_KEY
xecret secrets get API_KEY
xecret secrets annotate API_KEY --note "issued by Stripe"
xecret import .env --dry-run

# when something went wrong
xecret secrets restore API_KEY --version 3
xecret audit --action secret.revealed --since 24h
xecret doctor

# in CI (no login, no config file)
XECRET_TOKEN=xst_… xecret run -- npm run build
```

## Next

- [Configuration and scope](configuration.md) — where each setting comes from.
- [The offline cache](offline-cache.md) — behaviour when the network fails.
- [Secrets in CI](../guides/ci.md) — service tokens end to end.
