---
title: The offline cache
navTitle: Offline cache
description: How xecret keeps working when the network does not — what the encrypted local cache stores, exactly when it answers, and why a revoked credential is never softened by it.
keywords: [xecret offline, offline cache, xecret run offline, encrypted cache, revocation]
updated: 2026-08-16
---

A secret manager that stops your `npm run dev` when its API has a bad day has
made your work depend on our uptime. It should not. So `xecret run` keeps an
encrypted copy of the last environment it fetched, and falls back to it.

The interesting part is not that a cache exists. It is the rule for when it
answers.

## The rule, stated once

**The API is authoritative. The cache answers only when the API *cannot*, never
when it *will not*.**

| What happened | What `xecret run` does |
|---|---|
| The request succeeds | Uses the response, and refreshes the cache |
| DNS fails, connection refused, timeout | Falls back to the cache, loudly |
| The server answers 5xx | Falls back to the cache, loudly |
| The server answers **401** | Fails. Your credential was rejected. |
| The server answers **403** | Fails. You are not allowed. |
| The server answers **404** | Fails. It does not exist, or is not yours. |

A 401, 403 or 404 is a *decision*, and the most important decision in that list
is **revocation**. When an admin revokes a laptop's access, that must take
effect immediately — not "immediately unless the laptop turns off its Wi-Fi".
Softening a rejection with a local file would make the revoke button a
suggestion.

A network failure is not a decision. It carries no information about whether
you are still allowed, so falling back is safe.

## The fallback is loud

Every time the cache answers, the CLI writes to **stderr**:

```text
warning: xecret API unreachable — using cached secrets
         cached 2026-08-15 17:41 (18 hours ago), 24 secrets
```

Stderr, not stdout, so it never contaminates a pipe. Loud, because silently
serving day-old configuration is how a rotated credential appears to still
work.

## What is stored, and how

The cache lives in `~/.xecret/cache/`, with one file per **(host,
organisation, project, environment)**.

- Encrypted with **AES-256-GCM**.
- The key lives in your OS keychain, not beside the file.
- The additional authenticated data binds each file to its exact scope.

That last point is the one worth understanding. The scope is cryptographically
bound into the ciphertext, so a cache file cannot be renamed from `staging` to
`production` and decrypted as production — the authentication tag fails and the
CLI treats the file as absent. Local ciphertext gets the same treatment as
server-side ciphertext.

Copying a cache file to another machine gets you nothing either: the key is in
the first machine's keychain.

## Controlling it

```bash
xecret run --offline -- npm run dev     # do not call the API at all
xecret run --no-cache -- npm run dev    # neither read nor refresh the cache
xecret cache clear                      # delete every cached environment
```

`--offline` is for working on a plane, or for proving to yourself that the
fallback works before you rely on it. It is refused under `XECRET_TOKEN`,
because a service token never writes a cache in the first place.

`--no-cache` is the right flag for a shared or untrusted machine: nothing is
written to disk, and an outage simply fails.

## Why CI has no cache

Under `XECRET_TOKEN` no cache is written and none is read.

A CI runner is disposable and rebuilt from nothing on every job, so a cache
would almost never hit. What it would reliably do is leave an encrypted blob of
production configuration on a machine somebody else's job runs on next. The
benefit is near zero and the liability is real, so the feature is simply absent
there rather than configurable.

## When the cache does not exist

The first `xecret run` in a new environment has nothing cached. If that first
run is also the moment the API is down, the command fails — there is nothing to
fall back to. This is worth knowing before you rely on offline mode on a fresh
machine: run once while online.

## Next

- [Command reference](commands.md#run) — every `run` flag.
- [Troubleshooting](../troubleshooting.md) — what each failure message means.
- [Trust model](../security/trust-model.md) — the server-side half of the same
  story.
