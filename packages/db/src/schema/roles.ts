import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { Action } from '@xecret/core/authz';
import { accessLevelEnum, orgRoleEnum } from './enums';
import { users } from './identity';
// A cycle: ./tenancy imports `customRoles` back for the foreign key on
// `org_members`. Safe, because neither side reads the other's binding while
// its module is evaluating — this one only inside a `references()` thunk, that
// one only inside the table's extra-config callback, which drizzle calls
// lazily from `getTableConfig`.
import { organizations } from './tenancy';

/**
 * Roles an organisation defined for itself — Enterprise only.
 *
 * The `customRoles` feature is on for Enterprise and off for every other plan
 * (`ENTERPRISE_FEATURES` in `packages/core/src/entitlements/plans.ts`, which
 * also says why it stops there rather than at Team). Nothing in this table
 * enforces the plan: the entitlement gate belongs to whatever writes it.
 *
 * ── A custom role only ever subtracts ──
 * Every row names a `base_role`, and a member holding it is resolved through
 * their effective role — the lower of their own `role` and this `base_role` —
 * ANDed with the row's action list, never through the custom row alone
 * (`effectiveRole` and `effectiveCapabilities` in `@xecret/core/authz`). So no
 * row in this table — malformed, hand-edited, or written by an attacker who
 * reached the database — can grant a member a capability their own role does
 * not already hold. Escalation through this table is unreachable rather than
 * validated against, which is the only version of that claim worth making.
 *
 * It is the same one-way shape as `limitOverrides` on `org_subscriptions`: a
 * mechanism with a single direction has no bugs in the other one.
 *
 * ── Owners are never narrowed ──
 * No row is based on `owner` (`custom_roles_base_role_check`, below), and no
 * owner holds a custom role (`org_members_owner_custom_role_check` on
 * `orgMembers`). Together they keep "stored `owner`" and "effective owner" the
 * same set of members, which is what lets the last-owner rule count
 * `role = 'owner'` rows and be right about who can still act as one.
 */
export const customRoles = pgTable(
  'custom_roles',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),

    /**
     * The built-in role this narrows. The member's effective role — the lower
     * of this and their own `role` — is the ceiling on everything below.
     *
     * `canDefineCustomRole` refuses a base above the creator's own role — the
     * same predicate as `canAssignRole` — and refuses `owner` outright, which
     * `custom_roles_base_role_check` repeats at the database.
     */
    baseRole: orgRoleEnum('base_role').notNull(),

    /**
     * The actions this role may perform, intersected with the effective role's
     * — the lower of the member's `role` and `baseRole`.
     *
     * A positive list, not a deny list: an `Action` added to the product later
     * is denied to every existing custom role until an administrator opts in.
     * The cost is a support conversation when a new capability does not appear;
     * the alternative is a capability nobody decided to grant.
     */
    allowedActions: text('allowed_actions').array().$type<Action[]>().notNull().default([]),

    /**
     * An optional ceiling on the level this role reaches, per environment kind.
     *
     * Null means "no ceiling", and the effective role's defaults — the lower of
     * the member's `role` and `baseRole` — apply unchanged.
     * When set, it caps the **resolved** level rather than only the default —
     * a ceiling an explicit grant could exceed would not be a ceiling, and the
     * point of "a developer who can never reach production" is that it stays
     * true the first time somebody writes a production grant by mistake.
     */
    ceilingNonProduction: accessLevelEnum('ceiling_non_production'),
    ceilingProduction: accessLevelEnum('ceiling_production'),

    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Also the index behind every "this organisation's roles" read: its btree
    // leads with org_id, so no separate index on org_id is needed.
    unique('custom_roles_org_name_unique').on(t.orgId, t.name),
    // Redundant as a uniqueness rule — `id` alone is already unique — and there
    // only to be the target of the composite foreign key from `org_members`
    // (`orgMembers` in ./tenancy), which is what stops a member of one
    // organisation holding another organisation's role.
    unique('custom_roles_org_id_id_unique').on(t.orgId, t.id),
    // Both halves of a ceiling or neither. A half-set ceiling would apply in one
    // kind of environment and not the other, which is a rule nobody can state
    // and therefore a rule nobody can audit.
    check(
      'custom_roles_ceiling_check',
      sql`(${t.ceilingNonProduction} is null) = (${t.ceilingProduction} is null)`,
    ),
    // Half of "owners are never narrowed" (see above). An owner-based role
    // behaves differently from the same role based on `admin` only while an
    // owner holds it, and `org_members_owner_custom_role_check` forbids an
    // owner holding any — so the base could only mean something in a state the
    // schema refuses. Migration 0017 says the same beside the SQL.
    check('custom_roles_base_role_check', sql`${t.baseRole} <> 'owner'`),
  ],
);
