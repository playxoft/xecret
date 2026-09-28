import * as z from 'zod/mini';
import {
  ACTION_REQUIREMENTS,
  authoritySummary,
  CUSTOM_ROLE_BASE_ROLES,
  CUSTOM_ROLE_FLOOR,
} from '@xecret/core/authz';
import type { AccessLevel, Action, CustomRole, OrgRole } from '@xecret/core/authz';
import {
  CUSTOM_ROLE_NAME_MAX_LENGTH,
  customRoleNameProblem,
  normalizeCustomRoleName,
} from '@xecret/core/validation';
import type { AuditMetadata } from '@xecret/core/audit';
import type {
  CustomRoleCeiling,
  CustomRoleDefinition,
  CustomRoleRecord,
} from '@xecret/db/repositories';
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

/**
 * A role's name, normalised (`normalizeCustomRoleName`: variation selectors
 * dropped, spaces collapsed, NFC, trimmed) and held to the rules
 * `customRoleNameProblem` states: nothing invisible, something visible, not
 * a built-in role's name or a lookalike of one, no Latin mixed with Cyrillic
 * or Greek, and a bounded length. The dashboard reads the same functions, so
 * the form and the API refuse the same names with the same sentence.
 * Uniqueness — on the name's skeleton, so case, width and lookalike letters
 * do not make two names — is the repository's, under the organisation lock.
 */
const nameSchema = z.string().check(
  // A bound before the work, so a hostile body cannot make normalisation long.
  // NFC composes at most a few code units into one, so eight times the limit
  // is over it whatever the name normalises to.
  z.maxLength(
    CUSTOM_ROLE_NAME_MAX_LENGTH * 8,
    `A role name must be at most ${CUSTOM_ROLE_NAME_MAX_LENGTH} characters.`,
  ),
  z.overwrite(normalizeCustomRoleName),
  z.superRefine((name, context) => {
    const problem = customRoleNameProblem(name);
    if (problem !== null) context.addIssue({ code: 'custom', message: problem });
  }),
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

/* ── Comparing definitions ──────────────────────────────────────────────────── */

/**
 * A role's action list as the engine applies it: a set, with the
 * `CUSTOM_ROLE_FLOOR` in it whether or not it was listed — the engine keeps
 * `member.read` either way, so a list that gains or loses only the floor has
 * not changed what anybody may do.
 */
function appliedActions(actions: readonly Action[]): string {
  return [...new Set([...actions, ...CUSTOM_ROLE_FLOOR])].sort().join(',');
}

/**
 * Whether two definitions give a holder the same authority: the same base, the
 * same actions as applied, the same ceiling. The name is not access.
 *
 * What decides whether an edit needs the holders' environment keys reconciled —
 * a rename moves nobody.
 */
export function sameAccess(a: CustomRoleDefinition, b: CustomRoleDefinition): boolean {
  return (
    a.baseRole === b.baseRole &&
    appliedActions(a.allowedActions) === appliedActions(b.allowedActions) &&
    a.accessCeiling?.nonProduction === b.accessCeiling?.nonProduction &&
    a.accessCeiling?.production === b.accessCeiling?.production
  );
}

/**
 * Whether an edit changes anything at all. One that does not is answered
 * without a write, an audit record, a plan check or a new `updated_at`.
 */
export function sameDefinition(a: CustomRoleDefinition, b: CustomRoleDefinition): boolean {
  return a.name === b.name && sameAccess(a, b);
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
