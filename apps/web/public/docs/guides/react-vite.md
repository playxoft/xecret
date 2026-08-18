---
title: xecret with React and Vite
navTitle: React / Vite
description: Use xecret with a Vite front end — the VITE_ prefix, why browser configuration is never secret, and where the real credentials belong instead.
keywords: [vite env variables, react secrets, VITE_ prefix, frontend environment variables, import.meta.env]
updated: 2026-08-16
---

Vite exposes variables prefixed `VITE_` to your application code through
`import.meta.env`. `xecret run` supplies them to the build.

```bash
xecret init
xecret run -- vite dev
xecret run -- vite build
```

Delete `.env`, `.env.local` and friends.

## The thing to understand before anything else

**Nothing a browser can read is a secret.**

Vite substitutes `VITE_`-prefixed variables into the JavaScript bundle at build
time. That bundle is downloaded by every visitor. "View source" is all it takes
to read every one of them.

This is not a Vite flaw — it is what a front end *is*. But it changes what
xecret is doing for you here:

| | |
|---|---|
| What xecret **does** give you | One managed, versioned, audited place for build configuration, shared across the team and CI, with no `.env` files to keep in sync. |
| What it **cannot** give you | Privacy for anything in that bundle. |

So `VITE_API_URL`, `VITE_SENTRY_DSN` and `VITE_STRIPE_PUBLISHABLE_KEY` are fine
to store and inject. `STRIPE_SECRET_KEY` is not — not because xecret would
handle it badly, but because a browser would.

Real credentials belong in the back end that your front end talks to. Give that
service its own project or its own environment, and let it hold the keys.

## Local development

```json
{
  "scripts": {
    "dev": "xecret run -- vite",
    "build": "xecret run -- vite build",
    "preview": "xecret run -- vite preview"
  }
}
```

```ts
// src/config.ts
export const apiUrl = import.meta.env.VITE_API_URL;
```

## Build time is the moment that matters

Because substitution happens during `vite build`, the build is what must run
under `xecret run`:

```yaml
- uses: playxoft/xecret@v1
- run: xecret run -- npm run build
  env:
    XECRET_TOKEN: ${{ secrets.XECRET_TOKEN }}
```

Serving the built files afterwards needs no xecret at all — the values are
already inside them. Which also means: to change one, you must rebuild.

## Different environments, different builds

```bash
xecret run --environment staging -- vite build
xecret run --environment production -- vite build
```

Each produces a different bundle, because each inlined different values. Keep
the two artefacts distinct in your deployment pipeline; a staging bundle
deployed to production points at the staging API and will look like it works.

## A separate project for the front end

If your front end and back end live in one repository but deploy separately,
give them separate xecret projects:

```text
repo/
├── web/
│   └── .xecret.yaml     project: acme-web,  environment: development
└── api/
    └── .xecret.yaml     project: acme-api,  environment: development
```

Then a service token minted for the web build cannot read the API's
credentials, because it is pinned to a project that does not contain them. That
is the whole reason to split them.

## Next

- [Node.js](nodejs.md) — for the back end holding the real secrets.
- [Secrets in CI](ci.md) — build tokens, scoped to one project.
- [Core concepts](../concepts.md) — projects, environments and grants.
