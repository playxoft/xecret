# xecret Database Schema

**Version:** 1.0 · **Date:** 2026-08-10 · PostgreSQL 16+ (Neon)

The full schema, designed on paper before any migration is written. Drizzle definitions in
`packages/db/src/schema/` are the executable form of this document; if they diverge, this
document is wrong and must be updated.

---

## Conventions

- **Primary keys:** UUIDv7 generated in the application. Time-ordered (good index locality)
  without the enumerable sequence of an integer ID.
- **Timestamps:** `timestamptz`, always UTC. `created_at`/`updated_at` on every table.
- **Soft delete:** `deleted_at timestamptz`. Present on tenant-visible resources only.
  Uniqueness constraints are partial: `WHERE deleted_at IS NULL`.
- **Ciphertext:** always `bytea`. Never `text`, never base64 in the database.
- **Token storage:** always `bytea` holding SHA-256 of the token. **Never the token itself.**
- **Case-insensitive text:** `citext` for emails and slugs. Requires
  `CREATE EXTENSION IF NOT EXISTS citext;` in migration `0000`.
- **Foreign keys:** always declared. `ON DELETE RESTRICT` by default; `CASCADE` only where a
  child is meaningless without its parent and is explicitly noted.

---

## 1. Identity

```sql
CREATE TABLE users (
  id              uuid PRIMARY KEY,
  firebase_uid    text        NOT NULL UNIQUE,
  email           citext      NOT NULL UNIQUE,
  email_verified  boolean     NOT NULL DEFAULT false,
  display_name    text,
  avatar_url      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz,
  deleted_at      timestamptz
);
CREATE INDEX users_firebase_uid_idx ON users (firebase_uid) WHERE deleted_at IS NULL;
```

`firebase_uid` is the join key to the identity provider. Swapping providers later means
adding a provider column, not restructuring — see [ADR 0003](../adr/0003-firebase-as-identity-provider.md).

```sql
CREATE TABLE sessions (
  id           uuid PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea       NOT NULL UNIQUE,      -- SHA-256 of a 256-bit opaque token
  ip_address   inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_lookup_idx ON sessions (token_hash)
  WHERE revoked_at IS NULL;
CREATE INDEX sessions_user_idx ON sessions (user_id, created_at DESC);
```

A database dump yields hashes, not usable sessions. `sessions_user_idx` powers the "active
devices" list and "sign out everywhere".

---

## 2. Tenancy

```sql
CREATE TYPE org_role     AS ENUM ('owner', 'admin', 'developer', 'viewer');
CREATE TYPE member_status AS ENUM ('active', 'suspended');

CREATE TABLE organizations (
  id          uuid PRIMARY KEY,
  name        text        NOT NULL,
  slug        citext      NOT NULL UNIQUE,
  seat_limit  integer     NOT NULL DEFAULT 5 CHECK (seat_limit >= 0),
  created_by  uuid        NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE org_members (
  id            uuid PRIMARY KEY,
  org_id        uuid          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          org_role      NOT NULL,
  status        member_status NOT NULL DEFAULT 'active',
  seat_assigned boolean       NOT NULL DEFAULT true,
  invited_by    uuid          REFERENCES users(id),
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX org_members_user_idx ON org_members (user_id) WHERE status = 'active';
CREATE INDEX org_members_org_idx  ON org_members (org_id)  WHERE status = 'active';
```

`org_members` is the table every authorization query passes through. `org_members_user_idx`
is the single most performance-critical index in the schema.

**Invariant enforced in application code, tested explicitly:** an organisation always has at
least one `owner` with `status = 'active'`. Removing or demoting the last owner is rejected.

```sql
CREATE TABLE invitations (
  id          uuid PRIMARY KEY,
  org_id      uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       citext      NOT NULL,
  role        org_role    NOT NULL,
  token_hash  bytea       NOT NULL UNIQUE,
  invited_by  uuid        NOT NULL REFERENCES users(id),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid        REFERENCES users(id),
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invitations_pending_idx ON invitations (org_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
```

The partial unique index prevents invitation spam to the same address while still allowing
re-invitation after expiry or revocation. Acceptance requires the authenticated user's email
to match `email` — an intercepted invitation link is not enough.

---

## 3. Resources

```sql
CREATE TABLE projects (
  id          uuid PRIMARY KEY,
  org_id      uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  slug        citext      NOT NULL,
  description text,
  created_by  uuid        NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX projects_org_slug_idx ON projects (org_id, slug)
  WHERE deleted_at IS NULL;

CREATE TABLE environments (
  id            uuid PRIMARY KEY,
  project_id    uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          text        NOT NULL,
  slug          citext      NOT NULL,
  is_production boolean     NOT NULL DEFAULT false,
  encryption_mode text      NOT NULL DEFAULT 'e2ee'
                            CHECK (encryption_mode IN ('server', 'e2ee')),
  sort_order    integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE UNIQUE INDEX environments_project_slug_idx ON environments (project_id, slug)
  WHERE deleted_at IS NULL;
```

`is_production` is a first-class column, not a slug convention. Production safeguards
(stronger permission checks, destructive-action confirmation, distinct UI treatment) key off
this flag, so an environment named `prod-eu-west` behaves correctly.

`encryption_mode` says which key hierarchy an environment's values live under — `server` for
the envelope of ADR 0001 (§4), `e2ee` for the client-held keys of ADR 0009 (§4.1). It is a
**migration mechanism, not a product option**: nothing in the API lets a caller choose one.
Migration 0013 backfills every existing row to `server` through the `ADD COLUMN` default and
then changes the default to `e2ee`, which is what makes every environment created from that
deployment onward end-to-end encrypted. A row moves from `server` to `e2ee` exactly once, by
the migration ceremony, and never back once the old ciphertext is gone.

---

## 4. Cryptographic keys

```sql
CREATE TYPE key_status AS ENUM ('active', 'retired', 'compromised');

CREATE TABLE org_keys (
  id               uuid PRIMARY KEY,
  org_id           uuid        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version          integer     NOT NULL,
  wrapped_key      bytea       NOT NULL,   -- Org Master Key, wrapped by the Root KEK
  wrap_iv          bytea       NOT NULL,   -- 96-bit
  root_key_version integer     NOT NULL,   -- which Root KEK wrapped it
  algorithm        text        NOT NULL DEFAULT 'AES-256-GCM',
  status           key_status  NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now(),
  retired_at       timestamptz,
  UNIQUE (org_id, version)
);
CREATE INDEX org_keys_active_idx ON org_keys (org_id) WHERE status = 'active';

CREATE TABLE env_keys (
  id             uuid PRIMARY KEY,
  environment_id uuid        NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  org_key_id     uuid        NOT NULL REFERENCES org_keys(id) ON DELETE RESTRICT,
  version        integer     NOT NULL,
  wrapped_key    bytea       NOT NULL,     -- Env Data Key, wrapped by the Org Master Key
  wrap_iv        bytea       NOT NULL,
  algorithm      text        NOT NULL DEFAULT 'AES-256-GCM',
  status         key_status  NOT NULL DEFAULT 'active',
  created_at     timestamptz NOT NULL DEFAULT now(),
  retired_at     timestamptz,
  UNIQUE (environment_id, version)
);
CREATE INDEX env_keys_active_idx ON env_keys (environment_id) WHERE status = 'active';
```

`ON DELETE RESTRICT` on both is deliberate: a key row must never disappear as a side effect of
deleting something else, because that would orphan ciphertext permanently.

**Cryptographic erasure:** deleting an `env_keys` row makes every secret in that environment
permanently unreadable without touching a ciphertext row. This is how deletion is honoured
even when database backups still contain the data.

### 4.1 Environment keys under zero knowledge

The two tables above are the **server envelope** of ADR 0001: the Worker can unwrap both, and
therefore can read every secret. ADR 0009 replaces them for new environments with a hierarchy
whose key material this database never holds.

```sql
CREATE TABLE env_data_keys (              -- the EDK: identity and version only
  id             uuid PRIMARY KEY,
  environment_id uuid        NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
  version        integer     NOT NULL CHECK (version >= 1),
  status         text        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'retired')),
  created_by     uuid        NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment_id, version)
);
CREATE UNIQUE INDEX env_data_keys_active_unique
  ON env_data_keys (environment_id) WHERE status = 'active';

CREATE TABLE env_hmac_keys (              -- the EHK: one per environment, never versioned
  id             uuid PRIMARY KEY,
  environment_id uuid        NOT NULL UNIQUE REFERENCES environments(id) ON DELETE RESTRICT,
  created_by     uuid        NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE env_key_grants (             -- one principal's sealed copy of both keys
  id                uuid PRIMARY KEY,
  env_data_key_id   uuid        NOT NULL REFERENCES env_data_keys(id) ON DELETE CASCADE,
  member_user_id    uuid        REFERENCES users(id) ON DELETE CASCADE,
  service_token_id  uuid        REFERENCES service_tokens(id) ON DELETE CASCADE,
  invitation_id     uuid        REFERENCES invitations(id) ON DELETE CASCADE,
  edk_sealed        bytea       NOT NULL,   -- xk2.x25519. blob (spec §2.2 type 6)
  ehk_sealed        bytea       NOT NULL,   -- xk2.x25519. blob (type 7)
  signature         bytea       NOT NULL,   -- xk2.ed25519. blob (type 8)
  signed_by_user_id uuid        NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(member_user_id, service_token_id, invitation_id) = 1)
);
-- Three partial unique indexes, not one composite: PostgreSQL treats NULLs as
-- distinct, so a plain UNIQUE over all four columns would admit duplicates.
CREATE UNIQUE INDEX env_key_grants_member_unique
  ON env_key_grants (env_data_key_id, member_user_id) WHERE member_user_id IS NOT NULL;
CREATE UNIQUE INDEX env_key_grants_token_unique
  ON env_key_grants (env_data_key_id, service_token_id) WHERE service_token_id IS NOT NULL;
CREATE UNIQUE INDEX env_key_grants_invitation_unique
  ON env_key_grants (env_data_key_id, invitation_id) WHERE invitation_id IS NOT NULL;

CREATE TABLE pending_key_grants (         -- the queue of shares nobody could seal
  id             uuid PRIMARY KEY,
  environment_id uuid        NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  target_user_id uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by   uuid        NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment_id, target_user_id)
);
```

**`env_data_keys` and `env_hmac_keys` hold no key material.** That is the property to check
every future column against, and the whole difference between them and `env_keys` above:
`env_keys.wrapped_key` is a key this deployment can unwrap, and its successor deliberately is
not. The bytes exist only inside `env_key_grants`, sealed to a public key whose private half
the server has never seen.

**One active EDK per environment.** Two would be two answers to "which key does the next write
use", and a client picking the older one would encrypt under a key a revoked principal still
holds — silently undoing the rotation that retired it. Retired rows are kept for ever, because
historical `secret_versions` reference them.

**The EHK is never versioned**, and that is its entire reason for existing: `value_hmac` must
survive an EDK rotation (crypto spec §9). If the HMAC key rotated with the data key, the first
write to every secret after a rotation would be recorded as a change when nothing changed.

**Signatures are `NOT NULL`.** Verification is deferred past v1 — it needs a trust root for
signer keys — but the columns are not, because turning verification on later has to be a client
update rather than a data migration over grants that never carried a signature.

**`pending_key_grants` is a queue, not authority.** Access is decided by people who may not
hold the key: an owner can grant production access having never opened production, so their
browser has no EDK to seal. The access change lands and a row here records the debt, which the
next unlocked member holding that key fulfils. Every column is an id or a timestamp.

---

## 5. Secrets

```sql
CREATE TABLE secrets (
  id             uuid PRIMARY KEY,
  environment_id uuid        NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name           text        NOT NULL CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  note           text,                          -- server mode: plaintext description
  enc_note       bytea,                         -- e2ee mode: xk2.gcm. blob (spec type 10)
  created_by     uuid        NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE UNIQUE INDEX secrets_env_name_idx ON secrets (environment_id, name)
  WHERE deleted_at IS NULL;

CREATE TABLE secret_versions (
  id               uuid PRIMARY KEY,
  secret_id        uuid        NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  version          integer     NOT NULL,
  ciphertext       bytea       NOT NULL,
  iv               bytea,                 -- server mode only; e2ee puts it inside the blob
  env_key_id       uuid        REFERENCES env_keys(id) ON DELETE RESTRICT,      -- server mode
  env_data_key_id  uuid        REFERENCES env_data_keys(id) ON DELETE RESTRICT, -- e2ee mode
  algorithm        text        NOT NULL DEFAULT 'AES-256-GCM',
  client_algorithm text,                  -- e2ee mode: what the client says it used
  value_hmac       bytea,                 -- see note below
  created_by       uuid        NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (secret_id, version),
  -- Exactly one key, and therefore exactly one mode, per row.
  CHECK (num_nonnulls(env_key_id, env_data_key_id) = 1),
  CHECK ((env_key_id IS NOT NULL) = (iv IS NOT NULL)),
  CHECK ((env_data_key_id IS NOT NULL) = (client_algorithm IS NOT NULL))
);
CREATE INDEX secret_versions_current_idx ON secret_versions (secret_id, version DESC);
```

**The three CHECKs are what make the dual-mode period safe.** A row naming both keys claims two
different sets of bytes decrypt it; a row naming neither is ciphertext nothing can ever open —
and would read as an e2ee row to any query testing `env_key_id IS NULL`. Both are silent,
permanent data loss, so the database refuses them rather than the application remembering to.

`iv` was `NOT NULL` before ADR 0009 and the invariant is unchanged, only narrowed to the rows it
ever applied to: a server-envelope row still cannot be written without one. An e2ee row has no
`iv` column value because the crypto spec puts the IV **inside** the `xk2.gcm.` blob (§2.1),
where it travels with the ciphertext it belongs to and cannot be paired with the wrong one.

`note` and `enc_note` are the same field seen from the two sides of the migration. No CHECK
pairs them, because the rule that decides which is written depends on
`environments.encryption_mode` — a join away, and unreachable from a row constraint. An e2ee
secret leaves `note` NULL: a note is free text people put credentials in, and the column's old
promise that it "never holds a value" was never enforceable.

**`secret_versions` is append-only.** Updating a secret inserts a new row; it never mutates an
existing one. This gives rotation, rollback, and audit history for free. The current value is
the highest `version` — resolved by `secret_versions_current_idx`, which is also what the bulk
read path uses.

**`value_hmac` — deliberately an HMAC, not a hash.** It exists so a write can detect "the
value did not actually change" without decrypting. A plain SHA-256 of the plaintext would be
a brute-force oracle: most secrets are low-entropy enough (`postgres://user:pass@host/db`,
short API keys) that an attacker with the database could confirm guesses offline. The HMAC key
is derived from the environment's data key via HKDF, so the value is useless without the key
hierarchy. Nullable — omitted where the check is not needed.

### AAD binding

Every ciphertext is encrypted with additional authenticated data:

```
AAD = org_id ‖ environment_id ‖ secret_id ‖ version
```

An attacker with database write access cannot copy a production ciphertext row into a
development environment they can read — decryption fails rather than silently succeeding.
This defends a real attack that encryption alone does not.

---

## 6. Access control

```sql
CREATE TYPE access_level AS ENUM ('none', 'read', 'write', 'admin');

CREATE TABLE access_grants (
  id             uuid PRIMARY KEY,
  org_member_id  uuid         NOT NULL REFERENCES org_members(id) ON DELETE CASCADE,
  project_id     uuid         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id uuid         REFERENCES environments(id) ON DELETE CASCADE,  -- NULL = whole project
  access_level   access_level NOT NULL,
  granted_by     uuid         NOT NULL REFERENCES users(id),
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX access_grants_unique_idx
  ON access_grants (org_member_id, project_id, COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX access_grants_member_idx ON access_grants (org_member_id);
```

`COALESCE` in the unique index is required because PostgreSQL treats `NULL`s as distinct, so a
plain unique constraint would permit duplicate project-wide grants.

**Resolution order** — most specific wins, and an explicit `none` always denies:

```
1. Explicit grant for (member, project, environment)   ← most specific
2. Explicit grant for (member, project, NULL)
3. Role default from org_members.role
```

| Role | Default | Notes |
|---|---|---|
| `owner` | admin everywhere | Cannot be removed if last owner |
| `admin` | admin everywhere | Can manage members and grants |
| `developer` | write on non-production, **none on production** | Production requires an explicit grant |
| `viewer` | read on non-production, none on production | Never writes |

Production being deny-by-default even for developers is the deliberate safe default. Granting
it is a conscious act that appears in the audit log.

**Custom roles are not in v1.** The enum can gain values and a `custom_roles` table can be
added without migrating existing data.

---

## 7. Machine credentials

```sql
CREATE TABLE cli_tokens (
  id            uuid PRIMARY KEY,
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          text        NOT NULL,          -- "Nitheesh's MacBook Pro"
  token_hash    bytea       NOT NULL UNIQUE,
  token_prefix  text        NOT NULL,          -- "xct_live_a1b2" — for display only
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  last_used_at  timestamptz,
  last_used_ip  inet,
  revoked_at    timestamptz
);
CREATE INDEX cli_tokens_lookup_idx ON cli_tokens (token_hash) WHERE revoked_at IS NULL;

CREATE TABLE service_tokens (
  id             uuid PRIMARY KEY,
  org_id         uuid         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id     uuid         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id uuid         NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name           text         NOT NULL,
  token_hash     bytea        NOT NULL UNIQUE,
  token_prefix   text         NOT NULL,
  public_key     bytea,                      -- the token's own X25519 public key (ADR 0009)
  key_algorithm  text,                       -- 'X25519' beside a non-null key
  access_level   access_level NOT NULL DEFAULT 'read',
  ip_allowlist   inet[],
  created_by     uuid         NOT NULL REFERENCES users(id),
  created_at     timestamptz  NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  last_used_at   timestamptz,
  last_used_ip   inet,
  revoked_at     timestamptz
);
CREATE INDEX service_tokens_lookup_idx ON service_tokens (token_hash) WHERE revoked_at IS NULL;
```

Two separate tables rather than one with a nullable `user_id`, because they have genuinely
different lifecycles and blast radii. A CI token must never be able to act as a person, and
the type system should make that impossible rather than merely discouraged.

`service_tokens.environment_id` is `NOT NULL` — a CI token is always scoped to exactly one
environment. This is the primary blast-radius control for threat T5.

`service_tokens.public_key` makes a CI credential a first-class principal under ADR 0009: the
environment's keys are sealed to it, and the matching private scalar lives only inside the
token string its creator was shown once. The server therefore holds a hash it can check and a
public key it can seal to, and nothing that opens either. **This is what makes rotation cheap:**
because the public key is here, a client rotating an EDK re-seals it to every service token
without anybody regenerating one. Nullable, because the Phase 4 creation flow is what fills it,
and a grant to a token without one is refused rather than sealed to nothing.

`invitations.invite_public_key` plays the same role for an invitation (crypto spec §10). The
16-byte **fragment** it is derived from never reaches the server: it travels to the invitee over
a different channel from the emailed token, which is the whole of the two-channel design — a
leaked email decrypts nothing, and a leaked fragment authenticates nothing. There is no column
for the fragment, and there must never be one.

`token_prefix` lets the UI show `xct_live_a1b2…` for identification without storing anything
usable.

---

## 8. Audit log

```sql
CREATE TYPE actor_type AS ENUM ('user', 'cli_token', 'service_token', 'system');
CREATE TYPE audit_outcome AS ENUM ('success', 'denied', 'error');

CREATE TABLE audit_logs (
  id             uuid          NOT NULL,
  org_id         uuid          NOT NULL,
  actor_type     actor_type    NOT NULL,
  actor_id       uuid,
  actor_label    text,          -- denormalised: survives user deletion
  action         text          NOT NULL,      -- 'secret.read', 'member.invite'
  resource_type  text,
  resource_id    uuid,
  project_id     uuid,
  environment_id uuid,
  outcome        audit_outcome NOT NULL,
  ip_address     inet,
  user_agent     text,
  request_id     text,
  metadata       jsonb         NOT NULL DEFAULT '{}',
  created_at     timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX audit_logs_org_time_idx    ON audit_logs (org_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx       ON audit_logs (org_id, actor_id, created_at DESC);
CREATE INDEX audit_logs_action_idx      ON audit_logs (org_id, action, created_at DESC);
CREATE INDEX audit_logs_environment_idx ON audit_logs (environment_id, created_at DESC);
```

**Design notes**

- **Quarterly range partitions.** `secret.read` is the highest-volume event in the system (every
  `xecret run`, every CI build). Partitioning keeps queries fast and makes retention a
  `DROP TABLE` rather than a mass `DELETE`. Quarterly rather than monthly because reads are
  clamped to 90 days by `MAX_AUDIT_RANGE_DAYS` — exactly one quarter — so a bounded query opens
  one or two partitions instead of three or four, and 3–5 years of retention is 12–20 child
  tables rather than 36–60.
- **Partitions live in the `audit_parts` schema**, not `public`. Purely an ergonomic decision, and
  a real one. Left in `public`, 12–20 quarterly children would sit beside the 18 real tables and
  roughly double what `\dt` prints; under the monthly scheme this replaces, 36–60 of them would
  have outnumbered the real tables three to one. A `public` listing an operator cannot scan is one
  they stop reading — and this is the schema where the append-only guarantee lives. PostgreSQL
  allows a partition in a different schema from its parent, and nothing about it is visible to
  queries; the application only ever names `public.audit_logs`. Migration 0010 made both changes,
  while the table was small enough that they were free.
- `created_at` is in the primary key because PostgreSQL requires the partition key there.
- **No foreign keys.** Audit records must outlive the rows they reference. A deleted project
  must not erase the record that it existed and who deleted it.
- `actor_label` is denormalised for the same reason — the log must still read
  "nitheesh@playxoft.com deleted DATABASE_URL" after that user is gone.
- **Append-only.** The application role is granted `INSERT` and `SELECT` on this table, and
  no `UPDATE` or `DELETE`. Enforced at the database grant level, not by convention.
- **`metadata` never contains a secret value.** Enforced in the audit event builder in
  `packages/core/audit`, which accepts only an allowlist of field names — not by asking
  developers to remember.

---

## 9. Entity relationships

```
users ──┬──< sessions
        ├──< cli_tokens
        ├──< user_keys ──< user_key_wraps        (the vault — ADR 0009)
        ├──< user_passkeys                       │
        └──< org_members >── organizations ──┬──< projects ──< environments
                    │                        │                     │
                    │                        ├──< org_keys ──< env_keys       (server mode)
                    │                        ├──< invitations       │
                    │                        └──< service_tokens    │
                    │                                    │          │
                    │                                    │          ├──< env_data_keys
                    │                                    │          ├──< env_hmac_keys
                    │                                    │          └──< pending_key_grants
                    │                                    │                     (e2ee mode)
                    │                                    ▼          │
                    │              env_key_grants >──────┴──────────┘
                    │                     (one sealed copy per principal)
                    └──< access_grants >─────────────────────────────┘
                                                                    │
                                                    secrets ──< secret_versions

secret_versions references env_keys OR env_data_keys — exactly one, by CHECK.
audit_logs — no FKs by design; references are soft
```

## 10. Migration order

```
0000  initial schema: extensions (citext), enums, and the 15 tables above
0001  audit_logs partitioning + partition management function
0002  grants: least-privilege application role
0003  rename the application role to xecret_app_permissions
0004  PIN lock state, secret value types (user_pins, pin_reset_tokens)
0005  CLI authorization codes (cli_auth_codes)
0006  service-token write attribution
0007  invitation initial grants
0008  PIN auto-lock
0009  organization creator index
0010  audit partitions: quarterly, and into the audit_parts schema
0011  user vault (user_keys, user_key_wraps, user_passkeys); retires the PIN
0012  user_keys.uk_unlock_verifier_hash — the verifier a passkey unlock sends
0013  environment data keys (env_data_keys, env_hmac_keys, env_key_grants,
      pending_key_grants), environments.encryption_mode, the dual-mode
      secret_versions columns, service_tokens.public_key, invitations.invite_public_key
```

Migration 0013 drops nothing and loses nothing. Every existing environment keeps its `env_keys`
row and keeps working exactly as before; the one column that could not be added as a nullable
afterthought — `environments.encryption_mode` — is backfilled to the behaviour those rows
already have. What it does relax is `secret_versions.env_key_id` and `secret_versions.iv`, from
`NOT NULL` to nullable, and the three CHECKs in §5 restore each invariant for exactly the rows
it ever applied to.

The 15 tables catalogued above are the ones 0000 creates. `cli_auth_codes` arrives in 0005, and
`user_keys`, `user_key_wraps` and `user_passkeys` in 0011; none of the four is catalogued in this
document. `user_pins` and `pin_reset_tokens` existed between 0004 and 0011 and are gone — 0011 is
the first migration in the project to drop a table, and the reasoning is at the top of the file.
`sessions.pin_verified_at` became `sessions.vault_unlocked_at` in the same migration, as an
add-then-drop rather than a rename: the old values are wrong under the new model, because a session
that entered a PIN has not unlocked a vault.

Migration `0002` is not optional. The application role gets `SELECT`/`INSERT`/`UPDATE`/
`DELETE` on tenant tables, `SELECT`/`INSERT` only on `audit_logs`, and no DDL rights
anywhere. Migrations run as a separate, more privileged role.

## 11. Deferred to later phases

`custom_roles` and `role_permissions` (Phase 7+) · `webhooks` · `secret_references` for
cross-environment inheritance · `billing_*` (the `seat_limit` column is the only hook needed
now) · `oidc_trust_policies` for GitHub Actions federation (Phase 8 designs the token table
for it; the feature is v2).
