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
  firebase_uid    text        UNIQUE,              -- retired: nullable, read and written by nothing
  workos_user_id  text        UNIQUE,              -- 0018; `user_…`, NULL until linked
  email           citext      NOT NULL UNIQUE,
  email_verified  boolean     NOT NULL DEFAULT false,
  display_name    text,
  avatar_url      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz,
  deleted_at      timestamptz,
  CONSTRAINT users_identity_present_check
    CHECK (firebase_uid IS NOT NULL OR workos_user_id IS NOT NULL),
  CONSTRAINT users_workos_user_id_format_check
    CHECK (workos_user_id ~ '^user_[0-9A-Za-z]+$')
);
CREATE INDEX users_firebase_uid_idx ON users (firebase_uid) WHERE deleted_at IS NULL;
```

The provider id columns are the join keys to the identity provider — see
[ADR 0010](../adr/0010-workos-as-identity-provider.md), which superseded the Firebase design of
[ADR 0003](../adr/0003-firebase-as-identity-provider.md). Swapping providers was meant to
mean adding a column, not restructuring, and migration `0018` is exactly that. The WorkOS
column is the live one; the Firebase column is kept, retired, for the transition.

- `firebase_uid` is **retired**. The Firebase sign-in that wrote it is gone, and nothing in the
  application reads or writes it any more. It became **nullable** in `0018` — a user who joins
  through WorkOS never had a Firebase account — but keeps its unique constraint and
  `users_firebase_uid_idx`, because it is the key the WorkOS import's backfill matches on and
  the rollback if the cutover goes wrong. It is dropped by a later, deliberate decommission
  migration.
- `workos_user_id` has one application writer, the sign-in callback's linking pass
  (`upsertUserFromWorkosIdentity`): match on `workos_user_id`, else adopt the account
  holding the same **verified** address, else create. Its one other writer is operational:
  the one-off backfill after the WorkOS user import, which writes the imported id onto rows
  found by `firebase_uid` and must only fill a NULL (`WHERE workos_user_id IS NULL`), so it
  can never overwrite a link a sign-in made. It is NULL on every Firebase-era row until that
  row is linked either way. `users_workos_user_id_format_check` admits only a WorkOS id
  (`^user_[0-9A-Za-z]+$`) — a Firebase uid written here is the one mistake this migration
  has already seen made once. Its unique constraint's index is its only index: the linking
  pass reads it *including* soft-deleted rows, so that a deleted account is refused as
  deleted rather than taken for nobody.
- `users_identity_present_check` keeps every row reachable by some provider. **Dropping
  `firebase_uid` drops this constraint silently** (PostgreSQL removes a constraint that
  references a dropped column), so the decommission migration must replace it — in practice
  with `workos_user_id SET NOT NULL`, once the rows without one have been dealt with.

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
  revoked_at   timestamptz,
  sign_in_method    text CHECK (sign_in_method IN ('password','oauth','sso','magic_auth','passkey','other')), -- 0022
  sso_workos_org_id text CHECK (sso_workos_org_id IS NULL OR sign_in_method = 'sso'),                        -- 0022
  workos_session_id text CHECK (workos_session_id ~ '^session_[0-9A-Za-z]{1,64}$'),                          -- 0023
  fresh_auth_at     timestamptz                                                                              -- 0023
);
CREATE INDEX sessions_lookup_idx ON sessions (token_hash)
  WHERE revoked_at IS NULL;
CREATE INDEX sessions_user_idx ON sessions (user_id, created_at DESC);

CREATE TABLE sign_in_confirmations (             -- 0022; a spent sign-in confirmation
  nonce_hash bytea       PRIMARY KEY CHECK (octet_length(nonce_hash) = 32),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  spent_at   timestamptz NOT NULL DEFAULT now()
);
```

A database dump yields hashes, not usable sessions. `sessions_user_idx` powers the "active
devices" list and "sign out everywhere".

`sign_in_method` and `sso_workos_org_id` (migration 0022) record how the sign-in that issued a
session authenticated, and through which WorkOS organisation's single sign-on. They ride on the
hot-path lookup, and they are what an organisation's `sso_required` is checked against on every
request (`resolveOrg`): a non-owner member reaches an organisation that requires SSO only
through a session whose `sso_workos_org_id` is its `workos_org_id`. A session from before 0022
has neither, and reads as "not single sign-on". `cli_auth_codes` and `cli_tokens` carry the same
two columns, copied from the browser session that approved the device.

`workos_session_id` (migration 0023) is the AuthKit session the issuing sign-in came from — the
`sid` claim of the code exchange's own access token. Sign-out (`DELETE /api/auth/session`)
answers WorkOS's logout URL for it, so leaving xecret ends AuthKit's session too and the next
sign-in on that browser is asked for rather than reused without a word. It names a session; it
does not authenticate as one. NULL for every session from before 0023, which signs out as
before. `fresh_auth_at` is when the person actively authenticated, during a `reauth` flow, by a
method that re-proves who they are — an emailed code included — dated by WorkOS's `auth_time`;
the SSO setup portal's step-up asks for one under ten minutes old. The vault reset's own, stricter
record stays in `reauthentications`.

`sign_in_confirmations` is the ledger that makes a held-back sign-in single-use. The callback
does not issue a session for a sign-in that came back through an organisation the flow did not
ask for (the planted-AuthKit-session login CSRF), through the single sign-on of one the account
is not in, or from a reused WorkOS session for an account other than the browser's last; it
parks the outcome in a sealed five-minute cookie carrying a random nonce, and `POST
/api/auth/confirm` inserts that nonce's SHA-256 here before issuing anything — a second use of
the same cookie collides with the primary key. A row past `expires_at` stops nothing (the cookie
is refused on its age first) and the hourly scheduled job deletes it
(`deleteSpentSignInConfirmations`, beside the retained-vault purge) — once it is a minute past,
not at the instant: the cookie's age is counted in whole seconds and is accepted for up to a
second beyond `expires_at`, and a replay in that second must still find its row.

```sql
CREATE TABLE reauthentications (                 -- 0019
  id               uuid        PRIMARY KEY,
  user_id          uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id       uuid        NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  signed_in_at     timestamptz NOT NULL,         -- lock one: the sign-in for the reset
  code_sent_at     timestamptz,                  -- a code was requested; the code is never stored
  code_attempts    smallint    NOT NULL DEFAULT 0 CHECK (code_attempts >= 0),
  code_sends       smallint    NOT NULL DEFAULT 0 CHECK (code_sends >= 0),
  mfa_pending_hash bytea,                        -- SHA-256 (32 bytes) of WorkOS's pending-
                                                 --   authentication token, never the token
  mfa_factor_id    text,                         -- the WorkOS TOTP factor to challenge
  proof_hash       bytea       UNIQUE,           -- lock two: SHA-256 of the proof, never the proof
  proof_expires_at timestamptz,
  used_at          timestamptz,                  -- the reset spent the proof
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reauthentications_proof_pair_check
    CHECK ((proof_hash IS NULL) = (proof_expires_at IS NULL)),
  CONSTRAINT reauthentications_proof_hash_length_check
    CHECK (proof_hash IS NULL OR octet_length(proof_hash) = 32),
  CONSTRAINT reauthentications_mfa_pending_hash_length_check
    CHECK (mfa_pending_hash IS NULL OR octet_length(mfa_pending_hash) = 32),
  CONSTRAINT reauthentications_mfa_pair_check
    CHECK ((mfa_pending_hash IS NULL) = (mfa_factor_id IS NULL)),
  CONSTRAINT reauthentications_used_check
    CHECK (used_at IS NULL OR proof_hash IS NOT NULL)
);
CREATE INDEX reauthentications_user_idx ON reauthentications (user_id, signed_in_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON reauthentications TO xecret_app_permissions;
  -- guarded: only where that role exists, as in 0017
```

The vault reset's re-authentication, kept by the server rather than the client. The reset
destroys a vault for good and must stay reachable from a locked session, so it is guarded by
two re-authentications in a fixed order (ADR 0010): a sign-in again, recorded here by the
sign-in callback against the **new** session it issues, in the same transaction that inserts
that session; then a code WorkOS emails — and, for an account with an authenticator app, its
TOTP code — whose verification mints a five-minute proof stored as `proof_hash`. The reset
spends it with one UPDATE that requires this proof, this user, this session, `used_at IS NULL`
and an unexpired `proof_expires_at`, so two concurrent resets with one proof cannot both pass.

- `session_id` is **unique**: an attempt belongs to the session the sign-in issued, and a proof
  minted here is refused by every other session, including another of the same account.
- **What happens to a row when its session ends.** Sessions are *revoked* by an UPDATE
  (`revoked_at`) — on sign-out, "sign out everywhere", account deletion, or a newer sign-in in
  the same browser — not deleted, so the row survives its session's revocation. It is inert
  from then on: a revoked or expired session cannot authenticate the reauth or reset requests
  that would read it. The row goes, by cascade, only when its session row is actually deleted —
  the expired-session cleanup (`deleteExpiredSessions`, which nothing schedules yet) — or its
  user row is hard-deleted, which the application never does (account deletion soft-deletes).
- `code_attempts` counts **guesses**, not failures — the emailed code and the TOTP step alike.
  Each is reserved here atomically before WorkOS is called: at most five per attempt
  (`code_attempts < 5` in the reserving UPDATE's own predicate), and at most ten per user,
  summed across the attempts that user started in the last 24 hours under the user's row lock
  — `reauthentications_user_idx` is that sum's index, and the user foreign key's cascade reads
  through it too. A guess is accepted only where `code_sent_at` is set. The budget is a column,
  not a rate-limiter counter, so it holds where the rate-limit binding is absent and fails open.
  The sum is correct only at READ COMMITTED, Postgres's default, which nothing here overrides:
  each statement takes a fresh snapshot, so a guess that waited for the row lock sees the
  reservations committed ahead of it.
- `code_sends` counts **code requests** — each one an email to the account. Reserved the same
  way, before WorkOS is asked and under the same user-row lock: at most three per attempt
  (`code_sends < 3` in the reserving UPDATE), whatever WorkOS then answers. A fresh sign-in is
  a new attempt with its own three.
- `mfa_pending_hash` and `mfa_factor_id` are set together when WorkOS answers a correct emailed
  code with an MFA challenge. The browser holds the pending-authentication token, which WorkOS
  would accept back with an authenticator code; this row holds only its SHA-256, so the TOTP
  step is accepted only with the token this attempt was given.
- The CHECKs make the column shapes honest: a proof exists only with an expiry, is exactly a
  SHA-256 digest — a raw proof here is the one mistake that would make a database read worth
  the same as the proof — and can only be spent if it exists; the pending-authentication hash
  is exactly a digest too, and never present without the factor it belongs to.
- The application role is granted `SELECT, INSERT, UPDATE, DELETE` in the migration itself,
  guarded the way 0017's grant is, because a new table gets nothing from the role
  automatically and a self-hoster who never created that role must not be blocked by its
  absence.

---

## 2. Tenancy

```sql
CREATE TYPE org_role     AS ENUM ('owner', 'admin', 'developer', 'viewer');
CREATE TYPE member_status AS ENUM ('active', 'suspended');

CREATE TABLE organizations (
  id            uuid PRIMARY KEY,
  name          text        NOT NULL,
  slug          citext      NOT NULL UNIQUE,
  seat_limit    integer     NOT NULL DEFAULT 5 CHECK (seat_limit >= 0),
  workos_org_id text        UNIQUE,                  -- 0018; set lazily, on enabling SSO
  workos_client_id text,                             -- 0022; the WorkOS environment of the link
  sso_required  boolean     NOT NULL DEFAULT false,  -- 0018; per request, owners exempt
  jit_join_enabled boolean  NOT NULL DEFAULT false,  -- 0021; the just-in-time opt-in
  created_by    uuid        NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  -- 0021: both SSO flags are about the organisation's connection, and there is none unlinked.
  CONSTRAINT organizations_sso_flags_need_link_check
    CHECK ((sso_required = false AND jit_join_enabled = false) OR workos_org_id IS NOT NULL),
  -- 0022 (added NOT VALID), validated by 0023: a link always records its environment.
  CONSTRAINT organizations_workos_link_client_check
    CHECK (workos_org_id IS NULL OR workos_client_id IS NOT NULL)
);

CREATE TABLE workos_home (                        -- 0023; one row, SELECT-only for the app
  id          boolean     PRIMARY KEY DEFAULT true CHECK (id),
  client_id   text        NOT NULL CHECK (client_id ~ '^client_[0-9A-Za-z]+$'),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_member_removals (                -- 0022
  org_id     uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  removed_by uuid        REFERENCES users(id) ON DELETE SET NULL,  -- NULL: nobody else did
  removed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
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

`workos_org_id` maps an organisation to its WorkOS Organization. It is created **lazily**,
only when an organisation enables SSO — almost every organisation is a personal one
provisioned at first login and never needs one — and is set once (`setOrgWorkosOrgId`
refuses to re-point it). The sign-in callback resolves WorkOS organisations back to tenants
with `findOrgByWorkosOrgId`, which ignores soft-deleted organisations. `workos_client_id`
(migration 0022) records which WorkOS **environment** the link was made in: an organisation id
means something only in its own environment, and local development runs against WorkOS
Staging over the production database. `setOrgWorkosOrgId` writes the two together and answers
whether it was the write that linked them (`changed`), so of two concurrent enables only one is
audited; the settings refuse a link whose client id is not this deployment's, and the sign-in
path (`findOrgByWorkosOrgId`, which takes the asking deployment's client id) resolves only links
made in its own environment. `organizations_workos_link_client_check` holds on every row: 0022
added it `NOT VALID` — which turned out to mean a linked row without a client id could not be
updated *at all* (Postgres checks a `NOT VALID` constraint on every UPDATE, so a rename, a
soft-delete, `plan:set` or even switching a policy off failed with a 500) — and 0023 backfilled
such rows with the production client id and validated it.

`workos_home` (migration 0023) is **the one WorkOS environment this database's links may come
from** — one row, seeded with the Playxoft production environment's client id; a self-hosted
deployment records its own (`docs/self-hosting.md`). `setOrgWorkosOrgId` — the only writer of
a link — checks it in the UPDATE's own predicate and answers `forbidden` for any other client
id, or while no row exists; the SSO settings check it first, before WorkOS is asked to create
anything, and for opening the portal and switching a policy on as well. So a deployment
running against another WorkOS environment can read the settings and switch a policy off, and
can write nothing that needs its environment. The application role may only `SELECT` it:
recording the environment is an operator's act. Clearing a link written before this existed
is in `docs/operations/workos-environments.md`.

`sso_required` ("non-owner members reach this organisation only through its own single
sign-on") is **enforced on every request**, by `resolveOrg`, against the presenting
credential's `sso_workos_org_id` (§1, migration 0022) — so it takes effect at once for sessions
and CLI tokens issued before it went on, and leaves the member's other organisations alone.
Invitation acceptance checks it under the organisation lock, and the sign-in callback refuses
a sign-in only when every organisation of the account would refuse it. **Owners are exempt** —
a deliberate break-glass, so that an identity provider misconfigured after it is switched on
cannot lock the organisation out of itself; a trade-off, since an owner's password stays a way
in that the identity provider does not govern, audited as `auth.sso_exemption_used`. Its one
setter is `updateOrgSsoSettings`, behind the SSO settings route (an owner to switch it on, an
owner or admin to switch it off, a browser session, the single sign-on add-on, this
deployment's WorkOS environment, and an active connection and a verified domain to switch it
on).

An SSO sign-in through an organisation's connection admits a newcomer just in time — as a
`viewer` `org_members` row with `invited_by` NULL — **only if the organisation opted in**
(`jit_join_enabled`, migration 0021, off by default and set by the same setter). Connecting an
identity provider says who an organisation's people are; admitting all of them is a second
decision. The opt-in and the seat limit are both read under the organisation row lock an
invitation acceptance takes (`joinOrganizationJustInTime`), so switching it off is never raced
past. It never reinstates a suspended membership, and never re-admits somebody the
organisation removed: `removeMember` leaves an `org_member_removals` row in the same
transaction, `joinOrganizationJustInTime` answers `removed` for it, and only accepting an
invitation **created after the removal** deletes it (review round 2: an invitation from before
is a leftover, not a decision to have them back). Both `joinOrganizationJustInTime` and
`removeMember` also withdraw every invitation still open for the person's address, under the
organisation lock, so no such leftover stays acceptable. A table of its own rather than a
"removed" member status, because a status would have to be filtered out of every membership
read, seat count and owner count in the product, whereas this is read by one query and written
by one function.

Neither flag can be true on an organisation without a `workos_org_id`
(`organizations_sso_flags_need_link_check`); since the link is never cleared, a flag once on
cannot be stranded.

**Invariant enforced in application code, tested explicitly:** an organisation always has at
least one `owner` with `status = 'active'`. Removing or demoting the last owner is rejected.
Counting stored `role = 'owner'` rows is enough because an owner can never hold a custom role
(`org_members_owner_custom_role_check`, §6): every stored owner is an effective one.

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
3. Role default from org_members.role   ← narrowed by a custom role, if held (below)
```

| Role | Default | Notes |
|---|---|---|
| `owner` | admin everywhere | Cannot be removed if last owner |
| `admin` | admin everywhere | Can manage members and grants |
| `developer` | write on non-production, **none on production** | Production requires an explicit grant |
| `viewer` | read on non-production, none on production | Never writes |

Production being deny-by-default even for developers is the deliberate safe default. Granting
it is a conscious act that appears in the audit log.

### Custom roles

Enterprise only (`customRoles` in the plan features). Added by migration 0017.

```sql
CREATE TABLE custom_roles (
  id                     uuid         PRIMARY KEY,
  org_id                 uuid         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                   text         NOT NULL,
  base_role              org_role     NOT NULL,
  allowed_actions        text[]       NOT NULL DEFAULT '{}',
  ceiling_non_production access_level,
  ceiling_production     access_level,
  created_by             uuid         REFERENCES users(id),
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT custom_roles_org_name_unique  UNIQUE (org_id, name),
  CONSTRAINT custom_roles_org_id_id_unique UNIQUE (org_id, id),  -- target of the FK below
  CONSTRAINT custom_roles_ceiling_check
    CHECK ((ceiling_non_production IS NULL) = (ceiling_production IS NULL)),
  CONSTRAINT custom_roles_base_role_check  CHECK (base_role <> 'owner')
);

ALTER TABLE org_members ADD COLUMN custom_role_id uuid;         -- NULL = the built-in role as-is
ALTER TABLE org_members ADD CONSTRAINT org_members_org_id_custom_role_id_custom_roles_org_id_id_fk
  FOREIGN KEY (org_id, custom_role_id) REFERENCES custom_roles (org_id, id) ON DELETE NO ACTION;
ALTER TABLE org_members ADD CONSTRAINT org_members_owner_custom_role_check
  CHECK (custom_role_id IS NULL OR role <> 'owner');
CREATE INDEX org_members_custom_role_idx ON org_members (custom_role_id)
  WHERE custom_role_id IS NOT NULL;
```

**A custom role can only subtract.** A member holding one is resolved through their *effective
role* — the lower of `org_members.role` and `custom_roles.base_role` — never through the custom
row alone. Their capabilities are the effective role's row ANDed with `allowed_actions`, with one
floor: `member.read` is kept whenever the effective role has it. Their defaults are the effective
role's, narrowed by the ceiling, and every resolved level — explicit grants included — is capped
at the ceiling. No row, however it was written, grants anything the member's own role lacks.
`allowed_actions` is a positive list, so an action added to the product later is denied to every
existing custom role until somebody opts in.

**Same organisation only.** The foreign key is composite, `(org_id, custom_role_id)` against
`(org_id, id)`, so a member can never hold another organisation's role. A NULL `custom_role_id`
skips the check (MATCH SIMPLE) and means exactly what it meant before 0017.

**No silent widening.** `ON DELETE NO ACTION`: a role in use cannot be deleted until its members
are moved off it, one audited `member.custom_role_changed` at a time. `SET NULL` would hand every holder their
unnarrowed role with nothing in the audit log that reads as a permission change; `CASCADE` would
delete the members. NO ACTION rather than RESTRICT because RESTRICT's SQLSTATE changed in
PostgreSQL 18 (23503 → 23001) and "role still in use" is an error the application maps.

**Owners are never narrowed.** No custom role is based on `owner`, and no owner holds a custom
role — one CHECK on each table. Together they keep "stored `owner`" and "effective owner" the same
set of members, which is what lets the last-owner invariant (§2) count `role = 'owner'` rows and
still count the members who can act as owners. A promotion to owner clears `custom_role_id` in the
same UPDATE (`updateMemberRole`); the promotion is itself the widest change there is, only an owner
can make it, and it is already an audited `member.role_changed`.

A `custom_role_id` that does not resolve inside the organisation — which the foreign key makes
impossible — is read as a role based on `viewer` with no actions and a `none` ceiling, never as
"no custom role".

**Who may write one.** The management API (api.md, "Custom roles") defines, edits and deletes
roles and moves members onto and off them. Defining needs an actor who holds no custom role and a
base no higher than their own; editing also measures every current holder, and — where the edit
widens them — every grant row they hold, because a lifted ceiling switches on grants it was
holding down. Each of those writes takes the organisation lock first and makes its checks on
rows read under it (`custom-roles.ts`), so a concurrent assignment cannot slip a holder in
between a check and a write. An organisation may define at most 100 roles.

**Names are unique as a reader sees them, not as `custom_roles_org_name_unique` does.** The
constraint compares bytes; the application refuses a second name with the same *skeleton*
(`customRoleNameSkeleton` in `@xecret/core/validation`: case, letter width, lookalike Cyrillic
and Greek letters and Latin accents folded), which no index can express. So the repository reads
every name in the organisation under the organisation lock and compares them in JavaScript —
race-free because every role write takes that lock — and the constraint stays behind it for
exact duplicates. Stored names are normalised first: variation selectors dropped, spaces
collapsed, NFC.

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
  revoked_at    timestamptz,
  sign_in_method    text,                     -- 0022; the approving session's, closed set
  sso_workos_org_id text                      -- 0022; likewise; only beside 'sso'
);
CREATE INDEX cli_tokens_lookup_idx ON cli_tokens (token_hash) WHERE revoked_at IS NULL;
-- cli_auth_codes (0005) gained the same two columns in 0022: the approval carries them to the
-- token, so a device approved from a password session is held to `sso_required` as that
-- session is.

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
        ├──< vault_pin_peppers                   │
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
org_members.custom_role_id references custom_roles (org_id, id) — same organisation, by
  composite FK; organizations ──< custom_roles (0017, not drawn above)
sessions ── reauthentications — at most one per session, also referencing users (0019, not
  drawn above)
users ──< retained_vaults ──< retained_vault_wraps, retained_vault_grants — a reset vault
  kept seven days; each grant also references env_data_keys (0020, not drawn above)
organizations ──< org_member_removals >── users — who was removed, so single sign-on does
  not re-admit them (0022, not drawn above)
users ──< sign_in_confirmations — a held-back sign-in, spent once (0022, not drawn above)
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
0014  env_key_grants.recipient_public_key — the one signed field the row did not carry
0015  unlock convenience: user_keys.auto_lock_minutes becomes nullable and
      range-checked [15, 720]; vault_pin_peppers (the server half of a device PIN)
0016  plans and entitlements (org_subscriptions, org_usage_counters,
      billing_webhook_events)
0017  custom roles (custom_roles, org_members.custom_role_id) — additive, every
      existing member keeps NULL
0018  WorkOS identity: users.workos_user_id, users.firebase_uid becomes nullable,
      organizations.workos_org_id and sso_required — additive, nothing dropped
0019  reauthentications — the vault reset's re-authentication, its user index and the
      application role's grant — additive
0020  retained vaults (retained_vaults, retained_vault_wraps, retained_vault_grants) —
      a reset vault kept seven days; CHECK pins the window, triggers refuse an early
      delete and any rewrite of key material; the application role's grants — additive
0021  SSO settings: organizations.jit_join_enabled (the just-in-time opt-in, default
      false) and organizations_sso_flags_need_link_check — additive; no new grant
0022  SSO, enforced: sessions / cli_auth_codes / cli_tokens .sign_in_method and
      .sso_workos_org_id (what per-request sso_required reads); organizations
      .workos_client_id (+ a CHECK added NOT VALID); org_member_removals (JIT never re-admits
      a removed member); sign_in_confirmations (the held-back sign-in, single-use) —
      additive; grants for the two new tables
0023  SSO, review round 2: workos_home (the WorkOS environment the database belongs to,
      seeded with production's; SELECT-only grant); a backfill of linked-but-clientless
      organisations and VALIDATE of organizations_workos_link_client_check;
      sessions.workos_session_id (the AuthKit session, ended at sign-out) and
      sessions.fresh_auth_at (the setup portal's step-up) — additive
0024  payments through Dodo (P12): org_subscriptions.current_period_start, .dodo_product_id,
      .dodo_event_at (the ordering guard for webhook snapshots), .renewal_amount_minor;
      billing_checkouts and billing_license_keys (insert-only grants — a checkout that
      happened, a licence issued, never the key), billing_seat_syncs (seat counts owed to
      Dodo), billing_reminders (the email deduplication, by primary key) — additive
0025  P12, review round 1: org_subscriptions.metered_from (usage is billed only from the
      activation or the trial's end), .dodo_mode (test and live never cross), .dodo_event_id
      (the tie-break for snapshots stamped alike), .on_hold_since (fourteen days ends the
      plan), .dodo_scheduled_change_at (seat pushes wait for it), .dodo_currency and
      .dodo_billing_country (what Dodo last reported); billing_checkouts.nonce (unique),
      .subscription_id and .consumed_at (column-level UPDATE grant only — a checkout attaches
      one subscription); billing_seat_syncs.generation, .claimed_until, .not_before,
      .dead_lettered_at (one push per organisation, cleared only under the generation it
      counted, retried only when due); the plan_ended_unpaid reminder; billing_requests
      (idempotency keys for checkout and plan change) — additive, one backfill of
      metered_from
0026  P12, review round 2: org_usage_counters.included_fetches — the allowance a usage
      month opened with (the plan's includedFetchesPerMonth with any support raise),
      raised and never lowered while the month is current; the overage meter bills a
      month against it alone, so a later downgrade or a cleared override never
      re-bills it, and a month without one is never billed. (A yearly plan's counter
      rows are months of its year, from the billing anniversary — no schema change.)
      — additive, one backfill from each organisation's current plan
0027  P12, review round 3: billing_reminders_kind_check widened with three once-only
      alerts (alert_unknown_product, alert_activation_waiting, alert_operator_managed) —
      the reminders' primary key deduplicates an error line the hourly job would
      otherwise repeat every run; never an email — constraint only, no backfill
```

Migration 0024 (P12) is additive and **must be applied before the code that reads it**: from that
build on every whole-row `select()` on `org_subscriptions` names the four new columns — the
billing screen and its routes, the webhook, the billing jobs, and the check that refuses to
delete an organisation (or an account's last organisation) Dodo still bills. Resolving an
organisation on a request reads only `entitlementColumns` and is unaffected. Applying it first is
harmless; older code never reads or writes any of it. `docs/operations/billing.md` §5.
Migration 0025 follows the same rule, and adds the membership changes to what needs it: from
that build `addMember` and `removeMember` write the seat-sync debt in their own transaction,
naming `billing_seat_syncs.generation`. Migration 0026 too: from that build the usage flush
writes `org_usage_counters.included_fetches` and the meter reads it. And 0027: from that build
the hourly billing job and the reconciler write the once-only alert kinds to `billing_reminders`.

Migration 0022 (WS-5, review round 1) is additive, and — like 0021 — **must be applied before
the code that names its columns**: from that build on every `select()` on `sessions`,
`cli_tokens`, `cli_auth_codes` and `organizations` names them, and fails against a database
without them. Applying it first is harmless; older code never writes the new columns, and every
row it writes satisfies the new CHECKs.

Migration 0023 (review round 2) is additive in the same way and the same rule applies — apply
it before the code. **One hard gate before applying it:** run `SELECT id, slug FROM
organizations WHERE workos_org_id IS NOT NULL AND workos_client_id IS NULL` and stop if it
returns a row you cannot vouch for. 0022's claim here was wrong: a `NOT VALID` CHECK does not
let such a row live quietly as "another environment's" — Postgres checks it on every UPDATE, so
the row cannot be renamed, soft-deleted, have its plan set or its SSO policies switched off.
0023 backfills every such row with the **production** client id, which is right only for a link
production code made (before 0022 nothing else could have). A row that is a Staging link must be
cleared first, with both flags off, by the remedy in `docs/operations/workos-environments.md`;
then apply 0023. And `workos_home` arrives seeded with the production client id — on a
self-hosted database, record your own straight after (`docs/self-hosting.md`).

Migration 0020 (P23) is additive: three new tables nothing older reads. **Apply it before
deploying the code that uses it** — the deployment-check skill lists it. The reverse order is
worse than a plain 500, because the reset does its irreversible-looking part first: a vault
reset **emails the archive and then fails** to retain the vault, so the person holds the email,
nothing was reset, and their reset proof is spent (a retry needs a new sign-in and code);
Settings → Security shows an error in place of its "Recover a previous vault" card for every
unlocked account, because the card reads the retained tables; and the hourly purge Cron Trigger fails every run. The triggers
compare against the database's own `now()` with a pinned `search_path` and qualified table
names, so neither an application clock nor a session-local table can push a delete earlier
than seven days after the reset; the application role may update only the recovery
bookkeeping columns, and nothing in the application issues a delete before then.

Migration 0018 is the storage half of the move from Firebase to WorkOS (ADR 0010) and drops
nothing: `firebase_uid` stays, nullable, until a decommission migration — which must replace
`users_identity_present_check`, because dropping the column drops the constraint with it.
Apply 0018 before deploying code that selects the new columns: Drizzle's `select()` names every
column the schema declares, so from that build on every read of `users` or `organizations` —
the per-request session lookup among them — fails against a database without them. The reverse
order is safe. The same holds for 0019, where the cost of getting it wrong is confined to the
vault reset — its sign-in included, since the callback writes that session and its
`reauthentications` row in one transaction. 0019 was amended in place (the grant, the index,
`code_failures` renamed `code_attempts`, the two MFA columns, `code_sends`) before any database
applied it.

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

Migration 0015 reshapes a column rather than adding one. `user_keys.auto_lock_minutes` has existed
since 0008 (as `user_pins.auto_lock_minutes`) and drove only a timer in the browser; from 0015 it is
also what the *server's* unlock gate measures `sessions.vault_unlocked_at` against, so the client
timer and the API cannot disagree. It becomes nullable — `NULL` is "no preference", which follows
`DEFAULT_AUTO_LOCK_MINUTES` — and its CHECK becomes the range `[15, 720]` rather than the old menu.
The value `0`, "never", is deliberately no longer expressible: a window the server honours cannot be
infinite. Live rows are remapped to the nearest offered interval, and `0` becomes `NULL`.
`vault_pin_peppers` is created empty and is not catalogued above; the device-PIN flows that use it
arrive with the client that enrols them.

Migration `0002` is not optional. The application role gets `SELECT`/`INSERT`/`UPDATE`/
`DELETE` on tenant tables, `SELECT`/`INSERT` only on `audit_logs`, and no DDL rights
anywhere. Migrations run as a separate, more privileged role.

## 11. Deferred to later phases

`webhooks` · `secret_references` for
cross-environment inheritance · `billing_*` (the `seat_limit` column is the only hook needed
now) · `oidc_trust_policies` for GitHub Actions federation (Phase 8 designs the token table
for it; the feature is v2).
