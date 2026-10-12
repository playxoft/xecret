# Self-hosting xecret

xecret is AGPL-3.0 and designed to be run by people other than us. This page
is the honest version of what that takes — including the parts that are
friction — because a secrets manager that hides its operational costs is not
being honest about the one thing it sells.

## The dependency list, stated plainly

| Dependency | Role | Required? |
|---|---|---|
| **Cloudflare Workers (paid plan)** | Runs the web app and API (`@opennextjs/cloudflare`). The paid plan's CPU limits are assumed — see [ADR 0002](adr/0002-root-key-custody.md). | Yes |
| **PostgreSQL** (Neon recommended) | All data. Hyperdrive in front of it on Cloudflare; the Neon serverless HTTP driver is the fallback without Hyperdrive. | Yes |
| **Cloudflare Secrets Store** | Holds the runtime copy of the Root KEK, bound to the Worker. | Yes |
| **A WorkOS account** | Identity only — AuthKit's hosted pages handle password, Google, MFA and enterprise SSO sign-in. xecret exchanges the result once, server to server, and issues its own sessions ([ADR 0010](adr/0010-workos-as-identity-provider.md)). | Yes — and this is real friction. AuthKit is free up to a million monthly active users; enterprise SSO connections are billed by WorkOS. The `IdentityProvider` interface (`packages/core/src/auth/types.ts`) is where an alternative provider plugs in. |
| **A mail provider** (ZeptoMail wired; the `Mailer` interface is ~30 lines to swap) | PIN-reset links and invitation emails. | No — without it, invitations return a shareable link instead of sending mail, and PIN reset answers 200 with `sent: false` and a reason. |
| **Phase.dev** (or any secret source for deploy time) | Where *your* copy of the Root KEK lives between deploys. The Worker never calls it at runtime. | Your choice — any process that can populate deploy-time env vars works. |

## Before anything else: the root key

The Root KEK encrypts every organisation's keys, which encrypt every
environment's keys, which encrypt every secret. **If you lose it, every secret
is permanently unrecoverable — there is no support ticket that fixes this.**

1. Generate it, split it, and escrow the shares **before** the first real
   secret is stored:

   ```bash
   npm run keygen        # generates the KEK + 2-of-3 Shamir shares
   ```

2. Store the shares in physically separate places (a USB stick in a safe, a
   printed sheet, a second site). Never all digital, never all in one place.
3. Read [key recovery](security/key-recovery.md) — the ceremony, the restore
   drill, and the records to keep. It is short and it is the most important
   document in this repository.

## Deployment walk-through

1. **Database.** Create a PostgreSQL database and the restricted application
   role, then run migrations. [Database setup](operations/database-setup.md)
   covers Neon end to end, including the sharp edges.

   ```bash
   npm ci
   npm run db:migrate      # DATABASE_URL / MIGRATION_DATABASE_URL in the env
   ```

2. **WorkOS.** Create the account, register the redirect URI, and collect the
   client id, the API key and a cookie password — see
   [Create a WorkOS account and configure AuthKit](#create-a-workos-account-and-configure-authkit)
   below. Nothing about the identity provider is needed at build time.

3. **Cloudflare.** Create a Hyperdrive binding for the database, the
   rate-limit bindings, and a Secrets Store entry holding the Root KEK. There is
   no KV namespace to create. `apps/web/wrangler.toml` names every binding the
   code expects; `.env.example` names every variable. Put the two WorkOS
   secrets on the Worker for each environment:

   ```bash
   npx wrangler secret put WORKOS_API_KEY --env production
   npx wrangler secret put WORKOS_COOKIE_PASSWORD --env production
   ```

4. **Your own origin, and your own resource ids.** `apps/web/wrangler.toml` is
   committed and everything account-specific in it is *ours*. Before deploying
   anything, replace:

   - `env.production.routes[].pattern` and `env.production.vars.XECRET_PUBLIC_URL`
     with your deployment's origin;
   - the `hyperdrive` binding `id` and the `secrets_store_secrets` `store_id`
     with the ones step 3 just created;
   - `env.production.vars.WORKOS_CLIENT_ID` with your WorkOS **Production**
     environment's client id, and the top-level `[vars]` and `env.staging.vars`
     ones with your **Staging** environment's.

   None of the ids are credentials — they are useless without an API token for
   our account — but left as shipped, `wrangler deploy` authenticates as *you*
   and then addresses resources that are not yours, which fails in ways that
   read like a permissions problem rather than a copied config. Nothing below
   checks any of this for you.

   `XECRET_PUBLIC_URL` is read twice. `next build` writes it into the canonical
   URL of every prerendered page, the `sitemap.xml`, the `Host` line in
   `robots.txt` and the JSON-LD `@id`; the Worker compares the `Origin` header
   on every mutation against it, builds invitation and PIN-reset links on top of
   it, and derives the sign-in redirect URI from it. Left as shipped, your
   deployment names our site as the canonical version of your pages, rejects your
   own dashboard's writes as cross-site, emails your colleagues invitation links
   to a server you do not control, and sends AuthKit a redirect URI your WorkOS
   environment does not list. The deploy script reads it out of this file and
   hands it to the build, so this is the one place it is stated.

5. **Verify before deploying.** The config checker states exactly what is
   missing or malformed, and the smoke test proves the whole stack against the
   real database:

   ```bash
   npm run check:env
   npm run smoke
   ```

6. **Deploy.** The script reads `XECRET_PUBLIC_URL` and `XECRET_ENV` out of
   `apps/web/wrangler.toml` for the environment named, exports them into the
   build — they have to be in the *build* environment, not only in the Worker's
   bindings, because the prerendered pages are written before a binding exists —
   and prints the origin it resolved before it starts. Read that line; if it is
   not your domain, step 4 has not been done.

   ```bash
   phase run -- sh scripts/deploy-web.sh production
   ```

   The `phase run --` prefix is how *this* repository populates the deploy-time
   environment; substitute Doppler, a CI secret block or a sourced `.env`. What
   the script insists on is that `apps/web/wrangler.toml` declares a
   `WORKOS_CLIENT_ID` (a `client_…` value) for the environment being deployed,
   and it stops without one: the Worker reads it at runtime and the build never
   does, so nothing else would notice it missing until every sign-in answered
   503.

   Building by hand instead means setting both yourself:

   ```bash
   XECRET_PUBLIC_URL=https://secrets.your-company.com \
   XECRET_ENV=production \
     npx opennextjs-cloudflare build --env production

   npx opennextjs-cloudflare deploy --env production
   ```

   `XECRET_ENV` is not redundant beside `--env production`, for two reasons.
   `--env` puts nothing into the build's *environment*; it selects which
   environment's `compatibility_date` and `assets` settings the adapter reads,
   and none of that reaches `next build`. And the build refuses to guess an
   origin *only* when `XECRET_ENV` names a deployment — with it unset the build
   succeeds quietly and bakes `http://localhost:3030` into every canonical it
   writes. Setting it is what turns that into a build failure.

7. **CLI.** Point clients at your deployment: `xecret login --api-url
   https://secrets.your-company.com` (stored with the credential thereafter),
   or `XECRET_API_URL` beside `XECRET_TOKEN` in CI.

## Create a WorkOS account and configure AuthKit

xecret sends people to WorkOS AuthKit's hosted pages to sign in, exchanges the
authorization code AuthKit hands back once, server to server, and from then on
uses its own session. WorkOS is asked nothing else except for the vault reset's
emailed code. Everything below happens in the WorkOS dashboard.

**Environments.** A WorkOS account has a **Staging** and a **Production**
environment, and they share nothing — not users, not keys. Use Staging for local
development and any staging deployment, Production for production. Every value
below comes from the environment the deployment signs people in against: a key
from one and a client id from the other fails every sign-in in a way that reads
like a code bug and is not.

**Keep each environment's database to itself.** Never point a deployment that
signs in through Staging — local development included — at a database whose
accounts sign in through Production. The first local sign-in with an existing
person's address links their account to a *Staging* WorkOS user, and from then
on their real sign-in is refused as a conflict until somebody repairs the row by
hand. If you cannot be sure the databases are separate, test sign-in locally
only with a brand-new address, or on the deployed site.

**Redirect URI.** Register exactly `<XECRET_PUBLIC_URL>/api/auth/callback` —
`https://secrets.your-company.com/api/auth/callback` in Production, and
`http://localhost:3030/api/auth/callback` in Staging for local development.
xecret derives it from `XECRET_PUBLIC_URL` at runtime and it is configured
nowhere else, so it cannot drift from the origin; it can only disagree with the
dashboard, which AuthKit answers by refusing the redirect.

**Sign-in endpoint.** Set it to `<XECRET_PUBLIC_URL>/api/auth/login`. When
AuthKit needs xecret to *start* a sign-in rather than finish one, it sends the
browser there. A callback xecret did not start itself is refused as expired,
because there is no state cookie in the browser to match it.

**Authentication methods.** Enable email and password, and Google. In Staging
WorkOS can use its own demonstration Google credentials; in **Production**,
Google sign-in needs your own OAuth client — create it in the Google Cloud
Console, add the redirect URI WorkOS shows you to it, and enter its client id
and secret in WorkOS. MFA and enterprise SSO are WorkOS settings too; xecret
needs no change for either. MFA is recommended for organisation owners, for the
reason under Magic Auth, next.

**Magic Auth.** Enable it, and leave WorkOS's default Magic Auth email on. The
vault reset's second check is a one-time code that WorkOS creates and emails,
and WorkOS refuses to create one at all while Magic Auth is disabled — so with
it off, nobody on the deployment can reset a vault. Enabling it also offers
"email me a code" as a way to sign in. That is a sign-in like any other, but it
never counts as the vault reset's first check, which needs a credential: a
password, a passkey, Google or SSO. Without MFA, somebody who controls a
person's inbox can still pass both checks by resetting the password first; MFA
on the account closes that.

**Email verification.** AuthKit verifies every email address before it hands
a sign-in back, and at the time of writing there is no switch to turn that off.
xecret depends on it: the first time somebody signs in, an existing account
holding the same *verified* address is adopted, and an unverified address is
refused. If WorkOS ever adds such a switch, it must stay on in both
environments.

**Credentials.** Three values per environment:

| Variable | What it is | Where it goes |
|---|---|---|
| `WORKOS_CLIENT_ID` | The environment's client id, `client_…`. Not a secret — it is in every authorization URL a browser is sent to. | `apps/web/wrangler.toml`: `[env.production.vars]` for Production, `[env.staging.vars]` and the top-level `[vars]` (local development) for Staging. |
| `WORKOS_API_KEY` | The environment's secret API key. It authenticates every call xecret makes to WorkOS, including the exchange that decides who a sign-in is. Do not judge which environment a key belongs to by its prefix — check where you copied it from. | A Worker secret (`wrangler secret put`), from your deploy-time secret source. Never in `wrangler.toml`. |
| `WORKOS_COOKIE_PASSWORD` | At least 32 random characters — `openssl rand -base64 32` — that key the signed state cookie binding a sign-in to the browser that started it. Independent of the API key; whoever holds it can complete a sign-in in somebody else's browser. | A Worker secret, the same way. |

Without any of the three, nobody can sign in, and the sign-in routes answer 503
rather than guess. `npm run check:env` reports any of them missing; that the key
and the client id come from the same environment is something only a sign-in
proves.

**What it costs, and the way out.** AuthKit is free up to a million monthly
active users; enterprise SSO connections are billed by WorkOS. If you would
rather have no WorkOS account at all, the `IdentityProvider` interface in
`packages/core/src/auth/types.ts` is the seam: a provider needs an authorization
endpoint that redirects back with a code, and an `exchangeCode` that turns the
code into an identity. Sessions, authorization, crypto and the API do not
change; the linking pass and its `users.workos_user_id` column are WorkOS's
today, so a second provider needs its own.

## What you are operating

- **Backups:** the database holds only ciphertext; a backup without the Root
  KEK escrow is a paperweight. Test restore of *both* — the drill in
  [key recovery](security/key-recovery.md) exists to be run, quarterly.
- **Migrations:** generated SQL, committed and reviewed, applied with
  `npm run db:migrate`. Never auto-applied on deploy.
- **The audit log** is append-only and partitioned by quarter, with the child
  tables in the `audit_parts` schema. Migration 0010 pre-creates eight
  quarters, counting the current one, and nothing extends that automatically
  yet. Run this before the runway ends, or writes fall into the default
  partition — and a quarter with rows in the default partition can no longer be
  given a real one:

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
  end of the runway, not just the last one, so it is idempotent and any cadence
  shorter than 21 months is safe. Extending only the far quarter would leave the
  ones in between permanently uncoverable. The procedure, and the recovery for a
  quarter whose rows reached the default partition first, are in
  [database setup](operations/database-setup.md).
- **The identity provider.** Keep each WorkOS environment's redirect URI in step
  with `XECRET_PUBLIC_URL`. Rotate `WORKOS_API_KEY` in the WorkOS dashboard and
  then with `wrangler secret put`. Rotating `WORKOS_COOKIE_PASSWORD` costs only
  the sign-ins in flight at that moment, whose state cookies stop verifying.
  Logging out of xecret does not end the person's AuthKit session, so a
  returning person may not be asked for a credential; that is accepted, and is
  why the vault reset forces a fresh sign-in that AuthKit cannot skip.
- **Mail, monitoring, error reporting** are yours to wire; the log pipeline
  never contains secret values by construction, but where the logs go is your
  decision.

## The trust model you are accepting

Server-side envelope encryption: your deployment *can* decrypt the secrets it
stores — that is what makes team sharing, CI tokens and browser import work.
Self-hosting moves the trust from us to your own Cloudflare account, database
and key custody. Read [ADR 0001](adr/0001-trust-model.md) and the
[threat model](security/threat-model.md) before you accept other people's
production credentials into a deployment you operate.
