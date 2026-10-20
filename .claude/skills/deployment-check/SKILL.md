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

- Production ran with no `ZEPTOMAIL_TOKEN`. Mail was optional by design, so every
  PIN reset email was declined silently — a green deploy, a healthy site, and
  reset links that never arrived. Mail is **no longer optional in production**:
  the vault escape archive is emailed before every vault reset, and a production
  Worker with no mail refuses every reset (503) rather than reset without it.
  `check:deploy production` fails on a missing `ZEPTOMAIL_TOKEN` or
  `ZEPTOMAIL_FROM_ADDRESS`.
- `BETTERSTACK_SOURCE_TOKEN` was never on the Worker, so production logs existed
  only in Cloudflare's tail.

## The check

Every command below names the Phase environment that holds the **target's**
values. `.phase.json` defaults to `Development`, so a bare `phase run --` checks
the Development set whatever you meant to deploy.

| Deploying | Phase environment | `check:deploy` | `check:env` |
|---|---|---|---|
| production | `Production` | `npm run phase:check-deploy` (= `phase run --env Production -- npm run check:deploy production`) | `phase run --env Production -- npm run check:env` |
| staging | `Development` — staging's values live there | `phase run --env Development -- npm run check:deploy staging` | `phase run --env Development -- npm run check:env` |

`check:deploy` compares all three sources and prints a line per variable.
**Zero failures is the bar for deploying.** Warnings are read, not skipped: "in
Phase but NOT on the Worker" is the exact shape of both outages above.

`check:env` validates what the variables *contain*, which is a different
question. `npm run phase:check-env` is **not** a production preflight: it runs
under the default `Development` environment and validates that set, not
Production's.

## Procedure

1. `check:deploy` for the target (table above) — resolve every failure, read
   every warning. Among them it compares the `WORKOS_CLIENT_ID` Phase holds for
   the target with the one `wrangler.toml` declares for that environment.
2. `check:env` for the target (table above) — root key parses; the WorkOS client
   id, API key and cookie password are present and well-formed; the app DB role
   is not the migration role. With the WorkOS values set it makes **one network
   call**, which proves the key and the client id belong together: it POSTs a
   deliberately bogus authorization code to WorkOS's authenticate endpoint with
   the client id and the API key. `invalid_grant` means WorkOS accepted the pair
   and refused only the code — they match; `invalid_client` or a 401 means they
   do not. `phase run --env <Env> -- npm run check:env -- --offline` skips the
   call, and then nothing has checked the pairing. Neither script infers
   anything from a key prefix.
3. Work through **Identity provider (WorkOS)** below. Most of it is dashboard
   state that no script can see.
4. Apply pending migrations to the target database **before** deploying a build
   that needs them (see **Database** below).
5. `npm run verify` — format, lint, typecheck, tests.
6. Confirm the target: the deploy script prints
   `Building for <env> at <origin>` and the WorkOS client id it will sign in
   against before it does anything. Read both lines.
7. Deploy: `npm run phase:deploy` (production). Never a bare
   `opennextjs-cloudflare deploy` — it skips the build stamping and the
   environment checks in `scripts/deploy-web.sh`.
8. After the deploy, re-run `check:deploy` for the target and confirm
   `GET /api/version` reports the commit you deployed:
   ```sh
   curl -s https://xecret.playxoft.com/api/version
   ```
   Then sign in for real, through the deployed site. `check:env` proved the pair
   Phase holds; only a real sign-in proves the key the *Worker* holds as a
   secret, and the redirect URI, belong with the client id.
9. Confirm the scheduled jobs (P23, P12). They run from the Worker's own Cron
   Triggers, declared in `apps/web/wrangler.toml` (`[env.production.triggers]`,
   `crons = ["17 * * * *", "41 3 * * *"]`): hourly the retained-vault purge and
   then the billing job; nightly the billing reconciler.
   - Cloudflare dashboard → Workers & Pages → `xecret-production` → Settings →
     Triggers lists **both** Cron Triggers. The deploy output also prints the
     schedules it set. No hourly trigger means retained vaults are never
     purged — the seven-day promise breaks silently — and seat-sync retries,
     overage reports and dated reminders never run.
   - The internal routes must **not** answer the internet:
     ```sh
     for job in vault-purge billing-hourly billing-daily; do
       curl -s -o /dev/null -w "$job %{http_code}\n" -X POST "https://xecret.playxoft.com/api/internal/scheduled/$job"
     done
     ```
     prints `404` for each. Anything else — a `200` above all — is a deployment
     that lets anybody run them, and is rolled back.
   - After the next `:17` past the hour, the Worker's logs show the scheduled
     run: `POST /api/internal/scheduled/vault-purge` and then
     `…/billing-hourly`, each answered `200`, made in-process by the Cron
     Trigger rather than from outside.
10. If payments are on (P12): the Dodo webhook endpoint
    `https://xecret.playxoft.com/api/billing/webhook` is registered in the Dodo
    mode `DODO_ENVIRONMENT` names, and its delivery log shows recent attempts
    answered `200`. See **Payments (Dodo)** below.

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
  to build without it, or with a value that is not `client_…`. Phase.dev holds
  a copy for the target's Phase environment too, and `check:deploy` compares
  that copy with `wrangler.toml`'s and reports a mismatch.
- **`WORKOS_API_KEY`** and **`WORKOS_COOKIE_PASSWORD`** are in Phase.dev for that
  environment **and** pushed to the Worker as encrypted secrets, from
  `apps/web/` (`--env staging` for staging):
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
  `client_01M36CECEQ1FY9TA1F952FY958`. `check:env` proves this with its one
  network call (Procedure step 2): `invalid_grant` is a match, `invalid_client`
  or a 401 a mismatch. If it was run `--offline`, or cannot reach WorkOS, check
  by hand in the WorkOS dashboard: switch to the environment whose client id is
  in `wrangler.toml` and confirm the key Phase.dev holds for this deployment is
  one of *that* environment's API keys. **Never infer the environment from the
  key's prefix** — WorkOS has issued `sk_test_…`, `sk_live_…` and plain `sk_…`
  keys, and this deployment's Production key is the plain kind. `check:env`
  proves the pair Phase holds; that the Worker's secret is that same key is
  proved by a real sign-in after the deploy.
- **`WORKOS_COOKIE_PASSWORD`** is at least 32 characters and an independent
  random value (`openssl rand -base64 32`), never the API key or derived from
  it. Too short, and every sign-in ends on `/sign-in?error=unavailable`.
- **The redirect URI in the WorkOS dashboard** (that environment → Redirects) is
  exactly `<XECRET_PUBLIC_URL>/api/auth/callback` for the deployment:
  - production: `https://xecret.playxoft.com/api/auth/callback`
  - staging: `https://xecret-staging.playxoft.com/api/auth/callback`
  - local dev, in the Staging environment: `http://localhost:3030/api/auth/callback`

  The app never configures it separately — it is derived from
  `XECRET_PUBLIC_URL` — so a host change in `wrangler.toml` needs the matching
  dashboard change, or AuthKit refuses every redirect back.
- **The Initiate login URI (sign-in endpoint) in the WorkOS dashboard** (that
  environment → Redirects) is exactly `<XECRET_PUBLIC_URL>/api/auth/login`:
  - production: `https://xecret.playxoft.com/api/auth/login`
  - staging: `https://xecret-staging.playxoft.com/api/auth/login`
  - local dev, in the Staging environment: `http://localhost:3030/api/auth/login`

  When AuthKit needs xecret to *start* a sign-in, it sends the browser here.
  Point it anywhere else and the callback refuses the sign-in as expired,
  because no state cookie was set for it.
- **A misconfigured deployment does not answer 503 at sign-in.** Both sign-in
  routes redirect to `/sign-in?error=unavailable`, and the real cause is in the
  log line. A smoke sign-in that lands on "unavailable" is a configuration
  problem, not a WorkOS outage, until proved otherwise.

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
- **MFA, if enabled, changes the vault reset.** With MFA on in WorkOS and an
  authenticator app enrolled on the account, WorkOS answers the emailed code
  with an MFA challenge, and the reset also needs the user's authenticator
  (TOTP) code — someone without their authenticator cannot reset. That branch is
  unit-tested against WorkOS's documented error shape only: MFA is not enabled
  in the Staging WorkOS environment, so it has not been checked live. Before
  relying on it in production, enable MFA in Staging and run a reset end to end
  with an enrolled account — entering a wrong authenticator code first (expect
  "That authenticator code is not right. Enter the current code from your
  app." and the same screen taking the next code), then the right one.

## Database

Migrations are applied separately from the deploy, and a build that expects a
table its database does not have fails at request time, not at deploy time.

- **This build needs migration `0019_reauthentications`** (the
  `reauthentications` table behind the vault-reset re-authentication, its
  `(user_id, signed_in_at)` index, and the application role's grant on it). Apply
  it to the target database before deploying — under the target's Phase
  environment (`--env Development` for staging):
  ```sh
  phase run --env Production -- npm run db:migrate
  ```
  Without the grant, every vault-reset request on a least-privilege database
  fails with "permission denied" — and so does a `reauth=1` sign-in, whose
  session is written in the same transaction as its `reauthentications` row.
  `db:migrate` applies only what is pending and prints what it applied, so it is
  safe to re-run to confirm.
- **This build needs migration `0020_retained_vaults`** (P23: the
  `retained_vaults`, `retained_vault_wraps` and `retained_vault_grants`
  tables, the triggers that refuse an early delete or a widened window, and the
  application role's narrowed grants). Apply it **before** deploying, the same
  way. Deploying the build first is worse than a plain 500:
  - a **vault reset emails the archive and then fails** to retain the vault —
    the person has the email, nothing was reset, and their reset proof is spent,
    so they must sign in again and get a new code to retry;
  - **Settings → Security shows an error** in place of the "Recover a
    previous vault" card for every unlocked account, because the card reads the
    retained tables (the rest of the page works);
  - the **hourly Cron Trigger fails every run** until the tables exist.

  `check:deploy` does not read the database, so it cannot warn about this:
  `db:migrate` is the check, and it is safe to re-run.

### First deploy after the Firebase → WorkOS switch (one-off)

Delete this subsection once production has run the WorkOS build for a while.

- **Start with the migration runbook's §4 "Before the deploy" checklist**
  (`docs/operations/workos-user-migration.md`), all of it, before this
  preflight: `firebase login --reauth` and a rehearsal export;
  `--check-hash-params` against the owner's own account (**MATCH**);
  `--self-test` (`RESULT: ok`); the rehearsal import dry run, read; every
  disabled Firebase user decided with `--soft-delete-disabled`, with
  `--keep <uid>` for anyone kept on purpose; and, if any user signs in with
  Google, Google OAuth set up in WorkOS Production with the Firebase
  project's own client id and secret. The deploy freezes Firebase passwords,
  and the export, import and backfill have to follow it without a break —
  which only works if every decision was made first. If any item is open,
  stop here.
- `check:deploy` against the still-Firebase Worker warns about
  `FIREBASE_PROJECT_ID`, "a plaintext var on the Worker that neither
  wrangler.toml nor this script knows about". Expected: this deploy removes it.
- The `JWKS_CACHE` KV namespace is no longer bound to anything. Leave it in the
  Cloudflare account while a rollback to the Firebase build is still possible;
  removing it after that is a person's decision, not part of a deploy.
- `NEXT_PUBLIC_FIREBASE_CONFIG` and `FIREBASE_PROJECT_ID` in Phase.dev are read
  by nothing now. Same rule: they go when rollback is off the table.

- **This build needs migration `0024_dodo_billing`** (P12: four nullable
  columns on `org_subscriptions` and the `billing_checkouts`,
  `billing_seat_syncs`, `billing_reminders` and `billing_license_keys` tables,
  with their grants). Apply it **before** deploying, the same way. Deploying the
  build first breaks the billing screen, the payment webhook (Dodo retries, so
  nothing is lost once it is applied), the hourly billing job, and deleting an
  organisation or an account — each reads whole `org_subscriptions` rows. Ordinary
  requests and secret fetches are unaffected.

### Payments (Dodo)

`docs/operations/billing.md` is the full guide. For a deploy:

- **All or nothing.** With none of the `DODO_*` variables the deployment takes
  no payments and `check:deploy` reports `billing (group)` as switched off —
  correct until Dodo is set up. With some of them it **fails**, naming what is
  missing, because a half-configured deployment answers 503 on every billing
  route and on the webhook.
- **Homes.** `DODO_API_KEY` and `DODO_WEBHOOK_SECRET` are credentials:
  `wrangler secret put … --env production`, from Phase. `DODO_ENVIRONMENT`,
  the four `DODO_PRODUCT_*` ids, `DODO_METER_SECRET_FETCH` and the optional
  `DODO_ADDON_SAML` are not: `[env.production.vars]` in `wrangler.toml` (the
  commented block there lists them).
- **One Dodo mode.** Test and live share nothing. The key, the webhook secret
  and every product id must come from the mode `DODO_ENVIRONMENT` names; a live
  product id in a test-mode deployment fails at checkout. `check:env` prints the
  mode and the product ids (not credentials) so a mismatch can be seen.
- **The meter's free threshold is 0** on every product in Dodo; the code
  subtracts the plan's allowance itself.

### Mail (ZeptoMail)

- **`ZEPTOMAIL_TOKEN`** (a secret) and **`ZEPTOMAIL_FROM_ADDRESS`** (a var) are
  **required in production**. The vault reset emails the escape archive before
  it changes anything, and a production deployment without mail refuses every
  reset — by the owner's decision, a vault is never reset without its archive
  for a reason the person did not choose. Invitations and PIN resets need the
  same two values.
- Staging and local development may run without mail: the reset screen then
  says no archive can be sent, and a reset goes ahead only when the person
  ticks "Reset without the emailed archive".

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
  `check:deploy` and `check:env` just validated — `Production` for production,
  `Development` for staging.
- Never mix WorkOS environments: a Production client id with a Staging key, or
  the reverse, is a deployment nobody can sign in to.
- `wrangler secret list --env production` shows names only, never values. Use it
  to confirm a secret landed.
