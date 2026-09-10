---
name: deployment-check
description: Preflight every xecret deployment. Use BEFORE any deploy to production or staging — before running scripts/deploy-web.sh, npm run deploy, npm run phase:deploy, or wrangler deploy — and whenever asked to check deployment config, env vars, secrets, or why a deployed Worker is missing a value. Verifies Phase.dev, wrangler.toml and the live Cloudflare Worker agree.
---

# Deployment check

Run this before every deploy. No exceptions, including "it's a one-line fix".

## Why it exists

A deploy can succeed completely and still produce a broken deployment, because
the configuration lives in three places that nothing keeps in sync:

| Where | Survives a deploy? | Holds credentials? |
|---|---|---|
| `apps/web/wrangler.toml` `[env.X.vars]` | Yes — every deploy re-asserts it | **No.** The file is committed. |
| `wrangler secret put` | Yes — carried forward, never printed | Yes. This is the place for them. |
| Cloudflare Secrets Store binding | Yes | Yes — used for `XECRET_ROOT_KEYS` |
| Cloudflare dashboard, added by hand | **No — wiped by the next deploy** | Never rely on it |
| Phase.dev | Not a Worker mechanism at all | Yes, but only at build/deploy time |

`wrangler deploy` **replaces** the Worker's plaintext vars with exactly the
`vars` table of the environment being deployed. A var added in the dashboard
survives until the next deploy and then vanishes. Phase.dev holding a value
means the *build* can see it; it says nothing about the Worker.

This has already cost real outages:

- Production ran with no `ZEPTOMAIL_TOKEN`. Mail is optional by design, so every
  PIN reset email was declined silently — a green deploy, a healthy site, and
  reset links that never arrived.
- `BETTERSTACK_SOURCE_TOKEN` was never on the Worker, so production logs existed
  only in Cloudflare's tail.

## The check

```sh
npm run phase:check-deploy          # production, under Phase's Production env
```

or, for another environment:

```sh
phase run --env Production -- npm run check:deploy staging
```

It compares all three sources and prints a line per variable. **Zero failures is
the bar for deploying.** Warnings are read, not skipped: "in Phase but NOT on the
Worker" is the exact shape of both outages above.

Run the value-level check too — it validates what the variables *contain*, which
is a different question:

```sh
npm run phase:check-env
```

## Procedure

1. `npm run phase:check-deploy` — resolve every failure, read every warning.
2. `npm run phase:check-env` — root key parses, Firebase server/client ids agree,
   the app DB role is not the migration role.
3. `npm run verify` — format, lint, typecheck, tests.
4. Confirm the target: the deploy script prints
   `Building for <env> at <origin>` before it does anything. Read that line.
5. Deploy: `npm run phase:deploy` (production). Never a bare
   `opennextjs-cloudflare deploy` — it skips the build stamping and the
   environment cross-checks in `scripts/deploy-web.sh`.
6. After the deploy, re-run `npm run phase:check-deploy` and confirm
   `GET /api/version` reports the commit you deployed:
   ```sh
   curl -s https://xecret.playxoft.com/api/version
   ```

## Adding a new variable

Decide its home first, then put it there:

- **Not a credential** → `[env.<env>.vars]` in `apps/web/wrangler.toml`.
- **A credential** → `wrangler secret put <NAME> --env <env>`, from
  `apps/web/`. Never a var: the file is committed and the repo is going public.
- **The Root KEK** → Secrets Store only, via `scripts/deploy-bootstrap.sh`.
  Never a var, never a secret, never printed.
- **Build-time only** (e.g. `NEXT_PUBLIC_FIREBASE_CONFIG`) → Phase.dev. It is
  inlined by `next build` and has no business on the Worker.

Then add it to the `CONTRACT` table in `scripts/check-deploy.ts`, so the next
person's preflight knows about it.

## Rules

- Never put a credential in `wrangler.toml`, and never paste one into the
  Cloudflare dashboard as a plaintext var. Encrypted secrets survive deploys;
  plaintext dashboard vars do not — so plaintext is both less safe *and* worse
  at persisting.
- Never deploy with `check:deploy` failures.
- Never deploy without naming the Phase environment: `.phase.json` defaults to
  `Development`, and `NEXT_PUBLIC_FIREBASE_CONFIG` is inlined at build time, so
  the default ships development's Firebase project inside a production build.
- `wrangler secret list --env production` shows names only, never values. Use it
  to confirm a secret landed.
