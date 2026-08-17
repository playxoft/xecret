---
title: Configuration and scope
navTitle: Configuration
description: How the CLI decides which project and environment you mean, the .xecret.yaml format, every environment variable, and where credentials are stored.
keywords: [xecret.yaml, XECRET_TOKEN, XECRET_API_URL, xecret keyring, scope resolution, cli configuration]
updated: 2026-08-16
---

The CLI takes configuration from four places. This page says exactly which one
wins, and what each is for.

## Scope resolution

Every secret-touching command needs an *(organisation, project, environment)*
triple. It is resolved in this order, first answer winning:

1. **`--project` / `--environment` flags** — explicit beats everything.
2. **`.xecret.yaml`**, discovered by walking up from the working directory,
   the way `git` finds `.git`. So `xecret run` works from any subdirectory.
3. **The service token's pinned scope**, when `XECRET_TOKEN` is set.
4. **Nothing** — an error telling you to run `xecret init`.

The **organisation** is never one of these. It always comes from the
credential: a login is pinned to one organisation, a service token to one
organisation, project *and* environment.

> **Note** — Naming a scope outside a service token's pin is refused by the
> server, not merely by the client. Passing `--environment production` to a job
> whose token is pinned to `staging` fails with a 404, not a quiet success. The
> client-side rules on this page are conveniences; the boundary is server-side.

## `.xecret.yaml`

Written by `xecret init`, read by everything else.

```yaml
project: checkout-api
environment: development
```

Two slugs, and that is the entire file. The type that models it has exactly two
fields, so nothing in the CLI can serialise anything else into it — which is
what makes the file safe to commit.

**Commit it.** It is what makes `git clone && xecret run -- npm run dev` work
for a new teammate without a setup document.

### Per-developer overrides

The file names the default environment, usually `development`. Anyone who needs
a different one passes a flag rather than editing the committed file:

```bash
xecret run --environment staging -- npm run dev
```

Or, if you always want a different default, set it for your shell session:

```bash
export XECRET_ENVIRONMENT=staging   # not read by the CLI — see below
```

That variable does *not* exist, deliberately. An environment variable that
silently redirects which secrets a command loads is exactly the mechanism by
which someone runs a migration against production believing it was staging. Be
explicit with the flag.

## Environment variables

| Variable | Effect |
|---|---|
| `XECRET_TOKEN` | Authenticate as a service token (`xst_…`). No login, no keychain, no offline cache. Overrides any stored login. |
| `XECRET_API_URL` | Which deployment to talk to — used by `login` and by `XECRET_TOKEN` mode. A stored login remembers its own URL, so you do not need this after `xecret login --api-url …`. |
| `XECRET_KEYRING=file` | Force the `0600` file fallback instead of the OS keyring. |
| `NO_COLOR` | Disable colour. Output is also uncoloured whenever stdout is not a terminal. |

### `XECRET_TOKEN` in practice

```bash
export XECRET_TOKEN=xst_live_…
export XECRET_API_URL=https://secrets.your-company.com   # self-hosted only
xecret run -- npm run build
```

While `XECRET_TOKEN` is set:

- `xecret login`, `logout` and `init` are refused — none of them make sense for
  a credential you did not create on this machine.
- No offline cache is written or read. A CI runner is disposable; an encrypted
  cache file on it would be a liability with no benefit.
- `whoami` reports the token's pinned scope rather than a person.

## Where credentials are stored

The credential from `xecret login` goes into your operating system's keychain:

| Platform | Store |
|---|---|
| macOS | Keychain |
| Windows | Credential Manager |
| Linux | Secret Service (GNOME Keyring, KWallet, …) |

Where no keyring is available — a bare container, a headless server, a minimal
window manager — the CLI falls back to a `0600` file under `~/.xecret/` and
**tells you on stderr** that it has done so. It never falls back silently: you
should know when your credential moved from a keychain to a file.

Force the file store with `XECRET_KEYRING=file`. That is occasionally the right
answer on a headless build machine where the keyring prompts for a password
nobody can type.

## Files the CLI creates

| Path | What it is |
|---|---|
| `.xecret.yaml` | Your project's scope. Commit it. |
| `~/.xecret/cache/` | The encrypted offline cache, one file per (host, org, project, environment). |
| `~/.xecret/` (fallback only) | The `0600` credential file, when no keyring exists. |

`xecret cache clear` removes the cache; `xecret logout` removes both the cache
and the credential.

## Pointing at a self-hosted deployment

```bash
# once, interactively
xecret login --api-url https://secrets.your-company.com

# in CI, where there is no stored login
export XECRET_API_URL=https://secrets.your-company.com
export XECRET_TOKEN=xst_…
```

The compiled-in default is `https://xecret.playxoft.com`. See
[self-hosting](../self-hosting.md).

## Next

- [The offline cache](offline-cache.md) — what the cache does and does not do.
- [Command reference](commands.md) — every flag in one page.
- [Secrets in CI](../guides/ci.md) — the token-based setup end to end.
