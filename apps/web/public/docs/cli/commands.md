---
title: CLI command reference
navTitle: Command reference
description: Every xecret command and flag — login, init, secrets, import, pull, run and cache — with examples and the exact behaviour of each.
keywords: [xecret command reference, xecret run flags, xecret secrets set, xecret import, xecret pull, cli reference]
updated: 2026-08-16
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
and wipes the encrypted offline cache. Refused while `XECRET_TOKEN` is set —
service tokens are revoked from the dashboard, not from the machine holding
them.

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
xecret projects [--json]
```

Lists the projects you can see in your organisation.

### `xecret environments`

```bash
xecret environments [--project SLUG] [--json]
```

Lists the environments of one project. Without `--project`, uses
`.xecret.yaml`.

## Secrets

### `xecret secrets list`

```bash
xecret secrets list [--project P] [--environment E] [--json]
```

Names, value types, current version numbers, when each was last updated and by
whom. **No values** — this endpoint never decrypts anything.

### `xecret secrets get`

```bash
xecret secrets get NAME [--plain] [--json]
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

### `xecret secrets set`

```bash
xecret secrets set NAME [--type TYPE] [--note TEXT]
```

Reads the value from stdin, or prompts for it with the input hidden. **Never
from a command-line argument**, where it would land in your shell history and
in `ps` output for every user on the machine.

```bash
# interactive — the prompt hides your typing
xecret secrets set STRIPE_SECRET_KEY

# from a pipe, for scripts
openssl rand -hex 32 | xecret secrets set SESSION_SECRET

# declare a type and a note
xecret secrets set PORT --type int --note "the container listens here"
```

| Flag | Effect |
|---|---|
| `--type TYPE` | Declares the value's shape: `string` `boolean` `int` `decimal` `email` `url` `date` `datetime` `json` `yaml` `xml` `ulid` `uuidv4` `uuidv7`. Future writes that do not match are refused by the server. |
| `--note TEXT` | A note shown beside the secret in the dashboard. |

Writing the same value again is a no-op rather than a new version.

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

## Housekeeping

### `xecret cache clear`

```bash
xecret cache clear
```

Removes every cached environment from this machine. `xecret logout` does this
for you.

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

# change things
xecret secrets set API_KEY
xecret secrets get API_KEY
xecret import .env --dry-run

# in CI (no login, no config file)
XECRET_TOKEN=xst_… xecret run -- npm run build
```

## Next

- [Configuration and scope](configuration.md) — where each setting comes from.
- [The offline cache](offline-cache.md) — behaviour when the network fails.
- [Secrets in CI](../guides/ci.md) — service tokens end to end.
