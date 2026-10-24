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
| **A WorkOS account** | Identity only — AuthKit's hosted pages handle password, Google, MFA and enterprise SSO sign-in (though SSO connections cannot be configured from xecret yet — see below). xecret exchanges the result once, server to server, and issues its own sessions ([ADR 0010](adr/0010-workos-as-identity-provider.md)). | Yes — and this is real friction. AuthKit is free up to a million monthly active users; enterprise SSO connections are billed by WorkOS. The `IdentityProvider` interface (`packages/core/src/auth/types.ts`) is where an alternative provider plugs in. |
| **A mail provider** (ZeptoMail wired; the `Mailer` interface is ~30 lines to swap) | PIN-reset links, invitation emails, and the escape archive emailed before every vault reset (P23). | **Yes, for a production deployment** (`XECRET_ENV=production`): without one, every vault reset is refused with a 503 — a vault is never reset without its archive being emailed first — and `check:deploy production` fails. Elsewhere optional: invitations return a shareable link instead, PIN reset answers 200 with `sent: false` and a reason, and a vault resets only when the person ticks "Reset without the emailed archive". |
| **Phase.dev** (or any secret source for deploy time) | Where *your* copy of the Root KEK lives between deploys. The Worker never calls it at runtime. | Your choice — any process that can populate deploy-time env vars works. |
| **Dodo Payments** | Taking payment for plans — xecret's hosted service charges through it. | **No.** Leave every `DODO_*` variable unset and payments are switched off: plans are whatever `npm run plan:set` writes (every capability is yours to grant), the billing screen says the installation takes no payments, and nothing else changes. Set *some* of them and the deployment refuses billing with a 503 until all are set — see [billing](operations/billing.md). |

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
   real database. Both read the variables from their own environment, so run
   them under the environment you are about to deploy — with this repository's
   Phase.dev setup, that means naming it, because `.phase.json` defaults to
   `Development`:

   ```bash
   phase run --env Production -- npm run check:env
   phase run --env Production -- npm run smoke
   ```

   Without Phase, export the deployment's variables into the shell first (for
   example `set -a; . ./.env; set +a`), then run `npm run check:env` and
   `npm run smoke`. A bare `npm run check:env` in a shell holding nothing
   reports every variable as not set.

   When the WorkOS values are set, `check:env` makes one network call: it
   presents WorkOS's authenticate endpoint with a deliberately bogus
   authorization code, the client id and the API key. `invalid_grant` means
   WorkOS accepted the two together and refused only the code, so they belong
   to the same WorkOS environment; `invalid_client` or a 401 means they do not.
   Nothing is inferred from the key's prefix. `npm run check:env -- --offline`
   skips the call.

6. **Deploy.** The script reads `XECRET_PUBLIC_URL` and `XECRET_ENV` out of
   `apps/web/wrangler.toml` for the environment named, exports them into the
   build — they have to be in the *build* environment, not only in the Worker's
   bindings, because the prerendered pages are written before a binding exists —
   and prints the origin it resolved before it starts. Read that line; if it is
   not your domain, step 4 has not been done.

   ```bash
   phase run --env Production -- sh scripts/deploy-web.sh production
   ```

   The `phase run --env Production --` prefix is how *this* repository
   populates the deploy-time environment, naming the same Phase environment the
   checks in step 5 ran under; substitute Doppler, a CI secret block or a
   sourced `.env`. What the script insists on is that `apps/web/wrangler.toml`
   declares a `WORKOS_CLIENT_ID` (a `client_…` value) for the environment being
   deployed, and it stops without one: the Worker reads it at runtime and the
   build never does, so nothing else would notice it missing until every
   sign-in ended on the sign-in page's "unavailable" error.

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

**Sign-out redirect.** Add `<XECRET_PUBLIC_URL>/sign-in` as a logout redirect,
in each WorkOS environment you use, **before** deploying. Signing out of xecret
also ends the person's AuthKit session — the dashboard follows WorkOS's logout
URL for it — and WorkOS sends the browser back only to a redirect it knows.
What it does with one it does not know — its default redirect, or an error page
— is for you to verify on Staging, not to assume; configured first, it never
matters. Declining a held-back sign-in ("This isn't me") ends that sign-in's
AuthKit session the same way and returns to
`<XECRET_PUBLIC_URL>/sign-in?error=declined`, so allow that too if your WorkOS
environment matches redirects exactly. The checks worth making on Staging are in
[WorkOS environments and the organisation link](operations/workos-environments.md),
§4.

**Authentication methods.** Enable email and password, and Google. In Staging
WorkOS can use its own demonstration Google credentials; in **Production**,
Google sign-in needs your own OAuth client — create it in the Google Cloud
Console, add the redirect URI WorkOS shows you to it, and enter its client id
and secret in WorkOS.

MFA is a WorkOS setting, and recommended for organisation owners, for the
reasons under Magic Auth, next. With an authenticator app enrolled, resetting a
vault also asks for its code.

**Enterprise SSO** is set up per organisation, by its owner, in Organisation
settings → Single sign-on: turning it on creates the WorkOS organisation, and the
setup portal is where the customer's IT admin connects their identity provider
and verifies domains. It needs the organisation's single sign-on add-on
(`npm run plan:set -- --org <slug> --addon saml --on`), and an SSO sign-in is
believed only for the domains its WorkOS organisation has verified. A connection
made directly in the WorkOS dashboard is not tied to any xecret organisation, so
nobody is admitted to one through it.

**The WorkOS environment, recorded once — a step a self-hosted deployment must
not skip.** Migration 0023 creates a one-row table, `workos_home`, holding the
one WorkOS client id whose organisation ids this database's links may hold, and
**seeds it with the Playxoft production environment's**, because that is the
database it runs against first. Turning SSO on — and opening the setup portal,
and switching an SSO policy on — refuses (409, saying why) from any deployment
whose `WORKOS_CLIENT_ID` is not the one recorded, so that a deployment running
against another WorkOS environment can never write a link no sign-in in the
database's own environment could come through. On your database, record your
**Production** client id, as the database owner (the application role may only
read the table):

```sql
UPDATE workos_home SET client_id = '<your Production WORKOS_CLIENT_ID>';
-- or, if the row was deleted:
INSERT INTO workos_home (id, client_id) VALUES (true, '<your Production WORKOS_CLIENT_ID>');
```

`check:env` does not read the database, so it cannot tell you this is undone.
Until it is, the table still names Playxoft's environment, so the first owner to
press "Turn on single sign-on" is refused (409) as if from another WorkOS
environment's deployment, with a message — and a warning in the log, beside the
client id recorded and this deployment's — that names the `UPDATE` above and
this section. (On a database where the row is missing, the refusal says no
environment is recorded, and points here too.) Nothing else reads the table.
To undo a link written from the wrong environment, see
[WorkOS environments and the organisation link](operations/workos-environments.md).

**Magic Auth.** Enable it, and leave WorkOS's default Magic Auth email on. The
vault reset's second check is a one-time code that WorkOS creates and emails,
and WorkOS refuses to create one at all while Magic Auth is disabled — so with
it off, nobody on the deployment can reset a vault. Enabling it also offers
"email me a code" as a way to sign in. That is a sign-in like any other, but it
never counts as the vault reset's first check, which counts only a password, a
passkey, Google or SSO sign-in — no other OAuth provider. (It does count as the
fresh sign-in an owner needs before opening the SSO setup portal, which has no
second, emailed check to collide with.)

Know what the two checks do not stop. The first asks AuthKit to demand the
credential again (`max_age=0`), which WorkOS documents only for AuthKit's own
sign-in: it does not make Google or an identity provider ask again, so for a
Google or SSO account a live session there passes the first check silently, and
somebody at an unlocked laptop with that session and the person's inbox open
passes both. Without MFA, somebody who controls a person's inbox alone can also
pass both, by resetting the password first. And a reset is not only
destructive: whoever does it sets up a new vault on the account, which can read
its server-mode environments and prompts teammates to re-share the
end-to-end-encrypted ones. An authenticator app enrolled in WorkOS is the
defence — with one, the emailed code alone is not enough. That path is tested
against WorkOS's documented behaviour; it has not yet been exercised against a
WorkOS environment with MFA turned on.

**Email verification.** AuthKit verifies every email address before it hands
a sign-in back, and at the time of writing there is no switch to turn that off.
xecret depends on it: the first time somebody signs in, an existing account
holding the same *verified* address is adopted, and an unverified address is
refused. If WorkOS ever adds such a switch, it must stay on in both
environments.

**Credentials.** Three values per environment:

| Variable | What it is | Where it goes |
|---|---|---|
| `WORKOS_CLIENT_ID` | The environment's client id, `client_…`. Not a secret — it is in every authorization URL a browser is sent to. | `apps/web/wrangler.toml`: `[env.production.vars]` for Production, `[env.staging.vars]` and the top-level `[vars]` (local development) for Staging. Also in your deploy-time secret source, because `check:env` reads it from the environment and `check:deploy` compares that copy with `wrangler.toml`'s. |
| `WORKOS_API_KEY` | The environment's secret API key. It authenticates every call xecret makes to WorkOS, including the exchange that decides who a sign-in is. Do not judge which environment a key belongs to by its prefix — check where you copied it from. | A Worker secret (`wrangler secret put`), from your deploy-time secret source. Never in `wrangler.toml`. |
| `WORKOS_COOKIE_PASSWORD` | At least 32 random characters — `openssl rand -base64 32` — that key the signed state cookie binding a sign-in to the browser that started it. Independent of the API key; whoever holds it can complete a sign-in in somebody else's browser. | A Worker secret, the same way. |

Without any of the three, nobody can sign in, and both sign-in routes say so by
sending the browser to the sign-in page's "unavailable" error
(`/sign-in?error=unavailable`) rather than guess. `check:env` (step 5) reports
any of them missing or malformed, and asks WorkOS whether the key and the client
id belong together. `npm run check:deploy <env>` compares the `WORKOS_CLIENT_ID`
in your secret source with the one `wrangler.toml` declares for that
environment. A real sign-in on the deployed site is still the final proof.

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
  returning person may not be asked for a credential; that is accepted. The
  vault reset asks AuthKit for a fresh sign-in (`max_age=0`) and counts it only
  if the access token WorkOS returns shows an authentication during that flow
  (its `auth_time`), but that does not reach a Google or identity-provider
  session, which WorkOS treats as a fresh authentication — see Magic Auth,
  above.
- **Mail, monitoring, error reporting** are yours to wire; the log pipeline
  never contains secret values by construction, but where the logs go is your
  decision.
- **Webhook egress.** A webhook is a URL an organisation admin types and the
  server then fetches. `checkWebhookUrl` (`packages/core/src/webhooks/url.ts`)
  refuses `http`, credentials in the URL, local names, and every private,
  loopback, link-local, site-local, unique-local, CGNAT, multicast, reserved and
  transition-mechanism IP literal (v4-mapped, SIIT, NAT64, 6to4, Teredo), at
  save and again before every attempt, and redirects are never followed. What
  it cannot do is resolve DNS: a public name whose address is private — or is
  made private after the URL was saved (DNS rebinding) — passes it. **On
  Cloudflare Workers that is closed by the platform**, because a Worker's
  `fetch` has no route into a private network or to a metadata endpoint. **If
  you run this code anywhere else** — Node, a container, a VM — it is open:
  the server would POST to whatever the name resolves to from inside your
  network. Put an egress control in front of it that judges the address
  *after* resolution — a forward proxy that refuses private destinations
  (Smokescreen is one), or a network policy that denies the application
  private, link-local and metadata egress (`169.254.169.254`, `fd00:ec2::254`)
  — and, until you have one, do not create webhook endpoints.

## The trust model you are accepting

Server-side envelope encryption: your deployment *can* decrypt the secrets it
stores — that is what makes team sharing, CI tokens and browser import work.
Self-hosting moves the trust from us to your own Cloudflare account, database
and key custody. Read [ADR 0001](adr/0001-trust-model.md) and the
[threat model](security/threat-model.md) before you accept other people's
production credentials into a deployment you operate.
