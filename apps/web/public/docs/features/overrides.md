---
title: Personal overrides
description: Use your own value for one secret on your machine — a local database instead of staging's — without changing the environment anyone else reads, or any CI run.
keywords: [local overrides, personal secrets, developer overrides, local env override, xecret run]
updated: 2026-10-20
---

A personal override is **your** value for one secret in one environment. When
you run `xecret run`, it replaces the shared value on your machine and nowhere
else. It is on the Pro plan and above.

## Setting one

```bash
printf '%s' "postgres://localhost:5432/app" | xecret overrides set DATABASE_URL -
xecret overrides list
xecret run -- npm run dev
```

`run` prints which overrides it applied — names only — every time, so a local
value is never mistaken for the shared one. Remove one with
`xecret overrides unset DATABASE_URL`. The dashboard's environment page has a
*My overrides* card that does the same.

The name need not be a secret the environment already holds: an override is
also how you try a new variable locally before proposing it.

## The rules

- **Never visible to another member.** It is encrypted under a key derived from
  your own vault, not under the environment's key, so a teammate who can read
  every value in the environment still cannot open your override. Neither can
  the server.
- **Never forged.** The same key is the only one that can make an override your
  CLI will accept, so a value cannot be slipped into your process in your name —
  not by a teammate, and not by the server.
- **Never part of a CI fetch.** A service token is refused every override route
  and no pull or bundle carries one: a pipeline always gets the shared values. A
  personal override that changed a production deploy would be the worst bug this
  product could have, so it is not a setting, it is the design.
- **Never inherited.** An override belongs to exactly one environment; a child
  environment does not see its parent's.
- **Only `run` applies them.** `xecret pull` and `xecret export` produce files
  that get committed and shared, which is the wrong place for one person's
  values. Each says on stderr when you have overrides it did not include.

## After a vault reset

A vault reset gives your account a new key pair, and an override made under the
old one no longer opens. `xecret run` stops rather than quietly using the shared
value in its place — you set the override precisely so as not to get that
value — and names the `xecret overrides unset` that removes each one. Set them
again afterwards.

## Offline

Overrides are fetched live, never cached. A run from the [offline
cache](../cli/offline-cache.md) uses the shared values and says that it did.

## If your plan changes

Overrides you already have keep working, and you can always list and remove
them. Only setting a new one needs the plan.

## Next

- [References and inheritance](references.md) — building one secret from others.
- [CLI command reference](../cli/commands.md) — every flag of `xecret overrides`.
