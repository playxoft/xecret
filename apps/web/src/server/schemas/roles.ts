import * as z from 'zod/mini';
import { ACTION_REQUIREMENTS, authoritySummary, CUSTOM_ROLE_BASE_ROLES } from '@xecret/core/authz';
import type { AccessLevel, Action, CustomRole, OrgRole } from '@xecret/core/authz';
import { CUSTOM_ROLE_NAME_MAX_LENGTH } from '@xecret/core/validation';
import type { AuditMetadata } from '@xecret/core/audit';
import type { CustomRoleCeiling, CustomRoleRecord } from '@xecret/db/repositories';
import { accessLevelSchema, toCustomRoleRef } from './members';
import type { CustomRoleRef } from './members';

/**
 * The request schemas and response shapes of the custom-role routes, and the
 * authority summary `/api/auth/me` and `/authority` send.
 *
 * The same rules as `members.ts`: bodies are `strictObject` with a fixed
 * unknown-field message, the vocabularies — actions, bases, levels — come from
 * `@xecret/core` rather than being restated, and the serialisers list their
 * fields so nothing reaches a client by being added to a table later.
 */

const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';

/** Every action there is, from the table that makes the union exhaustive. */
const ACTIONS = Object.keys(ACTION_REQUIREMENTS) as [Action, ...Action[]];

const actionSchema = z.enum(ACTIONS, 'That is not an action this product knows.');

/**
 * The bases a custom role may have — every built-in role but `owner`.
 *
 * Refused here, as a field error, rather than left for `canDefineCustomRole`
 * to refuse as a 403: an owner-based role is not something anybody is
 * entitled to, so it is a malformed request rather than one beyond the
 * caller's authority. The authority check still runs for the three that are
 * accepted.
 */
const baseRoleSchema = z.enum(
  CUSTOM_ROLE_BASE_ROLES as [OrgRole, ...OrgRole[]],
  'A custom role is based on admin, developer or viewer — never owner.',
);

const nameSchema = z
  .string()
  .check(
    z.trim(),
    z.minLength(1, 'A role needs a name.'),
    z.maxLength(
      CUSTOM_ROLE_NAME_MAX_LENGTH,
      `A role name must be at most ${CUSTOM_ROLE_NAME_MAX_LENGTH} characters.`,
    ),
  );

/**
 * Both halves of a ceiling, or `null` for none.
 *
 * One object rather than two nullable fields, so "half a ceiling" — which the
 * database refuses (`custom_roles_ceiling_check`) and nobody could state as a
 * rule — cannot be written at all.
 */
const ceilingSchema = z.nullable(
  z.strictObject(
    { nonProduction: accessLevelSchema, production: accessLevelSchema },
    UNEXPECTED_FIELD,
  ),
);

/**
 * The action list: at most one of each action there is. Duplicates are
 * tolerated — the repository stores each action once — but the bound is the
 * size of the vocabulary, so a hostile body cannot make the array large.
 */
const allowedActionsSchema = z.array(actionSchema).check(z.maxLength(ACTIONS.length * 2));

/** Defining a role: everything, explicitly. An omitted ceiling means none. */
export const customRoleCreateSchema = z.strictObject(
  {
    name: nameSchema,
    baseRole: baseRoleSchema,
    allowedActions: allowedActionsSchema,
    accessCeiling: z.optional(ceilingSchema),
  },
  UNEXPECTED_FIELD,
);

/**
 * Editing one: any of the four, at least one. The route merges the patch onto
 * the role as it stands, and every authority check runs on the merged result.
 */
export const customRolePatchSchema = z
  .strictObject(
    {
      name: z.optional(nameSchema),
      baseRole: z.optional(baseRoleSchema),
      allowedActions: z.optional(allowedActionsSchema),
      accessCeiling: z.optional(ceilingSchema),
    },
    UNEXPECTED_FIELD,
  )
  .check(
    z.refine((patch) => Object.values(patch).some((value) => value !== undefined), {
      message: 'Provide at least one field to change.',
    }),
  );

export type CustomRoleCreateRequest = z.infer<typeof customRoleCreateSchema>;
export type CustomRolePatchRequest = z.infer<typeof customRolePatchSchema>;

/* ── Responses ────────────────────────────────────────────────────────────── */

export interface CustomRolePayload {
  id: string;
  name: string;
  baseRole: OrgRole;
  allowedActions: Action[];
  /** `null` when the role sets no ceiling. */
  accessCeiling: { nonProduction: AccessLevel; production: AccessLevel } | null;
  /** Present on the listing; how many members hold the role. */
  holderCount?: number;
  createdAt: string;
  updatedAt: string;
}

export function toCustomRolePayload(
  role: CustomRoleRecord,
  holderCount?: number,
): CustomRolePayload {
  return {
    id: role.id,
    name: role.name,
    baseRole: role.baseRole,
    // In table order, so the same role reads the same way whatever order it
    // was written in.
    allowedActions: ACTIONS.filter((action) => role.allowedActions.includes(action)),
    accessCeiling: role.accessCeiling,
    ...(holderCount === undefined ? {} : { holderCount }),
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
  };
}

/**
 * What a member may do in one organisation, for the dashboard to draw its
 * controls from — `authoritySummary`, plus the stored role and the custom role
 * so the label can say both.
 *
 * `role` stays the stored role: it is what the member *is*, and what the list
 * shows. `effectiveRole` and `capabilities` are what they may *do*, which is
 * what a control should ask. A convenience, like the rest of `/api/auth/me` —
 * every request behind a control is still decided by `can()`.
 */
export interface AuthorityPayload {
  role: OrgRole;
  customRole: CustomRoleRef | null;
  effectiveRole: OrgRole;
  capabilities: readonly Action[];
  assignableRoles: readonly OrgRole[];
  definableBaseRoles: readonly OrgRole[];
}

export function toAuthorityPayload(
  role: OrgRole,
  customRole: CustomRole | undefined,
): AuthorityPayload {
  const summary = authoritySummary({ role, customRole });
  return {
    role,
    customRole: toCustomRoleRef(customRole),
    effectiveRole: summary.effectiveRole,
    capabilities: summary.capabilities,
    assignableRoles: summary.assignableRoles,
    definableBaseRoles: summary.definableBaseRoles,
  };
}

/** A request's ceiling, as the repository stores one. */
export function toStoredCeiling(
  ceiling: { nonProduction: AccessLevel; production: AccessLevel } | null | undefined,
): CustomRoleCeiling | null {
  return ceiling === null || ceiling === undefined
    ? null
    : { nonProduction: ceiling.nonProduction, production: ceiling.production };
}

/* ── Audit ────────────────────────────────────────────────────────────────── */

/** The fields of a role an audit record describes it by. */
type AuditedRole = Pick<
  CustomRoleRecord,
  'id' | 'name' | 'baseRole' | 'allowedActions' | 'accessCeiling'
>;

/**
 * A role's whole definition, as the metadata of the record that created,
 * edited or deleted it. The builder keeps the action list to action names and
 * the ceiling to levels, and cleans the name like any organisation-chosen
 * string.
 */
export function roleDefinitionMetadata(role: AuditedRole): AuditMetadata {
  return {
    customRoleId: role.id,
    customRoleName: role.name,
    baseRole: role.baseRole,
    allowedActions: role.allowedActions,
    accessCeiling: role.accessCeiling,
  };
}

/** The definition an edit replaced, beside `roleDefinitionMetadata` of the new one. */
export function previousRoleDefinitionMetadata(role: AuditedRole): AuditMetadata {
  return {
    previousCustomRoleName: role.name,
    previousBaseRole: role.baseRole,
    previousAllowedActions: role.allowedActions,
    previousAccessCeiling: role.accessCeiling,
  };
}
