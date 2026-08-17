---
title: Troubleshooting
navTitle: Troubleshooting
description: Every error message the CLI and API produce, what it actually means, and the fix — from "command not found" to "no such environment" in CI.
keywords: [xecret error, command not found, not signed in, 401 xecret, no xecret.yaml, ci token not accepted, debugging]
updated: 2026-08-16
---

Find your message. If it is not here, `xecret version` and the `requestId` from
an API error are what a bug report needs.

## Installing and running the binary

### `xecret: command not found`

The install directory is not on your `PATH`. Reopen your terminal first — an
installer that just added a directory cannot change the shell it ran in.

```bash
export PATH="$HOME/.local/bin:$PATH"     # or /usr/local/bin
```

Add that line to `~/.zshrc` or `~/.bashrc` to make it stick.

### The install script fails on checksum verification

The download did not match the published checksum. Do **not** work around it.
Retry once — a truncated download is the usual cause. If it fails again, stop
and report it; that is exactly the failure the check exists to catch.

## Signing in

### `not signed in` / `Run 'xecret login'`

No credential on this machine, or it was revoked. Run `xecret login`.

If you *did* just log in, check you are pointed at the right deployment:

```bash
xecret whoami
```

`whoami` asks the server rather than reading the stored credential, so a
revoked device reads as signed out here rather than confidently reporting a
stale identity.

### The browser opens but nothing happens after approving

The CLI listens on `127.0.0.1` on a random port for the redirect. Something is
blocking it — usually a VPN with a local proxy, or a firewall rule on the
loopback interface.

The consent code is single-use with a 10-minute lifetime, so just run
`xecret login` again after adjusting; nothing is left half-authorised.

### `login` says the keyring is unavailable

No OS keyring on this machine — common on headless servers and minimal
containers. The CLI falls back to a `0600` file under `~/.xecret/` and tells
you so. To choose that explicitly:

```bash
export XECRET_KEYRING=file
```

On a shared machine, prefer a service token over a stored login.

### `logout` is refused

`XECRET_TOKEN` is set in your environment. Service tokens are revoked from the
dashboard, not from the machine holding them. `unset XECRET_TOKEN` if you meant
to log out of a stored login.

## Finding your project

### `no .xecret.yaml found`

You are outside a configured project. Either:

```bash
xecret init                                    # create one here
xecret run --project p --environment e -- cmd  # or name the scope explicitly
```

The file is found by walking up from the current directory, so it works from
any subdirectory — but not from a sibling directory of the repository.

### The wrong environment was loaded

Check in this order:

1. Flags on the command — they beat everything.
2. `.xecret.yaml` in the nearest parent directory. In a monorepo, a package may
   have its own file shadowing the root one.
3. `XECRET_TOKEN`, whose pinned scope answers when nothing else does.

```bash
xecret whoami          # under a token, prints the pinned scope
cat .xecret.yaml
```

### `no project with slug "…"`

The slug does not exist, or you cannot see it. `xecret projects` lists what you
can reach. Remember that "not visible to you" and "does not exist" deliberately
look identical — that is what stops the API being used to enumerate another
company's projects.

## Running your app

### My app says a variable is undefined

In order of likelihood:

1. **The secret is not in that environment.** `xecret secrets list` shows what
   is actually there.
2. **The wrong environment is loaded.** See above.
3. **The variable needs a prefix.** Vite only exposes `VITE_`-prefixed
   variables to your code; Next.js only exposes `NEXT_PUBLIC_` ones to the
   browser.
4. **The value is needed at build time, not run time.** `NEXT_PUBLIC_` and
   `VITE_` values are baked in during the build, so the *build* must run under
   `xecret run`.

### Changing a secret did not take effect

The environment is injected when `xecret run` starts the process. Hot reload
does not re-fetch. Stop the process and run the command again.

### `xecret run` hangs

Almost always your own command waiting for something, since `run` execs it
directly and forwards signals. `Ctrl-C` reaches the child. If it hangs *before*
any output, the API call is timing out — see the offline section below.

## Network and offline

### `xecret API unreachable — using cached secrets`

Working as designed. The API could not be reached, so the encrypted local cache
answered, and the CLI said so on stderr with the cache's age.

If the age is surprising, that is the point of printing it. `--no-cache` makes
the command fail instead of falling back.

### It failed instead of falling back to the cache

The cache answers only when the API *cannot* answer — a network failure or a
5xx. A 401, 403 or 404 is a **decision**, most importantly a revocation, and
decisions are never softened by a local file.

Also check there is a cache at all: the first run in a new environment has
nothing to fall back to.

### Behind a corporate proxy

The CLI honours the standard `HTTPS_PROXY` and `NO_PROXY` variables.

```bash
export HTTPS_PROXY=http://proxy.internal:3128
```

A TLS-intercepting proxy needs its CA in your system trust store; the binary
uses the platform's roots.

## CI

### `XECRET_TOKEN was not accepted`

Read the whole hint the CLI prints. In order:

- **Copied wrong.** The token is one long line. A CI variable UI that wraps or
  trims it silently is a common cause — re-paste it.
- **Expired.** Check the expiry in *Tokens → Service tokens*.
- **Revoked.** Same page; revoked tokens are listed.
- **IP allowlist.** If you set one, your runner's egress address must be in it.
  Hosted runners change addresses.

### `This service token cannot do that`

The token is `read` and the job is writing, or the job is trying to **delete** a
secret — which no service token can do, at any access level. Mint a `write`
token for the first case; for the second, do it from the dashboard.

### `not found` for an environment that exists

The token is pinned to a different project or environment. Passing
`--environment production` to a job whose token is pinned to `staging` fails
server-side, by design.

```bash
curl https://xecret.playxoft.com/api/tokens/self \
  -H "Authorization: Bearer $XECRET_TOKEN"
```

That prints the token's actual pin.

### Everything works locally and fails in CI

Nine times out of ten: the CI job has no `.xecret.yaml` and you expected one, or
the token's pin differs from the environment you use locally. Print
`xecret whoami` as the first step of the job.

## Writing secrets

### `is not a valid secret name`

Names follow shell rules: letters, digits and underscores, never starting with
a digit, up to 256 characters. `MY_KEY` is valid; `my-key`, `MY.KEY` and
`2FA_SECRET` are not.

### `value does not match the declared type`

The secret has a declared value type and the new value does not satisfy it —
this is the check catching `3o30` before your service does at 02:00. Fix the
value, or change the type with `xecret secrets set NAME --type string`.

### `409 conflict`

A name or slug is already taken, or two writes raced. Retry; if it persists,
the name genuinely exists.

## Permissions

### `403 forbidden`

You are a member, but not permitted. Usually production: developers and viewers
get `none` there by default, and need an explicit grant. Check *Members → you →
Access*, which shows your resolved level for every environment and the rule
that produced it.

### `session_locked`

Your session is signed in but PIN-locked. Enter the PIN. This is the dashboard
only; bearer tokens are not PIN-gated.

### `409` when deleting your account

You are the only active owner of an organisation other people are in.
Ownership has to move first — promote somebody, then try again.

## Reporting a bug

Include:

```bash
xecret version
```

the exact command, the full error including the hint line, and the `requestId`
from any API error. That id correlates with the server's logs, which never
contain your values.

## Next

- [FAQ](faq.md) — questions rather than errors.
- [Command reference](cli/commands.md) — every flag.
- [The offline cache](cli/offline-cache.md) — the rules behind the fallback.
