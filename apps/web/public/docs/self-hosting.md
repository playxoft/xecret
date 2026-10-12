---
title: Self-hosting xecret
navTitle: Self-hosting
description: Run xecret yourself — the honest dependency list, the root-key ceremony, a step-by-step deployment, and what you are signing up to operate.
keywords: [self host secret manager, cloudflare workers deployment, open source secrets manager, agpl, neon postgres, root key]
updated: 2026-10-12
---

xecret is AGPL-3.0 and designed to be run by people other than us. This page is
the honest version of what that takes, including the parts that are friction,
because a secrets manager that hides its operational costs is not being honest
about the one thing it sells.

## The dependency list, stated plainly

| Dependency | Role | Required? |
|---|---|---|
| **Cloudflare Workers** (paid plan) | Runs the web app and API. The paid plan's CPU limits are assumed. | Yes |
| **PostgreSQL** (Neon recommended) | All data. Hyperdrive in front of it on Cloudflare. | Yes |
| **Cloudflare Secrets Store** | Holds the runtime copy of the root key, bound to the Worker. | Yes |
| **A WorkOS account** | Identity only — AuthKit's hosted pages handle password, Google, MFA and enterprise single sign-on. xecret checks the result once, server to server, and issues its own sessions. | Yes, and **this is real friction**. AuthKit is free up to a million monthly active users; enterprise SSO connections are billed by WorkOS. An identity-provider interface exists so another provider can be contributed. |
| **A mail provider** | PIN-reset links and invitation emails. | No. Without it, invitations return a shareable link instead of sending mail, and PIN reset answers `sent: false` with a reason. |
| **A deploy-time secret source** | Where *your* copy of the root key lives between deploys. The Worker never calls it at runtime. | Your choice — anything that can populate environment variables at deploy time. |

If that list looks like a lot for a tool that injects environment variables:
it is, and it is stated up front for that reason.

## Before anything else: the root key

The root key encrypts every organisation's key, which encrypts every
environment's key, which encrypts every secret.

> **Important** — If you lose the root key, every secret is permanently
> unrecoverable. There is no support ticket, no recovery mode and no vendor
> that can help, including us. Do this step before storing the first real
> credential, not after.

1. **Generate and split it.**

   ```bash
   npm run keygen        # generates the key plus 2-of-3 Shamir shares
   ```

2. **Escrow the shares in physically separate places.** A USB stick in a safe,
   a printed sheet in a different building, a second site. Never all digital,
   never all in one place, never all held by one person.

3. **Write down who holds what, and test a restore.** A key-recovery drill that
   has never been run is a key-recovery plan you do not have. Run it
   quarterly.

## Deployment

### 1. Database

Create a PostgreSQL database and the restricted application role, then run
migrations.

```bash
npm ci
npm run db:migrate      # reads DATABASE_URL / MIGRATION_DATABASE_URL
```

Two roles, deliberately: migrations run as a role that can change the schema,
and the application runs as one that cannot — and in particular cannot alter
the audit table, which is what makes "append-only" a grant rather than a
promise.

### 2. Identity: a WorkOS account

xecret sends people to WorkOS AuthKit's hosted pages to sign in, checks the
result exactly once, server to server, and from then on uses its own session.
No identity-provider code runs in the browser, and nothing about the provider is
needed when the app is built. Set it up in the WorkOS dashboard:

1. **Pick the environment.** A WorkOS account has a **Staging** and a
   **Production** environment, and they share nothing — not users, not keys.
   Use Staging for local development and staging deployments, Production for
   production. Every value below must come from the environment the deployment
   signs people in against; a key from one and a client id from the other fails
   every sign-in in a way that looks like a bug and is not.
2. **Register the redirect URI**, exactly `<your origin>/api/auth/callback` —
   for example `https://secrets.your-company.com/api/auth/callback`, and
   `http://localhost:3030/api/auth/callback` in Staging for local development.
   xecret derives it from `XECRET_PUBLIC_URL`, so there is nothing to configure
   on the xecret side; a mismatch with the dashboard is a redirect AuthKit
   refuses.
3. **Set the sign-in endpoint** to `<your origin>/api/auth/login`. When AuthKit
   needs xecret to *start* a sign-in rather than finish one, it sends the browser
   there. A sign-in xecret did not start is refused as expired.
4. **Enable the sign-in methods** — email and password, and Google. Staging can
   use WorkOS's demonstration Google credentials; **Production needs your own**
   Google OAuth client, created in the Google Cloud Console with the redirect URI
   WorkOS shows you, and its client id and secret entered in WorkOS. MFA and
   enterprise single sign-on are WorkOS settings too; MFA is recommended for
   organisation owners.
5. **Enable Magic Auth**, and leave WorkOS's default Magic Auth email on.
   Resetting a vault asks for a one-time code that WorkOS creates and emails, and
   WorkOS refuses to create one while Magic Auth is disabled — so with it off,
   nobody can reset a vault. Enabling it also offers "email me a code" as a way
   to sign in; that never counts as the reset's first check, which needs a
   password, a passkey, Google or SSO.
6. **Collect three values.** The client id (`client_…`); the environment's
   secret API key; and a cookie password you generate yourself, at least 32
   random characters:

   ```bash
   openssl rand -base64 32
   ```

   The cookie password signs the short-lived cookie that ties a sign-in to the
   browser that started it. It must not be the API key. Do not judge which
   environment an API key belongs to by its prefix — check where you copied it
   from.

> **Warning** — Keep each environment's database to itself. Never point a
> deployment that signs in through Staging — local development included — at a
> database whose accounts sign in through Production. The first sign-in there
> with an existing person's address links their account to a Staging identity,
> and from then on their real sign-in is refused until somebody repairs the row
> by hand. If you cannot be sure, test sign-in locally only with a brand-new
> address.

> **Important** — Email verification is load-bearing. The first time somebody
> signs in, xecret adopts the existing account that holds the same *verified*
> address, and refuses an unverified one. AuthKit verifies every address and,
> at the time of writing, has no switch to stop it. If WorkOS ever adds one, it
> must stay on in both environments.

The client id is not a secret — it appears in every sign-in URL — and goes in
`wrangler.toml` (step 4). The API key and the cookie password are secrets and go
on the Worker:

```bash
npx wrangler secret put WORKOS_API_KEY --env production
npx wrangler secret put WORKOS_COOKIE_PASSWORD --env production
```

Without any of the three, nobody can sign in, and the sign-in routes say so
with a 503 rather than guess.

### 3. Cloudflare

Create:

- a **Hyperdrive** binding for the database (pointed at the *direct* endpoint —
  Hyperdrive pools, so a pooling endpoint must not be used underneath it);
- the **rate-limit** bindings;
- a **Secrets Store** entry holding the root key.

The repository's `wrangler.toml` names every binding the code expects, and
`.env.example` names every variable.

### 4. Tell the deployment it is yours

`apps/web/wrangler.toml` is committed to the repository, and everything
account-specific in it is **ours** — the domain, and the ids of the resources
step 3 just told you to create. Nothing you have done so far has changed any of
it, and nothing later on this page checks it for you. Edit it now, before the
first deploy:

```toml
[env.production]
name = "xecret-production"
routes = [{ pattern = "secrets.your-company.com", custom_domain = true }]

hyperdrive = [{ binding = "HYPERDRIVE", id = "<your hyperdrive id>" }]

[env.production.vars]
XECRET_ENV = "production"
XECRET_PUBLIC_URL = "https://secrets.your-company.com"
WORKOS_CLIENT_ID = "<your WorkOS Production client id>"
# …the rest as shipped

[[env.production.secrets_store_secrets]]
binding = "XECRET_ROOT_KEYS"
store_id = "<your secrets store id>"
secret_name = "XECRET_ROOT_KEYS"
```

The ids are not credentials — they are useless to anyone without an API token
for the account that owns them, which is why they are committed at all. But
left as shipped, `wrangler deploy` authenticates as **you** and then addresses
resources belonging to **us**, and the failure reads like a permissions problem
rather than a copied config. The WorkOS client id is the same: left as shipped,
every sign-in goes to our WorkOS environment, which knows nothing of your
redirect URI and refuses it. If you also run a staging deployment or develop
locally, put your **Staging** client id in `[env.staging.vars]` and the
top-level `[vars]` the same way.

`XECRET_PUBLIC_URL` is read twice, and both readings matter:

- **During `next build`.** Every documentation and marketing page is
  prerendered, so its canonical URL, its `sitemap.xml` entry, the `Host` line in
  `robots.txt` and the JSON-LD `@id` are all written before the Worker exists.
  Left as shipped, your deployment tells every crawler that our site is the
  canonical version of your pages.
- **At runtime, by the Worker.** It is what the `Origin` header on every
  mutation is compared against — deliberately, rather than the request's own
  `Host`, so that an attacker who can reach the Worker cannot choose the value
  the check uses. It is also the base of the links in invitation and PIN-reset
  emails, and of the sign-in redirect URI. Left as shipped, mutations from your
  own dashboard are rejected as cross-site, the invitation you send a colleague
  points at a server you do not control, and AuthKit is asked to send people
  back to a callback your WorkOS environment does not list.

The two are kept identical by construction: the deploy script reads
`XECRET_PUBLIC_URL` out of this file and hands it to the build, so there is one
place to change and no second copy to forget.

### 5. Verify before deploying

```bash
npm run check:env      # states exactly what is missing or malformed
npm run smoke          # proves the whole stack against the real database
```

Run both. The config checker catches the missing binding you will otherwise
discover from a 503 in production.

### 6. Deploy

```bash
phase run -- sh scripts/deploy-web.sh production
```

The `phase run --` prefix is how *this* repository populates the deploy-time
environment; substitute Doppler, a CI secret block, or `set -a; . ./.env`. The
script does not care which.

It reads `XECRET_PUBLIC_URL` and `XECRET_ENV` out of `wrangler.toml` for the
environment you named, exports them into the build, and refuses to go on if
that environment declares no `WORKOS_CLIENT_ID` — the Worker reads it at runtime
and the build never does, so nothing else would notice it missing until every
sign-in failed. Then it prints what it resolved before it starts:

```
Building for production at https://secrets.your-company.com
  (from apps/web/wrangler.toml → env.production.vars — stop now if that is not your deployment)
  (signing in against WorkOS client client_… — its API key must be from the same WorkOS environment)
```

Read those lines. If they do not name your domain and your WorkOS client, step 4
has not been done, and everything after this point publishes somebody else's.

#### If you build without the script

Both variables have to be in the **build** environment, not only in the Worker's
bindings, for the reasons in step 4:

```bash
XECRET_PUBLIC_URL=https://secrets.your-company.com \
XECRET_ENV=production \
  npx opennextjs-cloudflare build --env production

npx opennextjs-cloudflare deploy --env production
```

Set `XECRET_ENV` even though it looks redundant beside `--env production`. Two
things make it load-bearing. `--env` puts nothing into the build's *environment*
— it selects which environment's `compatibility_date` and `assets` settings the
adapter reads, and none of that reaches `next build`. And the build only
*refuses* to guess an origin when `XECRET_ENV` names a deployment: with
`XECRET_ENV` unset it does not error at all, it quietly falls back to
`http://localhost:3030` and writes that into the canonical URL of every page it
prerenders. `XECRET_ENV` is what converts that silent wrong answer into a build
failure, which is the only reason to type it.

### 7. Point clients at it

```bash
xecret login --api-url https://secrets.your-company.com
```

The URL is stored with the credential. In CI, set `XECRET_API_URL` beside
`XECRET_TOKEN`. See [configuration](cli/configuration.md).

## What you are now operating

- **Backups.** The database holds only ciphertext; a backup without the root
  key escrow is a paperweight. Test restore of **both**.
- **Migrations.** Generated SQL, committed and reviewed, applied with
  `npm run db:migrate`. Never auto-applied on deploy.
- **The audit log.** Append-only and partitioned by quarter, with the child
  tables kept in the `audit_parts` schema. Migration 0010 pre-creates eight
  quarters, counting the current one, and nothing extends that automatically
  yet, so run this before the runway ends — once a quarter's rows land in the
  default partition, that quarter can no longer be given a real partition:

  ```sql
  SELECT create_audit_log_partition(d::date)
  FROM generate_series(
      date_trunc('quarter', now() AT TIME ZONE 'UTC'),
      date_trunc('quarter', (now() + interval '21 months') AT TIME ZONE 'UTC'),
      interval '3 months'
  ) AS d;
  ```

  Run it as the owner of the audit tables — it issues `CREATE TABLE` and
  `GRANT`, and the application role holds neither. It fills every quarter to the
  end of the runway, so it is idempotent and any cadence shorter than 21 months
  is safe. If any quarter in the range already has rows in the default
  partition, the whole statement aborts and no quarter is created — recover
  those first, oldest first, then re-run it.

  Recovering one is a single transaction, as the table owner, substituting that
  quarter's UTC bounds. Detaching is what makes the `CREATE TABLE` possible; the
  `DELETE` is what makes the re-attach possible; and no audit row is destroyed,
  because every one is written back through the parent before it is removed:

  ```sql
  BEGIN;

  ALTER TABLE public.audit_logs DETACH PARTITION audit_parts.audit_logs_default;

  SELECT create_audit_log_partition(DATE '2028-07-01');

  INSERT INTO public.audit_logs
  SELECT * FROM audit_parts.audit_logs_default
  WHERE created_at >= TIMESTAMPTZ '2028-07-01 00:00:00+00'
    AND created_at <  TIMESTAMPTZ '2028-10-01 00:00:00+00';

  DELETE FROM audit_parts.audit_logs_default
  WHERE created_at >= TIMESTAMPTZ '2028-07-01 00:00:00+00'
    AND created_at <  TIMESTAMPTZ '2028-10-01 00:00:00+00';

  ALTER TABLE public.audit_logs ATTACH PARTITION audit_parts.audit_logs_default DEFAULT;

  COMMIT;
  ```

  Do it in a maintenance window: `DETACH` takes `ACCESS EXCLUSIVE` on
  `public.audit_logs` and holds it to `COMMIT`, so audit writes block
  throughout, and a blocked audit write fails the request that produced it.

  That covers the case you are likely to meet. Two rarer ones — a partition left
  detached by an interrupted repair, and a partition attached over the wrong
  range because it was created from a non-UTC session — need a wider procedure,
  in `docs/operations/database-setup.md` in the repository. The migration names
  that file in the error it raises for each.
- **Mail, monitoring and error reporting.** Yours to wire. The log pipeline
  contains no secret values by construction, but where the logs go is your
  decision.
- **The identity provider.** Keep each WorkOS environment's redirect URI in step
  with `XECRET_PUBLIC_URL`. Rotate the API key in the WorkOS dashboard, then with
  `wrangler secret put`; rotating the cookie password costs only the sign-ins in
  flight at that moment. Signing out of xecret does not end somebody's AuthKit
  session, so a returning person may not be asked for a credential — which is
  why resetting a vault forces a fresh sign-in AuthKit cannot skip.
- **Key rotation.** Every layer of the hierarchy is versioned so it can be
  rotated independently. Have a runbook before you need one.

## The trust model you are accepting

Self-hosting does not change the encryption model — it changes who you are
trusting. Your deployment *can* decrypt the secrets it stores; that is what
makes team sharing, CI tokens and browser import work.

What moves is the trust: from us to your own Cloudflare account, your own
database, and your own key custody. Read
[what xecret can and cannot see](security/trust-model.md) before you accept
other people's production credentials into a deployment you operate.

## Licensing

The server is **AGPL-3.0**. The CLI is **MIT**.

In plain terms: run xecret yourself freely. If you modify the server and offer
it to others as a network service, publish your changes. The CLI is
unencumbered so it can live inside your Docker images and CI pipelines without
licence friction.

## Next

- [Trust model](security/trust-model.md) — the model you are taking on.
- [Configuration](cli/configuration.md) — pointing clients at your deployment.
- [The audit log](security/audit-log.md) — what your deployment records.
