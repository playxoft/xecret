# Database setup (Neon)

How to get from a fresh Neon project to the two connection strings xecret needs.

**There is one database.** Two connection strings, two roles, one database. `MIGRATION_DATABASE_URL`
logs in as the owner and is used exactly once per deploy, by `npm run db:migrate`. `DATABASE_URL`
logs in as a restricted role and is what the application uses for every request. See
`packages/db/migrations/0002_least_privilege_grants.sql` for what the restriction buys.

---

## 1. Create the project

In the Neon console: **New Project**. Pick the region closest to where your Cloudflare Worker
will run.

Neon gives you a database (`neondb` by default) and an owner role (`neondb_owner` by default),
plus a connection string that looks like:

```
postgresql://neondb_owner:PASSWORD@ep-cool-name-12345.us-east-2.aws.neon.tech/neondb?sslmode=require
```

That is your **`MIGRATION_DATABASE_URL`**. Put it in Phase.dev and nowhere else.

> **Pooled vs direct.** Neon offers a pooled endpoint (the host contains `-pooler`) and a direct
> one. Use the **direct** endpoint for `MIGRATION_DATABASE_URL`: migrations run DDL and advisory
> locks, and a transaction-pooled connection is the wrong place for either.

---

## 2. Run the migrations

All commands run from the **repository root**, never from `apps/web`. The root `db:*` scripts
delegate to `@xecret/db`, which is where the migrations and the Drizzle config live.

First time only, connect the repo to your Phase.dev app:

```bash
phase init
```

Then:

```bash
phase run -- npm run db:migrate
```

`phase run --` is what supplies the environment; the script itself reads plain environment
variables and has no idea Phase.dev exists. That is deliberate — a self-hoster using Doppler, a
`.env` file, or their platform's own secret store runs the identical command without `phase run`,
and CI does the same. Hardcoding `phase run` into `package.json` would couple an open-source
project to one vendor for no gain.

The script prefers `MIGRATION_DATABASE_URL` and falls back to `DATABASE_URL`. If neither is set it
exits with a message naming both.

This creates the 18 tables, partitions `audit_logs` by quarter into the `audit_parts` schema, and
creates the **`xecret_app_permissions` role** with its grants.

`xecret_app_permissions` is deliberately **`NOLOGIN`**. It is a *group* role: it holds privileges and nothing
else. You cannot connect as it, and that is the point — see step 3.

---

## 3. Create the login role the application uses

`xecret_app_permissions` cannot log in, so the application connects as a separate login role that is a
*member* of it and inherits its privileges.

This indirection is worth one extra step:

- **The credential and the privileges are separate things.** Rotating the application's password
  is `ALTER ROLE ... PASSWORD`, and it touches no grants. Revoking a privilege is a `REVOKE` on
  `xecret_app_permissions`, and it touches no credential.
- **You can run more than one.** A read-only analytics connection, or a second application
  instance with its own rotatable credential, is another member — not another copy of the grants,
  which would drift.

**`xecret_app_login` below is just a name.** Call it whatever you like — what matters is that it is a
LOGIN role and a member of `xecret_app_permissions`. If you already created a role in the Neon console, use
that name and skip the `CREATE ROLE` line (but do read the warning underneath).

Run this **as the owner**, against your database. Use the Neon SQL Editor, or `psql` with
`MIGRATION_DATABASE_URL`. It must run **after** step 2, because step 2 is what creates
`xecret_app_permissions`:

```sql
-- Pick a long random password. Generate one, do not invent one:
--   openssl rand -base64 32
CREATE ROLE xecret_app_login LOGIN PASSWORD 'PASTE_A_LONG_RANDOM_PASSWORD';

-- Inherit everything xecret_app_permissions is allowed to do, and nothing else.
GRANT xecret_app_permissions TO xecret_app_login;
```

> ### A console-created role cannot be repaired. Delete it.
>
> Neon grants roles created through its console UI the `neon_superuser` role, which hands the
> application exactly the privileges this migration exists to withhold.
>
> **You cannot strip it.** `neon_superuser` is granted by a Neon-managed role you have no ADMIN
> OPTION on, so revoking it fails:
>
> ```
> ERROR: permission denied to revoke role "neon_superuser" (SQLSTATE 42501)
> ```
>
> Check first — if this returns anything other than `xecret_app_permissions`, the role is unusable as an
> application login:
>
> ```sql
> SELECT r.rolname FROM pg_auth_members m
> JOIN pg_roles r ON r.oid = m.roleid
> JOIN pg_roles u ON u.oid = m.member
> WHERE u.rolname = 'your_role_name';
> ```
>
> The fix is to **delete the role in the Neon console** — the same screen that created it — and
> create a replacement with the `CREATE ROLE` statement above. A role created by SQL gets no
> `neon_superuser`, which is the entire reason to create it this way.

Your **`DATABASE_URL`** is then the same connection string as step 1, with the user and password
swapped:

```
postgresql://xecret_app_login:THAT_PASSWORD@ep-cool-name-12345.us-east-2.aws.neon.tech/neondb?sslmode=require
```

> **Pooled vs direct, again.** For local development, either works. For the deployed Worker this
> string goes into **Hyperdrive**, which does its own connection pooling — so give Hyperdrive the
> **direct** endpoint and let it pool. Pointing a pooler at a pooler is not an optimisation.

---

## 4. Point Hyperdrive at it

```bash
npx wrangler hyperdrive create xecret-db --connection-string="$DATABASE_URL"
```

Put the returned id into `apps/web/wrangler.toml` and uncomment the `hyperdrive` binding. In a
deployed Worker, `DATABASE_URL` is then unused — the binding supplies the connection string, and
`connectionString()` in `apps/web/src/server/bindings.ts` prefers it.

---

## 5. Verify the restriction is real

Do not take the migration's word for it. Connect **as `xecret_app_login`** and confirm it cannot do the
things it must not do:

```sql
-- Should FAIL: the application role has no DDL rights.
CREATE TABLE should_not_exist (id int);

-- Should FAIL: audit_logs is append-only by grant, not by convention.
DELETE FROM audit_logs;
UPDATE audit_logs SET action = 'nope';

-- Should SUCCEED: ordinary application work.
SELECT count(*) FROM organizations;
```

And confirm the role did not pick up privileges from somewhere else:

```sql
SELECT r.rolname AS granted_role
FROM pg_auth_members m
JOIN pg_roles r ON r.oid = m.roleid
JOIN pg_roles u ON u.oid = m.member
WHERE u.rolname = 'xecret_app_login';
```

The only row should be `xecret_app_permissions`. **If `neon_superuser` appears, the role was created through
the console** and has far more power than intended — drop it and recreate it with the SQL above.

If `CREATE TABLE` succeeds, stop and fix it before storing a real secret. A least-privilege role
that turns out not to be least-privilege is worse than none, because it is documented as a control
people will rely on.

---

## Known sharp edges

**A new table in a future migration needs an explicit grant.** Migration 0002 lists the tenant
tables by name, and nothing grants anything on a table added later. Migration 0010 revoked the
`ALTER DEFAULT PRIVILEGES` rule in `public` that used to paper over this — it existed only to cover
audit partitions, which now live in `audit_parts` and are granted explicitly by
`create_audit_log_partition()`. So a migration that adds an ordinary table and forgets its `GRANT`
now fails loudly on first use rather than half-working with read-and-insert but no update-or-delete.
Any migration adding a table must add its own `GRANT`.

**`CREATE ROLE` may need the account owner.** On some managed providers role creation is
restricted. If migration 0002 fails on `CREATE ROLE`, create `xecret_app_permissions` through the provider's
console and re-run — the `GRANT` statements are idempotent.

**None of this has been run against a live Neon instance yet.** The SQL is standard PostgreSQL and
the grants are tested by shape, but the first person to follow this document is also the first
person to test it. If a step does not behave as written, that is a bug in this document — report
it.
