---
title: xecret with Next.js
navTitle: Next.js
description: Replace .env.local with xecret in a Next.js app — local development, NEXT_PUBLIC build-time variables, multiple environments, and deployment.
keywords: [nextjs secrets, next.js env variables, NEXT_PUBLIC, replace .env.local, nextjs environment management]
updated: 2026-08-16
---

Next.js reads configuration from `process.env`, which is exactly what
`xecret run` fills in. Your code does not change.

## Local development

```bash
xecret init                    # once per repository; commit .xecret.yaml
xecret run -- next dev
```

Delete `.env.local`, and make sure `.env*` is in `.gitignore`. Everything the
server side reads through `process.env` is already there.

Two Next.js-specific things are worth knowing.

### `NEXT_PUBLIC_` variables are inlined at build time

Anything prefixed `NEXT_PUBLIC_` is substituted into the JavaScript bundle
during `next build`. That means:

- It must be present in the environment of the **build**, so CI runs
  `xecret run -- next build`, not just `xecret run -- next start`.
- It is **not a secret** once built. It ships to every browser that loads your
  site. Storing it in xecret keeps it managed and versioned; it does not make
  it private.

Keep real credentials out of that prefix regardless of where they are stored.

### `next dev` does not re-read secrets on restart

The environment is injected when `xecret run` starts the process. Hot reload
does not re-fetch. After changing a secret, stop the dev server and run the
command again — the same moment you would have edited `.env.local`.

## Server-only secrets

Next.js server components, route handlers and server actions can read anything
in `process.env`. The rule to hold onto is Next's own: a variable without the
`NEXT_PUBLIC_` prefix is never sent to the browser, so a database URL read in a
server component stays on the server.

```ts
// app/api/health/route.ts — runs on the server, never in a bundle
export async function GET() {
  const url = process.env.DATABASE_URL;
  // …
}
```

## Multiple environments

`.xecret.yaml` names the default, usually `development`. Point a single command
somewhere else without editing it:

```bash
xecret run --environment staging -- next start
xecret run --environment production -- next build
```

Production is deny-by-default for the `developer` role: reaching it takes an
explicit grant from somebody who manages members, not a flag. See
[teams, roles and access](teams.md).

## CI and deployment

```yaml
# GitHub Actions
- uses: playxoft/xecret@v1
- run: xecret run -- next build
  env:
    XECRET_TOKEN: ${{ secrets.XECRET_TOKEN }}
```

Because `NEXT_PUBLIC_` values are baked in at build time, the build step is the
one that must run under `xecret run`. Full CI recipes: [secrets in
CI](ci.md).

### Platforms that inject the environment themselves

Vercel, Cloudflare Pages and similar platforms set environment variables from
their own dashboards at deploy time. Two options:

1. **Keep xecret as the source of truth and sync at deploy.** Pipe
   `xecret pull --format env` into the platform's own CLI as a deploy step.
   Nothing is committed, and there is still one place a value is edited.
2. **Build in CI under `xecret run`, deploy the artefact.** Preferable where
   the platform accepts a prebuilt output, because nothing has to be
   synchronised at all.

```bash
# option 1, sketched — never commit the output of this
xecret pull --format env | while IFS='=' read -r key value; do
  your-platform-cli env set "$key" "$value" --environment production
done
```

## Next.js on Cloudflare Workers

If you deploy through `@opennextjs/cloudflare` — as xecret itself does — note
that Worker bindings and `process.env` are two different things at runtime. Use
xecret for build-time configuration and for anything your Node-compatible code
reads from `process.env`; use Wrangler's own `vars` and secrets bindings for
values the Worker runtime resolves.

## Next

- [Node.js](nodejs.md) — the same patterns without the framework.
- [Secrets in CI](ci.md) — service tokens end to end.
- [Command reference](../cli/commands.md) — every flag.
