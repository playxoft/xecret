import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AccessLevel } from '@xecret/core/authz';
import { bytea, citext } from './columns';
import { memberStatusEnum, orgRoleEnum } from './enums';
import { users } from './identity';
// A cycle — ./roles imports `organizations` from here. Safe for the reason
// given at the `foreignKey` below; the note on the other side says the same.
import { customRoles } from './roles';

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    slug: citext('slug').notNull().unique(),
    /**
     * The seat ceiling **invitations are actually refused against**, by
     * `assertSeatAvailable` under the organisation's row lock.
     *
     * Not the same number as `FREE_LIMITS.seats`, which is 3. This column
     * predates the plans table, nothing sets it from the plan at provisioning
     * time, and the default of 5 is therefore what a Free organisation gets.
     * The gap has narrowed — it was 1 against 5 — and it is still a gap. The
     * divergence is deliberate and documented at both ends — see the note on
     * `seats` in `packages/core/src/entitlements/plans.ts` — and it closes when
     * payments land.
     *
     * Two columns rather than one once billing exists: this is what the member
     * service enforces, `org_subscriptions.seats` is what the invoice says, and
     * their failure modes differ. `setBilledSeats` writes the pair in one
     * transaction so nothing can move one without the other.
     */
    seatLimit: integer('seat_limit').notNull().default(5),
    /**
     * The WorkOS Organization this maps to, or null.
     *
     * Created **lazily** — only when an organisation actually enables SSO. The
     * overwhelming majority of organisations here are personal ones
     * auto-provisioned at first login, and minting a WorkOS Organization for
     * every one of those would fill the provider's tenant list with rows that
     * exist for nobody.
     */
    workosOrgId: text('workos_org_id').unique(),
    /**
     * The WorkOS environment — by its client id — that `workos_org_id` was
     * created in (migration 0022). A WorkOS organisation id means something only
     * in its own environment, and local development runs against WorkOS
     * Staging over the production database; the settings routes refuse a link
     * whose client id is not this deployment's `WORKOS_CLIENT_ID`. Written with
     * the link, never without it (`organizations_workos_link_client_check`).
     */
    workosClientId: text('workos_client_id'),
    /**
     * When true, a non-owner member of this organisation reaches it only
     * through its own single sign-on.
     *
     * Enforced **on every request**, by the organisation resolution
     * (`resolveOrg` in `server/tenancy.ts`), against how the presenting session
     * or CLI token signed in (`sessions.sso_workos_org_id`) — so switching it on
     * takes effect at once for credentials issued before, and other
     * organisations the member belongs to are unaffected. The sign-in callback
     * refuses a sign-in only when it would leave the account no organisation it
     * could use. Set only by `updateOrgSsoSettings`, behind the organisation SSO
     * settings route (an owner, the SAML add-on, an active connection and a
     * verified domain to turn it on).
     *
     * Enforcement exempts the organisation's **owners** — a deliberate
     * break-glass, and a trade-off rather than a free one: an identity provider
     * misconfigured after this is switched on would otherwise lock the
     * organisation out of its own account with no self-service way back, and
     * "contact support" is not a recovery story for a secrets manager. The cost
     * is that an owner's password (or Google sign-in) stays a way into the
     * organisation that its identity provider does not govern; every such
     * sign-in is audited in the organisation as `auth.sso_exemption_used`.
     *
     * Never true without `workos_org_id` (`organizations_sso_flags_need_link_check`).
     */
    ssoRequired: boolean('sso_required').notNull().default(false),
    /**
     * When true, somebody signing in through this organisation's SSO connection
     * — for an address in one of its verified domains — is made a member on the
     * spot, as a `viewer`, while seats last (just-in-time provisioning).
     *
     * An explicit opt-in, off by default (migration 0021). Connecting an
     * identity provider says who the organisation's people *are*; admitting
     * all of them is a second decision, and an owner or admin takes it here.
     * Read under the organisation's row lock by `joinOrganizationJustInTime`.
     *
     * Never true without `workos_org_id` (`organizations_sso_flags_need_link_check`).
     */
    jitJoinEnabled: boolean('jit_join_enabled').notNull().default(false),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('organizations_seat_limit_check', sql`${t.seatLimit} >= 0`),
    // Both SSO flags are about the organisation's connection, and an
    // organisation with no WorkOS link has none — see migration 0021.
    check(
      'organizations_sso_flags_need_link_check',
      sql`(${t.ssoRequired} = false and ${t.jitJoinEnabled} = false) or ${t.workosOrgId} is not null`,
    ),
    // A link is always recorded with the environment it was made in. Added NOT
    // VALID by 0022 and validated by 0023, after a backfill: Postgres checks a
    // NOT VALID constraint on every UPDATE, so a violating row could not even
    // be renamed.
    check(
      'organizations_workos_link_client_check',
      sql`${t.workosOrgId} is null or ${t.workosClientId} is not null`,
    ),
    // Read on every organisation creation, inside the transaction that creates
    // one: `countOrganizationsHeldBy` asks how many live organisations this
    // account created and is still in. The column order is the query's —
    // equality on `created_by`, then `id` to supply the ordering — so its
    // `LIMIT` can stop after the ceiling's worth of rows instead of finding
    // every organisation the account ever created and sorting the lot. Left
    // ascending: the query wants `id desc`, and a btree is read backwards for
    // that at no cost. Partial, because the count never looks at a soft-deleted
    // row. The membership half of the join is already served by
    // `org_members_org_user_unique`.
    index('organizations_creator_idx')
      .on(t.createdBy, t.id)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * The table every authorization query passes through.
 *
 * INVARIANT, enforced in application code and tested explicitly: an
 * organisation always retains at least one active `owner`. Removing or demoting
 * the last owner is rejected. Counting `role = 'owner'` rows answers it
 * correctly only because an owner cannot hold a custom role
 * (`org_members_owner_custom_role_check`, below) — so every stored owner is an
 * effective one.
 */
export const orgMembers = pgTable(
  'org_members',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgRoleEnum('role').notNull(),

    /**
     * A custom role narrowing `role`, or null for the built-in role as-is.
     *
     * **`role` is never replaced.** The custom role is a narrowing applied on
     * top — the lower of `role` and its `baseRole` governs, ANDed with its
     * action list — which is what keeps `canAssignRole` meaningful and what
     * makes a null here mean exactly what it meant before this column existed.
     *
     * Always null for an owner (`org_members_owner_custom_role_check`, below).
     *
     * The foreign key is composite — `(org_id, custom_role_id)` against
     * `custom_roles (org_id, id)`, declared with the table's constraints below
     * — so a member can only ever hold a role of their own organisation. A null
     * skips it (MATCH SIMPLE) and needs no row to point at.
     *
     * `ON DELETE NO ACTION`, deliberately. The other actions are worse:
     *   - `SET NULL` would silently **widen** every member holding the role the
     *     moment it was deleted — a "Deployer" who could not touch production
     *     becomes a plain developer who can, with no act that looks like a
     *     permission change and nothing in the audit log that reads as one.
     *   - `CASCADE` would delete the members.
     * So a role in use cannot be deleted until its members are moved off it,
     * and the widening becomes something an administrator did on purpose.
     *
     * NO ACTION rather than `restrict`: Postgres blocks the same deletes with
     * either, but `restrict` changed its error from 23503 to 23001 in Postgres
     * 18, and "role still in use" is an error the application maps. Migration
     * 0017 explains why hard-deleting the organisation still cascades cleanly,
     * whichever of the two cascades from `organizations` fires first.
     */
    customRoleId: uuid('custom_role_id'),
    status: memberStatusEnum('status').notNull().default('active'),
    seatAssigned: boolean('seat_assigned').notNull().default(true),
    invitedBy: uuid('invited_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('org_members_org_user_unique').on(t.orgId, t.userId),
    // The single most performance-critical index in the schema: authorization
    // resolves through it on every request.
    index('org_members_user_idx')
      .on(t.userId)
      .where(sql`${t.status} = 'active'`),
    index('org_members_org_idx')
      .on(t.orgId)
      .where(sql`${t.status} = 'active'`),
    // See `customRoleId`. Here, in the extra config, because a composite key
    // cannot be written with `.references()` — and it is also what makes the
    // import cycle with ./roles safe: drizzle calls this callback lazily, from
    // `getTableConfig`, after both modules have finished evaluating.
    foreignKey({
      name: 'org_members_org_id_custom_role_id_custom_roles_org_id_id_fk',
      columns: [t.orgId, t.customRoleId],
      foreignColumns: [customRoles.orgId, customRoles.id],
    })
      .onDelete('no action')
      .onUpdate('no action'),
    // Read by the foreign key's own check when a role is deleted, and by the
    // "is this role still in use?" and "who holds this role?" questions the
    // role-management API will ask. Partial, because nearly every row carries
    // null and none of them is ever the answer.
    index('org_members_custom_role_idx')
      .on(t.customRoleId)
      .where(sql`${t.customRoleId} is not null`),
    // An owner is never narrowed. With `custom_roles_base_role_check` this keeps
    // "stored `owner`" and "effective owner" the same set of members, so the
    // last-owner guard and the account-deletion summary can count owners from
    // `role` and `status` alone and still count the ones who can act as owners.
    // Without it, a sole owner narrowed to a role that cannot manage members
    // would be counted as the owner keeping the organisation alive while unable
    // to be one, with nobody above them to repair it.
    //
    // `updateMemberRole` clears the reference in the same UPDATE that promotes
    // somebody to owner, since this would otherwise reject the promotion.
    check(
      'org_members_owner_custom_role_check',
      sql`${t.customRoleId} is null or ${t.role} <> 'owner'`,
    ),
  ],
);

/**
 * Somebody removed from an organisation (migration 0022).
 *
 * Removal deletes the `org_members` row, and this is what is left: the record
 * the just-in-time join reads before it admits anybody, so that a person
 * removed here but still in the organisation's identity provider is not
 * re-admitted by their next single sign-on. Accepting an invitation sent after
 * the removal deletes it; one sent before it cannot.
 */
export const orgMemberRemovals = pgTable(
  'org_member_removals',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Who removed them; `null` when nobody else did (an account deleting itself). */
    removedBy: uuid('removed_by').references(() => users.id, { onDelete: 'set null' }),
    removedAt: timestamp('removed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'org_member_removals_pkey', columns: [t.orgId, t.userId] })],
);

/**
 * The WorkOS environment this database belongs to: one row, the client id
 * whose organisation ids `organizations.workos_org_id` may hold (migration
 * 0023).
 *
 * Read, never written, by the application — the role may only SELECT it.
 * Turning SSO on (the only writer of a link) and switching an SSO policy on
 * both refuse unless this deployment's `WORKOS_CLIENT_ID` is the one recorded
 * here, so local development against WorkOS Staging over the production
 * database cannot write a link no production sign-in can ever come through.
 * Recording it is an operator's act (docs/self-hosting.md).
 */
export const workosHome = pgTable(
  'workos_home',
  {
    /** Always `true`: a primary key with one possible value is a one-row table. */
    id: boolean('id').primaryKey().default(true),
    clientId: text('client_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('workos_home_single_row_check', sql`${t.id}`),
    check('workos_home_client_id_check', sql`${t.clientId} ~ '^client_[0-9A-Za-z]+$'`),
  ],
);

/**
 * One selection in an invitation's `initial_grants` snapshot.
 * `environmentId: null` selects the whole project.
 */
export interface InvitationGrantSeed {
  projectId: string;
  environmentId: string | null;
  /**
   * The level to write at acceptance. Absent — which every seed written
   * before the invite dialog offered levels is — falls back to the invited
   * role's ordinary (non-production) default, exactly as it always did.
   *
   * Optional rather than a column default because this is a jsonb snapshot:
   * old rows keep their old shape, and the reader is the only place that has
   * to know both. `'none'` is representable and meaningful — an explicit
   * denial written at acceptance.
   */
  accessLevel?: AccessLevel;
}

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: citext('email').notNull(),
    role: orgRoleEnum('role').notNull(),
    tokenHash: bytea('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    /**
     * The access the inviter selected, applied when the invitation is accepted.
     *
     * `NULL` means the invitation predates selection and acceptance behaves as
     * it always did: role defaults everywhere. Non-null — an empty array
     * included — switches acceptance to **deny-by-default**: every project the
     * organisation has at acceptance time receives an explicit `none` grant
     * unless it appears here, and each listed environment receives a grant at
     * the level the seed names, or at the invited role's non-production level
     * when it names none.
     *
     * A snapshot in jsonb rather than a relational table on purpose: these
     * rows are a *request in transit*, not live authority. Authority only
     * exists once acceptance copies them into `access_grants`, which is where
     * the relational modelling, the uniqueness rules and the audit live.
     * Entries are ids, not slugs — a rename must not re-address a grant — and
     * anything that no longer exists at acceptance is simply skipped.
     */
    initialGrants: jsonb('initial_grants').$type<InvitationGrantSeed[] | null>(),
    /**
     * The invitation's X25519 **public** key, 32 raw bytes (spec §10).
     *
     * The inviter's client generates a 16-byte fragment, derives a keypair from
     * it, seals the relevant EDK and EHK grants to this public key, and uploads
     * the public half here. The fragment itself **never reaches the server** —
     * it travels to the invitee out of band, over a different channel from the
     * emailed `xin_…` token, which is the whole of the two-channel design: a
     * leaked email decrypts nothing, and a leaked fragment authenticates nothing.
     *
     * Nullable, because an invitation into an organisation whose environments are
     * all `server`-mode carries no grants and needs no keypair.
     */
    invitePublicKey: bytea('invite_public_key'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Blocks invitation spam to one address while still permitting re-invitation
    // after the previous invitation expires or is revoked.
    uniqueIndex('invitations_pending_idx')
      .on(t.orgId, t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
  ],
);
