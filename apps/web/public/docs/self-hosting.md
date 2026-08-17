---
title: Self-hosting xecret
navTitle: Self-hosting
description: Run xecret yourself — the honest dependency list, the root-key ceremony, a step-by-step deployment, and what you are signing up to operate.
keywords: [self host secret manager, cloudflare workers deployment, open source secrets manager, agpl, neon postgres, root key]
updated: 2026-08-17
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
| **A Firebase project** | Identity only — Google and email/password sign-in. xecret issues its own sessions; the Firebase admin SDK never runs anywhere. | Yes, and **this is real friction**. An identity-provider interface exists so a Postgres-native provider can be contributed. |
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

### 2. Identity

Create a Firebase project, enable Google and email/password sign-in, and add
your domain to the authorised domains. Put the **client** config JSON in
`NEXT_PUBLIC_FIREBASE_CONFIG` and the project id in the server configuration.

Firebase is used for identity only. It verifies who somebody is, exactly once,
at sign-in; every session after that is xecret's own.

### 3. Cloudflare

Create:

- a **Hyperdrive** binding for the database (pointed at the *direct* endpoint —
  Hyperdrive pools, so a pooling endpoint must not be used underneath it);
- a **KV namespace** for the identity provider's signing keys, so token
  verification costs no outbound request;
- the **rate-limit** bindings;
- a **Secrets Store** entry holding the root key.

The repository's `wrangler.jsonc` names every binding the code expects, and
`.env.example` names every variable.

### 4. Tell the deployment its own origin

`apps/web/wrangler.jsonc` is committed to the repository, and the domain in it
is **ours**. Nothing you have done so far has changed it, and nothing later on
this page checks it for you — an origin is a fact about your deployment that
only you know. Edit it now, before the first deploy:

```jsonc
"env": {
  "production": {
    "routes": [{ "pattern": "secrets.your-company.com", "custom_domain": true }],
    "vars": {
      "XECRET_ENV": "production",
      "XECRET_PUBLIC_URL": "https://secrets.your-company.com",
      // …the rest as shipped
    },
  },
},
```

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
  emails. Left as shipped, mutations from your own dashboard are rejected as
  cross-site, and the invitation you send a colleague points at a server you do
  not control.

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
script does not care which, but it does require that
`NEXT_PUBLIC_FIREBASE_CONFIG` is genuinely in the environment, and stops if it
is not. That check exists because the Content-Security-Policy's `frame-src` is
derived from that value while the bundle is built: a build that cannot see it
still succeeds and still deploys, and then blocks its own sign-in popup — with
an error that reads like a network outage.

The script then reads `XECRET_PUBLIC_URL` and `XECRET_ENV` out of
`wrangler.jsonc` for the environment you named, exports them into the build, and
prints them before it starts:

```
Building for production at https://secrets.your-company.com
  (from apps/web/wrangler.jsonc → env.production.vars — stop now if that is not your deployment)
```

Read that line. If it does not name your domain, step 4 has not been done, and
everything after this point publishes somebody else's.

#### If you build without the script

Both variables have to be in the **build** environment, not only in the Worker's
bindings, for the reasons in step 4:

```bash
NEXT_PUBLIC_FIREBASE_CONFIG='{"apiKey":"…","authDomain":"…"}' \
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
- **The audit log.** Append-only and partitioned by month, with partitions
  pre-created a year ahead. Revisit before that runway ends.
- **Mail, monitoring and error reporting.** Yours to wire. The log pipeline
  contains no secret values by construction, but where the logs go is your
  decision.
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
