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

## 6. Audit partition maintenance

`audit_logs` is partitioned by quarter, with the child tables in the `audit_parts` schema.
Migration 0010 pre-creates eight quarters. **Nothing extends that automatically.** When the runway
runs out, audit writes land in `audit_parts.audit_logs_default`, and a quarter with rows sitting in
the default partition can no longer be given a real partition — the `CREATE TABLE ... PARTITION OF`
fails, because the rows would violate the default partition's constraint.

Run this before the runway ends, **as the owner of the audit tables** — it issues `CREATE TABLE`
and `GRANT`, and the application role holds neither:

```sql
SELECT create_audit_log_partition(d::date)
FROM generate_series(
    date_trunc('quarter', now() AT TIME ZONE 'UTC'),
    date_trunc('quarter', (now() + interval '21 months') AT TIME ZONE 'UTC'),
    interval '3 months'
) AS d;
```

It fills every quarter from the current one to the end of the runway, not only the last one, and it
is idempotent — so the cadence does not matter as long as it is **shorter than 21 months**. The
statement always creates eight quarters, which reach between 21 and 24 months out depending on
where in the current quarter you run it; 21 is the bound you can rely on. Extending only the far
quarter — `create_audit_log_partition((now() + interval '21 months')::date)` on its own — is correct
only at an exactly quarterly cadence, and leaves permanently uncoverable gaps at any other.

`AT TIME ZONE 'UTC'` is not decoration. Partition bounds are UTC, and `date_trunc` on a
`timestamptz` resolves in the session's time zone, so without it a run near a quarter boundary picks
the wrong quarter.

If **any** quarter in that range already has rows in the default partition, the statement aborts as
a whole and no quarter is created — it is one statement, so it is one transaction. Recover each
affected quarter first, oldest first, then re-run the extension.

### Repairing the partitions

`create_audit_log_partition()` refuses rather than papering over three states, and one procedure
recovers all of them:

- a quarter whose rows are already in `audit_parts.audit_logs_default`, so its real partition can no
  longer be created;
- a partition left detached by an interrupted repair;
- a partition attached under the right name over the wrong range, because it was created from a
  session in a non-UTC time zone.

They share a cause, and it dictates the order. `CREATE TABLE ... PARTITION OF` and
`ATTACH PARTITION` both scan the default partition to prove the incoming range is free, and both
fail if it holds a single row belonging to that range. So the default partition comes out **first**,
before anything is created, and goes back **last**. Repairing one quarter at a time with the default
still attached is what fails, and it fails in exactly the case you are trying to repair.

As the table owner, in one transaction, substituting the partition names and quarters you actually
have:

```sql
BEGIN;

-- 1. The net comes out first. Skip if it is already detached.
ALTER TABLE public.audit_logs DETACH PARTITION audit_parts.audit_logs_default;

-- 2. Park every partition that is wrong — mis-bounded, or already detached.
--    Repeat per partition; the rename is what frees the name for step 3.
ALTER TABLE public.audit_logs DETACH PARTITION audit_parts.audit_logs_2028q3;
ALTER TABLE audit_parts.audit_logs_2028q3 RENAME TO audit_logs_2028q3_old;

-- 3. Create the runway, then a partition for every quarter with rows waiting.
SELECT create_audit_log_partition(d::date)
FROM generate_series(
    date_trunc('quarter', now() AT TIME ZONE 'UTC'),
    date_trunc('quarter', (now() + interval '21 months') AT TIME ZONE 'UTC'),
    interval '3 months'
) AS d;

SELECT create_audit_log_partition(q)
FROM (
    SELECT DISTINCT date_trunc('quarter', created_at AT TIME ZONE 'UTC')::date AS q
    FROM audit_parts.audit_logs_default
    UNION
    SELECT DISTINCT date_trunc('quarter', created_at AT TIME ZONE 'UTC')::date
    FROM audit_parts.audit_logs_2028q3_old
) s;

-- 4. Replay through the parent, which routes each row to its quarter.
INSERT INTO public.audit_logs SELECT * FROM audit_parts.audit_logs_2028q3_old;
DROP TABLE audit_parts.audit_logs_2028q3_old;

INSERT INTO public.audit_logs SELECT * FROM audit_parts.audit_logs_default;
TRUNCATE audit_parts.audit_logs_default;

-- 5. Put the net back. It is empty now, so the validating scan is free.
ALTER TABLE public.audit_logs ATTACH PARTITION audit_parts.audit_logs_default DEFAULT;

COMMIT;
```

No audit record is destroyed: every row is written back through `public.audit_logs` before the table
holding it is dropped or truncated. That is the only form of this operation consistent with an
append-only log, and it is why the whole thing is one transaction rather than a sequence you could
stop halfway.

If a parked table's rows had already reached the parent before an earlier attempt was interrupted,
step 4 does not duplicate them — the primary key is `(id, created_at)`, so the replay fails on a
unique violation and the transaction rolls back. Confirm with a `count(*)` against the same range in
`public.audit_logs`, then drop the parked table instead of replaying it.

**This is a maintenance-window operation.** `DETACH PARTITION` cannot be `CONCURRENTLY` inside a
transaction block, so it takes `ACCESS EXCLUSIVE` on `public.audit_logs` and holds it to `COMMIT`.
Audit writes block throughout, and a blocked audit write fails the request that produced it. Size it
by how many rows are parked and in the default partition.

### If the migration refuses: too many rows to rewrite

Migration 0010 rewrites the whole of `audit_logs` — it detaches every partition, re-inserts every
row through the parent, and rebuilds the primary key and four indexes. That is free on a small table
and an outage on a large one, so it measures first — before taking any lock that blocks writers —
and refuses above about a million rows.

The refusal aborts the migration transaction, and drizzle runs all pending migrations in one
transaction, so nothing else applies either.

**Take the rewrite deliberately**, in a maintenance window, accepting that audit writes block for
its duration:

```bash
XECRET_ALLOW_AUDIT_REWRITE=on npm run db:migrate
```

`migrate.ts` turns that into a session-scoped `SET xecret.allow_audit_rewrite = 'on'` on its own
connection, and it applies to that run only — there is nothing to reset afterwards.

It is deliberately not `ALTER DATABASE ... SET xecret.allow_audit_rewrite`. That would be the
obvious way to do it, and it does not work here: `xecret.*` is a *custom placeholder* parameter, and
PostgreSQL only lets a true superuser store one in `pg_db_role_setting`. Neon, RDS, Cloud SQL and
Supabase all withhold superuser, so the `ALTER` fails with `permission denied to set parameter`, and
`ALTER ROLE ... SET` fails identically. Setting it in a session has no such restriction.

There is no alternative that consists of skipping it. Nothing in the application names a partition,
so 0001's monthly layout would serve perfectly well — but drizzle applies pending migrations in one
transaction, so a 0010 that keeps aborting keeps every later migration from applying too. Declining
it is not "stay on monthly"; it is "no migrations from here on". 0010 is currently the last one, so
that cost is invisible until the next release.

---

## Known sharp edges

**A new table in a future migration needs an explicit grant.** Migration 0002 lists the tenant
tables by name, and nothing grants anything on a table added later. Migration 0010 revokes the
`ALTER DEFAULT PRIVILEGES` rule in `public` that used to paper over this — it existed only to cover
audit partitions, which now live in `audit_parts` and are granted explicitly by
`create_audit_log_partition()`. With that rule gone, a migration that adds an ordinary table and
forgets its `GRANT` fails loudly on first use rather than half-working with read-and-insert but no
update-or-delete.

That revoke is best-effort, and there is one case where it does not happen. A default-privilege rule
belongs to the role that created it, and removing it means being that role or a member of it. If you
applied migration 0002 as one role — `postgres` during bootstrap, say — and later migrations under a
dedicated migration role, 0010 cannot remove it. It does not fail; it warns, naming the role and the
statement to run:

```
WARNING: could not revoke the public default-privilege rule owned by postgres. Run this as
that role before adding any new table: ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE
SELECT, INSERT ON TABLES FROM xecret_app_permissions;
```

`npm run db:migrate` forwards warnings, so this appears in the migration output. **If you see it,
the sharp edge is still open until you run the statement it names.** Either way, any migration
adding a table must add its own `GRANT`.

**`CREATE ROLE` may need the account owner.** On some managed providers role creation is
restricted. If migration 0002 fails on `CREATE ROLE`, create `xecret_app_permissions` through the provider's
console and re-run — the `GRANT` statements are idempotent.

**None of this has been run against a live Neon instance yet.** The SQL is standard PostgreSQL and
the grants are tested by shape, but the first person to follow this document is also the first
person to test it. If a step does not behave as written, that is a bug in this document — report
it.
