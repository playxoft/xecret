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
2. `npm run phase:check-env` — root key parses; the WorkOS client id, API key and
   cookie password are present and well-formed; the app DB role is not the
   migration role. It cannot tell which WorkOS environment a key is from.
3. Work through **Identity provider (WorkOS)** below. Most of it is dashboard
   state that no script can see — including whether the key and the client id
   belong together.
4. Apply pending migrations to the target database **before** deploying a build
   that needs them (see **Database** below).
5. `npm run verify` — format, lint, typecheck, tests.
6. Confirm the target: the deploy script prints
   `Building for <env> at <origin>` and the WorkOS client id it will sign in
   against before it does anything. Read both lines.
7. Deploy: `npm run phase:deploy` (production). Never a bare
   `opennextjs-cloudflare deploy` — it skips the build stamping and the
   environment checks in `scripts/deploy-web.sh`.
8. After the deploy, re-run `npm run phase:check-deploy` and confirm
   `GET /api/version` reports the commit you deployed:
   ```sh
   curl -s https://xecret.playxoft.com/api/version
   ```
   Then sign in for real, through the deployed site. It is the only check that
   proves the client id, the API key and the redirect URI all belong together.

## Identity provider (WorkOS)

Sign-in is WorkOS AuthKit (`docs/adr/0010-workos-as-identity-provider.md`). The
browser only navigates to AuthKit; the Worker exchanges the code using its API
key, and the vault-reset re-authentication uses WorkOS Magic Auth through the
same key. WorkOS's two environments share nothing — users, keys, client ids,
redirect URIs — so every value below must come from the **same** one.

| | WorkOS environment | `WORKOS_CLIENT_ID` | `WORKOS_API_KEY` |
|---|---|---|---|
| production | Production | `client_01M36CECX3Z66Q2FYY2FN8WG73` | a Production key |
| staging | Staging | `client_01M36CECEQ1FY9TA1F952FY958` | a Staging key |
| local dev (`[vars]`) | Staging | `client_01M36CECEQ1FY9TA1F952FY958` | a Staging key |

Check, for the environment being deployed:

- **`WORKOS_CLIENT_ID`** is in `apps/web/wrangler.toml` `[env.<env>.vars]` and is
  the id in the table above. It is not a secret. `scripts/deploy-web.sh` refuses
  to build without it, or with a value that is not `client_…`.
- **`WORKOS_API_KEY`** and **`WORKOS_COOKIE_PASSWORD`** are in Phase.dev for that
  environment **and** pushed to the Worker as encrypted secrets, from
  `apps/web/`:
  ```sh
  npx wrangler secret put WORKOS_API_KEY --env production
  npx wrangler secret put WORKOS_COOKIE_PASSWORD --env production
  ```
  Paste each value from Phase.dev at the prompt. `check:deploy` fails on either
  one missing from the Worker; `wrangler secret list --env <env>` shows the
  names. A deploy does not push them — Phase holding a value is not the Worker
  holding it.
- **The key and the client id are from the same WorkOS environment** — the
  Production key with `client_01M36CECX3Z66Q2FYY2FN8WG73`, the Staging key with
  `client_01M36CECEQ1FY9TA1F952FY958`. This is a check a person makes in the
  WorkOS dashboard: switch to the environment whose client id is in
  `wrangler.toml` and confirm the key Phase.dev holds for this deployment is one
  of *that* environment's API keys. **Never infer the environment from the
  key's prefix** — WorkOS has issued `sk_test_…`, `sk_live_…` and plain `sk_…`
  keys, and this deployment's Production key is the plain kind. No script
  checks the pairing; a mismatch fails every sign-in in a way that looks like a
  code bug, and only a real sign-in after the deploy proves it right.
- **`WORKOS_COOKIE_PASSWORD`** is at least 32 characters and an independent
  random value (`openssl rand -base64 32`), never the API key or derived from
  it. Too short, and every sign-in answers 503.
- **The redirect URI in the WorkOS dashboard** (that environment → Redirects) is
  exactly `<XECRET_PUBLIC_URL>/api/auth/callback` for the deployment:
  - production: `https://xecret.playxoft.com/api/auth/callback`
  - staging: `https://xecret-staging.playxoft.com/api/auth/callback`
  - local dev, in the Staging environment: `http://localhost:3030/api/auth/callback`

  The app never configures it separately — it is derived from
  `XECRET_PUBLIC_URL` — so a host change in `wrangler.toml` needs the matching
  dashboard change, or AuthKit refuses every redirect back.

### Security invariants to verify

These are WorkOS dashboard settings that nothing in the repository can check.
Look at them in **both** WorkOS environments.

- **Email verification is ON.** WorkOS currently documents it as always on, with
  no toggle. If a toggle ever appears, it must stay on: the sign-in linker adopts
  an existing xecret account by *verified* email address, and with verification
  off, "verified" stops meaning the person controls the inbox — an account
  takeover by sign-up.
- **Magic Auth is enabled** (Authentication). The vault-reset re-authentication
  needs it: while it is disabled as a sign-in method, WorkOS refuses to create a
  code at all (`400 authentication_method_not_allowed`, verified on Staging on
  2026-10-12), and `POST /api/auth/reauth/start` answers 503. Enabling it also
  offers "email me a code" on the hosted sign-in page; the sign-in callback
  deliberately does not count such a sign-in as the reset's first lock.
- **The default Magic Auth email is enabled** (Emails → Configuration). The
  vault-reset re-authentication creates a Magic Auth code through the API, and
  it is WorkOS, not xecret, that emails it — xecret never sees the code. With
  that email turned off the code is created and never arrives, and nobody can
  reset a vault.

## Database

Migrations are applied separately from the deploy, and a build that expects a
table its database does not have fails at request time, not at deploy time.

- **This build needs migration `0019_reauthentications`** (the
  `reauthentications` table behind the vault-reset re-authentication). Apply it
  to the target database before deploying:
  ```sh
  phase run --env Production -- npm run db:migrate
  ```
  `db:migrate` applies only what is pending and prints what it applied, so it is
  safe to re-run to confirm.

### First deploy after the Firebase → WorkOS switch (one-off)

Delete this subsection once production has run the WorkOS build for a while.

- `check:deploy` against the still-Firebase Worker warns about
  `FIREBASE_PROJECT_ID`, "a plaintext var on the Worker that neither
  wrangler.toml nor this script knows about". Expected: this deploy removes it.
- The `JWKS_CACHE` KV namespace is no longer bound to anything. Leave it in the
  Cloudflare account while a rollback to the Firebase build is still possible;
  removing it after that is a person's decision, not part of a deploy.
- `NEXT_PUBLIC_FIREBASE_CONFIG` and `FIREBASE_PROJECT_ID` in Phase.dev are read
  by nothing now. Same rule: they go when rollback is off the table.

## Adding a new variable

Decide its home first, then put it there:

- **Not a credential** → `[env.<env>.vars]` in `apps/web/wrangler.toml`.
- **A credential** → `wrangler secret put <NAME> --env <env>`, from
  `apps/web/`. Never a var: the file is committed and the repo is going public.
- **The Root KEK** → Secrets Store only, via `scripts/deploy-bootstrap.sh`.
  Never a var, never a secret, never printed.
- **Build-time only** (a `NEXT_PUBLIC_*` value, of which there are none today)
  → Phase.dev. It is inlined by `next build` and has no business on the Worker.

Then add it to the `CONTRACT` table in `scripts/check-deploy.ts`, so the next
person's preflight knows about it.

## Rules

- Never put a credential in `wrangler.toml`, and never paste one into the
  Cloudflare dashboard as a plaintext var. Encrypted secrets survive deploys;
  plaintext dashboard vars do not — so plaintext is both less safe *and* worse
  at persisting.
- Never deploy with `check:deploy` failures.
- Never deploy without naming the Phase environment: `.phase.json` defaults to
  `Development`, and the deploy should run under the same environment
  `phase:check-deploy` just compared against the Worker.
- Never mix WorkOS environments: a Production client id with a Staging key, or
  the reverse, is a deployment nobody can sign in to.
- `wrangler secret list --env production` shows names only, never values. Use it
  to confirm a secret landed.
