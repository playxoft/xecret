import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { Action } from '@xecret/core/authz';
import { accessLevelEnum, orgRoleEnum } from './enums';
import { users } from './identity';
import { organizations } from './tenancy';

/**
 * Roles an organisation defined for itself — Scale and above.
 *
 * ── A custom role only ever subtracts ──
 * Every row names a `base_role` and is resolved as `base AND custom`, never as
 * the custom row alone (`effectiveCapabilities` in `@xecret/core/authz`). So no
 * row in this table — malformed, hand-edited, or written by an attacker who
 * reached the database — can grant a capability its base role does not already
 * hold. Escalation through this table is unreachable rather than validated
 * against, which is the only version of that claim worth making.
 *
 * It is the same one-way shape as `limitOverrides` on `org_subscriptions`: a
 * mechanism with a single direction has no bugs in the other one.
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
     * The built-in role this narrows, and the ceiling on everything below.
     *
     * `canDefineCustomRole` refuses a base above the creator's own role — the
     * same predicate as `canAssignRole`, so an admin cannot define an
     * owner-based role, assign it to themselves and hold owner authority under
     * another name.
     */
    baseRole: orgRoleEnum('base_role').notNull(),

    /**
     * The actions this role may perform, intersected with the base role's.
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
     * Null means "no ceiling" and the base role's defaults apply unchanged.
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
    unique('custom_roles_org_name_unique').on(t.orgId, t.name),
    // Both halves of a ceiling or neither. A half-set ceiling would apply in one
    // kind of environment and not the other, which is a rule nobody can state
    // and therefore a rule nobody can audit.
    check(
      'custom_roles_ceiling_check',
      sql`(${t.ceilingNonProduction} is null) = (${t.ceilingProduction} is null)`,
    ),
    index('custom_roles_org_idx').on(t.orgId, t.name),
  ],
);
