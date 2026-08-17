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
| **A Firebase project** | Identity only — Google + email/password sign-in. xecret issues its own sessions; `firebase-admin` never runs anywhere ([ADR 0003](adr/0003-firebase-as-identity-provider.md)). | Yes — and this is real friction. The `IdentityProvider` interface exists so a Postgres-native provider can be contributed. |
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

2. **Firebase.** Create a project, enable Google and email/password sign-in,
   and add your domain to the authorised domains. Put the *client* config JSON
   in `NEXT_PUBLIC_FIREBASE_CONFIG` and the project id in the server config.

3. **Cloudflare.** Create a Hyperdrive binding for the database, a KV
   namespace (JWKS cache), the rate-limit bindings, and a Secrets Store entry
   holding the Root KEK. `apps/web/wrangler.jsonc` names every binding the
   code expects; `.env.example` names every variable.

4. **Verify before deploying.** The config checker states exactly what is
   missing or malformed, and the smoke test proves the whole stack against the
   real database:

   ```bash
   npm run check:env
   npm run smoke
   ```

5. **Deploy.** `XECRET_PUBLIC_URL` and `XECRET_ENV` have to be in the *build*
   environment, not only in the Worker's bindings: the documentation pages are
   prerendered, so their canonical URLs, sitemap entries and `robots.txt` `Host`
   line are written during the build, and a build that is not told its own
   origin refuses rather than guesses. The deploy script reads both out of
   `apps/web/wrangler.jsonc` for the environment being deployed.

   ```bash
   sh scripts/deploy-web.sh production
   ```

6. **CLI.** Point clients at your deployment: `xecret login --api-url
   https://secrets.your-company.com` (stored with the credential thereafter),
   or `XECRET_API_URL` beside `XECRET_TOKEN` in CI.

## What you are operating

- **Backups:** the database holds only ciphertext; a backup without the Root
  KEK escrow is a paperweight. Test restore of *both* — the drill in
  [key recovery](security/key-recovery.md) exists to be run, quarterly.
- **Migrations:** generated SQL, committed and reviewed, applied with
  `npm run db:migrate`. Never auto-applied on deploy.
- **The audit log** is append-only and partitioned by month; partitions are
  pre-created a year ahead by migration 0001. Revisit before the runway ends.
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
