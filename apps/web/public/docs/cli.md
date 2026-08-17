---
title: The xecret CLI
navTitle: Overview
description: What the command-line tool does, the two rules it never breaks, how output is split between stdout and stderr, and where to find each command.
keywords: [xecret cli, command line secret manager, xecret run, cli conventions, exit codes]
updated: 2026-08-16
---

The `xecret` binary is how secrets reach your programs. One command does the
important thing:

```bash
xecret run -- npm run dev
```

Everything else exists to support it.

## Two rules that govern everything

Both are structural, not aspirational — they are properties of how the binary
is written, and the rest of this documentation depends on them being true.

1. **A secret value is never written** to stdout, stderr, a log file, a
   temporary file, or a process argument. The exceptions are `xecret pull`,
   `xecret export` and `xecret secrets get [--version N] --plain`, whose entire
   purpose is producing a value, and which write it to stdout raw — or, for
   `export`, to one named file created `0600` — and nowhere else.

2. **Credentials live in the OS keychain**, never in a dotfile you might commit
   or sync — macOS Keychain, Windows Credential Manager, Secret Service on
   Linux. Where no keyring exists, a `0600` file under `~/.xecret/` is used and
   the CLI says so on stderr rather than doing it quietly.

## What the commands are for

| Group | Commands | Page |
|---|---|---|
| Signing in | `login` `logout` `whoami` `orgs` | [Commands](cli/commands.md#authentication) |
| Pointing at a project | `init` `projects` `environments` | [Commands](cli/commands.md#project-setup) |
| Working with secrets | `secrets list` `get` `set` `annotate` `versions` `restore` `delete` | [Commands](cli/commands.md#secrets) |
| Moving in bulk | `import` `pull` `export` | [Commands](cli/commands.md#moving-secrets-in-bulk) |
| **Running your app** | `run` | [Commands](cli/commands.md#run) |
| Administration | `audit` `members` `tokens` | [Commands](cli/commands.md#administration) |
| Housekeeping | `cache clear` `completion` `doctor` `upgrade` `version` `help` | [Commands](cli/commands.md#housekeeping) |

## How the CLI knows what you mean

Every command that touches a secret needs an *(organisation, project,
environment)* triple. It is resolved in this order:

1. `--project` and `--environment` flags
2. `.xecret.yaml`, found by walking up from the current directory
3. Under `XECRET_TOKEN`: the service token's own pinned scope
4. Otherwise: an error telling you to run `xecret init`

The organisation always comes from the credential — a login is pinned to one
organisation, a service token to one organisation, project *and* environment.
Naming a scope outside a service token's pin is refused by the **server**, not
merely by the client.

The full rules, plus the `.xecret.yaml` format and every environment variable:
[configuration and scope](cli/configuration.md).

## Output conventions

**stdout is results; stderr is commentary.** This is why

```bash
xecret projects --json | jq '.[].slug'
```

works: warnings, hints, prompts and progress never share the pipe with the
answer.

- `--json` on listing commands emits one machine-readable document.
- Colour is disabled when stdout is not a terminal, and by `NO_COLOR`.
- Prompts are written to stderr, so a piped command still prompts you visibly.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | The CLI itself failed — bad flags, no credential, a rejected request |
| *child's code* | `xecret run` exits with whatever your command exited with, untouched |

That last row is why `xecret run -- npm test` is safe to use in CI: a failing
test suite fails the job, exactly as it would without xecret in front of it.

## Errors tell you what to do next

An API failure carries a hint line:

```text
xecret: not signed in
        Run 'xecret login' to authenticate this device.
```

Under `XECRET_TOKEN` the hints change, because "run login" would be nonsense in
a CI job with no browser:

```text
xecret: request rejected (401)
        XECRET_TOKEN was not accepted. Check the value, its expiry, and any IP allowlist.
```

## Where next

- [Command reference](cli/commands.md) — every command, every flag.
- [Configuration and scope](cli/configuration.md) — `.xecret.yaml`, environment
  variables, where credentials are stored.
- [The offline cache](cli/offline-cache.md) — what happens when the network
  does not.
- [Troubleshooting](troubleshooting.md) — when something is not working.
