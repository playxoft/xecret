import { z } from 'zod';
import type { ZodType } from 'zod';
import type { OrgRole } from '@xecret/core/authz';
import {
  environmentSlugSchema,
  isReservedSlug,
  slugSchema,
  slugify,
  SLUG_MAX_LENGTH,
} from '@xecret/core/validation';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@xecret/db/repositories';
import type {
  EnvironmentRecord,
  Organization,
  ProjectListItem,
  ProjectRecord,
} from '@xecret/db/repositories';
import { errors } from '../errors';

/**
 * The request schemas and response shapes of the organisation, project and
 * environment routes.
 *
 * Both halves live together because they are the same contract seen from two
 * sides, and because a shape that is written out once cannot drift between the
 * four routes that return it — `docs/architecture/api.md` §1 addresses every
 * resource by slug, and one route spelling a field differently would split the
 * client in half with no error anywhere.
 *
 * Three rules run through the whole file:
 *
 *  1. **Slugs come from `@xecret/core/validation`.** `slugSchema` already knows
 *     the pattern, the length ceiling and the reserved list. A second regular
 *     expression here would be a second definition of what a valid identifier
 *     is, and the two would eventually disagree.
 *  2. **A slug is never accepted as a change.** It is the identifier committed
 *     to `.xecret.yaml` and pasted into CI, so the patch schemas admit the field
 *     only in order to refuse it with an explanation — see
 *     `assertSlugImmutable`.
 *  3. **A response says what the caller may know.** The serialisers list their
 *     columns explicitly, so an internal id or a `deleted_at` cannot reach a
 *     client by being added to a table later.
 */

/**
 * Bounds on free text.
 *
 * A name lands in listings, in the audit log and in page titles; a description
 * lands under it. Neither column is length-constrained in PostgreSQL, so this is
 * the only limit there is, and its job is to stop one organisation storing a
 * megabyte where a label was expected.
 */
export const NAME_MAX_LENGTH = 100;
export const DESCRIPTION_MAX_LENGTH = 500;

/**
 * The display order of an environment.
 *
 * Bounded because `environments.sort_order` is a PostgreSQL `integer`: a value
 * past 2^31 fails in the driver, which would surface as a 500 rather than as the
 * validation error it plainly is. The ceiling is far above any real list.
 */
export const SORT_ORDER_MAX = 10_000;

/**
 * The message for a field the endpoint does not accept.
 *
 * Fixed, rather than zod's default, which names the rejected key back at the
 * caller. Nothing derived from a request body belongs in a response body in this
 * product (see `errors.ts`), and a key is still something a stranger chose.
 */
const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';

/** At least one recognised field, so an empty patch is a stated error rather than a silent no-op. */
const NON_EMPTY_PATCH = 'Provide at least one field to update.';

const nameSchema = z
  .string()
  .trim()
  .min(1, 'A name cannot be empty.')
  .max(NAME_MAX_LENGTH, `A name must be at most ${NAME_MAX_LENGTH} characters.`);

/**
 * Nullable so a description can be cleared. `undefined` means "leave it alone";
 * `null` means "remove it" — a distinction the repository already understands
 * and one a client cannot otherwise express.
 */
const descriptionSchema = z
  .string()
  .trim()
  .max(
    DESCRIPTION_MAX_LENGTH,
    `A description must be at most ${DESCRIPTION_MAX_LENGTH} characters.`,
  )
  .nullable();

/**
 * Accepted so it can be refused.
 *
 * Declaring `slug` and rejecting it in the handler produces a 400 that says why
 * the field cannot be changed. Leaving it out would make it an unrecognised key
 * — a 422 that reads as a typo — and stripping it silently would be worse still:
 * the caller would believe the rename succeeded.
 */
const immutableSlugField = z.unknown().optional();

export const organizationPatchSchema = z
  .strictObject({ name: nameSchema.optional(), slug: immutableSlugField }, UNEXPECTED_FIELD)
  // Any recognised key satisfies this, `slug` included, so a body that names
  // only the slug reaches `assertSlugImmutable` and gets the precise refusal
  // instead of a generic "nothing to update".
  .refine((patch) => Object.keys(patch).length > 0, { message: NON_EMPTY_PATCH });

export const projectCreateSchema = z.strictObject(
  {
    name: nameSchema,
    /** Optional: derived from the name when absent. See `resolveProjectSlug`. */
    slug: slugSchema.optional(),
    description: descriptionSchema.optional(),
  },
  UNEXPECTED_FIELD,
);

export const projectPatchSchema = z
  .strictObject(
    {
      name: nameSchema.optional(),
      description: descriptionSchema.optional(),
      slug: immutableSlugField,
    },
    UNEXPECTED_FIELD,
  )
  .refine((patch) => Object.keys(patch).length > 0, { message: NON_EMPTY_PATCH });

export const environmentCreateSchema = z.strictObject(
  {
    name: nameSchema,
    // `environmentSlugSchema` rather than `slugSchema`: an environment slug also
    // permits underscores, because it is typed at a shell prompt
    // (`xecret run --env staging_eu`) rather than placed in a URL path segment
    // that has to be globally unambiguous.
    slug: environmentSlugSchema.optional(),
    isProduction: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(SORT_ORDER_MAX).optional(),
  },
  UNEXPECTED_FIELD,
);

export const environmentPatchSchema = z
  .strictObject(
    {
      name: nameSchema.optional(),
      isProduction: z.boolean().optional(),
      sortOrder: z.number().int().min(0).max(SORT_ORDER_MAX).optional(),
      slug: immutableSlugField,
    },
    UNEXPECTED_FIELD,
  )
  .refine((patch) => Object.keys(patch).length > 0, { message: NON_EMPTY_PATCH });

/**
 * Offset pagination for the project listing.
 *
 * `docs/architecture/api.md` §5 prescribes keyset pagination, and the reasoning
 * there is about the append-heavy tables — the audit log above all — where an
 * offset re-scan shifts under concurrent inserts and can skip a row between
 * pages. A project listing is neither append-heavy nor long: `listProjects`
 * therefore takes a page number, and this schema is the boundary that stops a
 * caller asking for page 0, page 1.5, or a page of ten thousand rows.
 *
 * Deliberately not `strictObject`: an unknown *query* parameter is ignored the
 * way every HTTP API ignores one, so a cache-busting `?_=…` cannot fail a
 * request. Unknown *body* fields are still rejected — a body is a contract.
 */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1, 'Pages are numbered from 1.').default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE, `A page may hold at most ${MAX_PAGE_SIZE} items.`)
    .default(DEFAULT_PAGE_SIZE),
});

/**
 * The body of a destructive request.
 *
 * `confirm` carries the slug of the thing being destroyed. It defaults to an
 * empty object so a `DELETE` with no body at all is still a well-formed request
 * — only the routes that guard production data require the field to be present.
 */
export const destructiveRequestSchema = z
  .strictObject({ confirm: z.string().max(SLUG_MAX_LENGTH).optional() }, UNEXPECTED_FIELD)
  .default({});

/**
 * Refuses an attempt to change a slug.
 *
 * A slug is not merely a display field: it appears in every URL, in
 * `.xecret.yaml`, and in the CI configuration of everyone who consumes the
 * project. Renaming it would break every one of those the instant it took
 * effect, so the operation does not exist. Saying so is the point — a caller who
 * sent the field and got a 200 would reasonably believe it had been applied.
 *
 * Keyed on the presence of the property rather than its value, so `null` and an
 * empty string are refused too. Both are attempts to change it.
 */
export function assertSlugImmutable(
  patch: object,
  resource: 'organisation' | 'project' | 'environment',
): void {
  if (!Object.hasOwn(patch, 'slug')) return;

  throw errors.badRequest(
    `The slug of ${resource === 'organisation' ? 'an' : 'a'} ${resource} cannot be changed: it appears in URLs, in .xecret.yaml and in CI configuration, so a rename would break every consumer that is not redeployed at the same instant.`,
  );
}

/** The slug a project will be created with: what the caller asked for, or one derived from the name. */
export function resolveProjectSlug(request: { name: string; slug?: string | undefined }): string {
  return request.slug ?? deriveSlug(request.name, slugSchema);
}

/** As above, for an environment, whose slugs may also contain underscores. */
export function resolveEnvironmentSlug(request: {
  name: string;
  slug?: string | undefined;
}): string {
  return request.slug ?? deriveSlug(request.name, environmentSlugSchema);
}

/**
 * Derives a slug from a display name, or explains why it could not.
 *
 * The derived value is validated by the same schema an explicitly supplied slug
 * passes through, so "Settings" cannot become the reserved slug `settings` by
 * the back door, and a name of "→→→" cannot become the empty string. Neither
 * failure may be papered over: silently inventing a slug would put an identifier
 * in the user's URLs and CI configuration that they never chose, and one they
 * cannot subsequently change.
 *
 * The rejected value is not echoed. It is derived from user input, and this API
 * does not return user input in error messages (`errors.ts`).
 */
function deriveSlug(name: string, schema: ZodType<string>): string {
  const derived = slugify(name);
  const result = schema.safeParse(derived);
  if (result.success) return result.data;

  throw errors.validation([{ field: 'slug', message: derivationFailure(derived) }]);
}

function derivationFailure(derived: string): string {
  if (derived === '') {
    return 'A slug could not be derived from this name. Provide a slug explicitly.';
  }
  if (isReservedSlug(derived)) {
    return 'The slug derived from this name is reserved. Provide a different slug.';
  }
  return 'The slug derived from this name is not usable. Provide a slug explicitly.';
}

/**
 * Whether a destructive request confirmed the right resource.
 *
 * Compared case-insensitively and after trimming, because slugs are stored in a
 * `citext` column and because a value pasted from a URL bar routinely arrives
 * with a trailing space. This is a check against a mistake, not against an
 * attacker: anyone who can call the endpoint can also read the slug. Loosening
 * the comparison therefore costs nothing that matters and removes a failure mode
 * that would teach people to retry blindly.
 *
 * An absent or empty confirmation never matches, including for the resource
 * whose slug is somehow empty — there is no value a caller can omit their way
 * into.
 */
export function confirmationMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;

  const trimmed = provided.trim();
  if (trimmed === '') return false;

  return trimmed.toLowerCase() === expected.trim().toLowerCase();
}

export interface OrganizationPayload {
  id: string;
  name: string;
  slug: string;
  /** `null` for a service token, which holds no membership to report. */
  role: OrgRole | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPayload {
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListPayload extends ProjectPayload {
  environmentCount: number;
}

export interface EnvironmentPayload {
  name: string;
  slug: string;
  isProduction: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The organisation id is published because `/api/auth/session` and
 * `/api/auth/me` already return it, and the dashboard's organisation switcher
 * keys on it. Project and environment ids are not: their slug is the public
 * identifier, and an id that is never returned cannot be pasted into a
 * hand-built URL that skips a level of the tenancy chain.
 */
export function toOrganization(
  organization: Organization,
  role: OrgRole | null,
): OrganizationPayload {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    role,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  };
}

export function toProject(project: ProjectRecord): ProjectPayload {
  return {
    name: project.name,
    slug: project.slug,
    description: project.description,
    createdAt: project.createdAt.toISOString(),
    // `deleted_at` is deliberately absent: every repository read in this path
    // already filters soft-deleted rows, and a column that is never serialised
    // cannot turn a deleted row into one a client renders as live.
    updatedAt: project.updatedAt.toISOString(),
  };
}

export function toProjectListItem(project: ProjectListItem): ProjectListPayload {
  return { ...toProject(project), environmentCount: project.environmentCount };
}

export function toEnvironment(environment: EnvironmentRecord): EnvironmentPayload {
  return {
    name: environment.name,
    slug: environment.slug,
    isProduction: environment.isProduction,
    sortOrder: environment.sortOrder,
    createdAt: environment.createdAt.toISOString(),
    updatedAt: environment.updatedAt.toISOString(),
  };
}
