import * as z from 'zod/mini';
import type { ZodMiniType } from 'zod/mini';
import type { OrgRole } from '@xecret/core/authz';
import {
  DEFAULT_ENVIRONMENTS,
  environmentSlugSchema,
  isReservedSlug,
  ORGANIZATION_NAME_MAX_LENGTH,
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
import type { ApiError } from '../errors';
import { environmentKeyInitSchema } from './env-keys';
import { uuidField } from './ids';

/**
 * The request schemas and response shapes of the organisation, project and
 * environment routes.
 *
 * Both halves live together because they are the same contract seen from two
 * sides, and because a shape that is written out once cannot drift between the
 * four routes that return it: `docs/architecture/api.md` §1 sets out how every
 * resource is addressed, and one route spelling a field differently would split
 * the client in half with no error anywhere.
 *
 * Three rules run through the whole file:
 *
 *  1. **Slugs come from `@xecret/core/validation`.** `slugSchema` already knows
 *     the pattern, the length ceiling and the reserved list. A second regular
 *     expression here would be a second definition of what a valid identifier
 *     is, and the two would eventually disagree.
 *  2. **A slug is never accepted as a change.** A project's slug is its Project
 *     ID, the identifier committed to `.xecret.yaml` and pasted into CI, so the
 *     patch schemas admit the field only in order to refuse it with an
 *     explanation; see `assertSlugImmutable`. An organisation's slug is not
 *     a client's to set at all, at creation or after.
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
  .check(
    z.trim(),
    z.minLength(1, 'A name cannot be empty.'),
    z.maxLength(NAME_MAX_LENGTH, `A name must be at most ${NAME_MAX_LENGTH} characters.`),
  );

/**
 * The same rule, at the organisation's tighter ceiling.
 *
 * Enforced here and not only in the browser, because a limit the API does not
 * share is a limit that holds until somebody uses `curl`. The bound itself lives
 * in `@xecret/core/validation` so the form that caps the input and the endpoint
 * that stores the result cannot drift apart — see `ORGANIZATION_NAME_MAX_LENGTH`
 * for why the number is what it is.
 */
const organizationNameSchema = z
  .string()
  .check(
    z.trim(),
    z.minLength(1, 'A name cannot be empty.'),
    z.maxLength(
      ORGANIZATION_NAME_MAX_LENGTH,
      `An organisation name must be at most ${ORGANIZATION_NAME_MAX_LENGTH} characters.`,
    ),
  );

/**
 * Nullable so a description can be cleared. `undefined` means "leave it alone";
 * `null` means "remove it" — a distinction the repository already understands
 * and one a client cannot otherwise express.
 */
const descriptionSchema = z.nullable(
  z
    .string()
    .check(
      z.trim(),
      z.maxLength(
        DESCRIPTION_MAX_LENGTH,
        `A description must be at most ${DESCRIPTION_MAX_LENGTH} characters.`,
      ),
    ),
);

/**
 * Accepted so it can be refused.
 *
 * Declaring `slug` and rejecting it in the handler produces a 400 that says why
 * the field cannot be changed. Leaving it out would make it an unrecognised key
 * — a 422 that reads as a typo — and stripping it silently would be worse still:
 * the caller would believe the rename succeeded.
 */
const immutableSlugField = z.optional(z.unknown());

/**
 * Accepted so it can be ignored.
 *
 * An organisation's slug is derived by the server from its new id and shown to
 * nobody, so there is nothing a client could usefully send here. A tab still
 * running the create form from before sends one anyway; refusing that would
 * turn a working request into a 422 about a field the person cannot see.
 */
const ignoredSlugField = z.optional(z.unknown());

/**
 * Creating an organisation: a name, and that is all.
 *
 * Any text the name rules admit, and not unique: two organisations called
 * "Acme" are two organisations, told apart by their ids, and nothing in the
 * product treats a name as if it identified one. The organisation is
 * addressed by the id it is created with; its slug is the server's
 * (`organizationSlugFor`). A `slug` in the body is ignored.
 */
export const organizationCreateSchema = z.strictObject(
  { name: organizationNameSchema, slug: ignoredSlugField },
  UNEXPECTED_FIELD,
);

export const organizationPatchSchema = z
  .strictObject(
    { name: z.optional(organizationNameSchema), slug: immutableSlugField },
    UNEXPECTED_FIELD,
  )
  // Any recognised key satisfies this, `slug` included, so a body that names
  // only the slug reaches `assertSlugImmutable` and gets the precise refusal
  // instead of a generic "nothing to update".
  .check(z.refine((patch) => Object.keys(patch).length > 0, { message: NON_EMPTY_PATCH }));

/**
 * One of the default environments a new project is created with, and the keys
 * its creator generated for it.
 *
 * A project is not a container that gets environments later: it arrives with
 * development, staging and production, every one of them end-to-end encrypted,
 * and every one of them therefore needing an EDK, an EHK and the creator's grant
 * over both — generated in a browser, before this request exists. That is the
 * whole reason this field is here rather than the project route minting three
 * environments on its own the way it used to.
 *
 * `slug` names *which* of the defaults the entry is for; it is not a free
 * choice. `DEFAULT_ENVIRONMENTS` owns the name, the production flag and the
 * order, and it must keep owning them — a client that could name its own
 * environment here could also decide which of them is production, the one field
 * that changes who may read it. `indexEnvironmentInits` in the route enforces
 * the set, and says there why each of its three refusals is separate.
 *
 * `id` is required, unlike on `environmentCreateSchema` where a server-mode
 * creation left it optional. There is no server-mode path into this route, and
 * the grant's AAD names the environment (spec §4.2): a row written under any
 * other id holds a grant nobody can ever open.
 */
export const projectEnvironmentInitSchema = z.strictObject(
  {
    slug: environmentSlugSchema,
    id: uuidField('An environment is named by a UUID.'),
    keys: environmentKeyInitSchema,
  },
  UNEXPECTED_FIELD,
);

export type ProjectEnvironmentInit = z.infer<typeof projectEnvironmentInitSchema>;

export const projectCreateSchema = z.strictObject(
  {
    name: nameSchema,
    /** Optional: derived from the name when absent. See `resolveProjectSlug`. */
    slug: z.optional(slugSchema),
    description: z.optional(descriptionSchema),
    /**
     * **Required in practice, optional in the schema**, for the reason
     * `environmentCreateSchema.keys` gives: a caller without an unlocked vault
     * cannot produce this, and telling them so by way of a field-level error on
     * a field they have never heard of explains nothing. The route refuses
     * instead, in a sentence that says what to do.
     *
     * Bounded to the number of defaults so a caller cannot order an unbounded
     * number of sealings inside one transaction; the exact-set check that
     * actually decides the request lives in the route, where it can name which
     * environment is missing.
     */
    environments: z.optional(
      z
        .array(projectEnvironmentInitSchema)
        .check(
          z.maxLength(
            DEFAULT_ENVIRONMENTS.length,
            `A project starts with ${DEFAULT_ENVIRONMENTS.length} environments.`,
          ),
        ),
    ),
  },
  UNEXPECTED_FIELD,
);

export const projectPatchSchema = z
  .strictObject(
    {
      name: z.optional(nameSchema),
      description: z.optional(descriptionSchema),
      slug: immutableSlugField,
    },
    UNEXPECTED_FIELD,
  )
  .check(z.refine((patch) => Object.keys(patch).length > 0, { message: NON_EMPTY_PATCH }));

export const environmentCreateSchema = z.strictObject(
  {
    /**
     * The id the new environment takes.
     *
     * Chosen by the client, and required whenever `keys` is present, for the
     * reason `createClientSecretBody.id` gives about secrets: the creator's grant
     * is sealed in a browser before this request exists, and the grant's AAD
     * names the environment (spec §4.2). A row created under a server-minted id
     * would hold a grant nobody could ever open — and unlike a secret, there is
     * no repair, because the key bytes existed only in that browser.
     *
     * Optional in the schema because a `server`-mode creation needs no such
     * agreement; the route requires it alongside `keys`.
     */
    id: z.optional(z.string().check(z.length(36, 'An environment is named by a UUID.'))),
    name: nameSchema,
    // `environmentSlugSchema` rather than `slugSchema`: an environment slug also
    // permits underscores, because it is typed at a shell prompt
    // (`xecret run --env staging_eu`) rather than placed in a URL path segment
    // that has to be globally unambiguous.
    slug: z.optional(environmentSlugSchema),
    isProduction: z.optional(z.boolean()),
    sortOrder: z.optional(z.int().check(z.gte(0), z.lte(SORT_ORDER_MAX))),
    /**
     * The client-generated key hierarchy the new environment starts with.
     *
     * **Required in practice, optional in the schema**, and the distinction is
     * deliberate. Every environment created from Phase 3 onward is `e2ee`, so a
     * body without this cannot produce one — but refusing it here would give a
     * caller a field-level validation error naming a field they have never heard
     * of. The route refuses instead, with a message that explains what a caller
     * without an unlocked vault has to do first.
     *
     * There is no `encryptionMode` field beside it, and there must not be:
     * `server` mode is a migration state, not a choice, and offering it as one
     * would let a client opt an environment out of end-to-end encryption for the
     * life of that environment.
     */
    keys: z.optional(environmentKeyInitSchema),
  },
  UNEXPECTED_FIELD,
);

/**
 * `PATCH …/environments/{env}`: a name, a display order, and `isProduction` —
 * which, going either direction, can cross production's protection exactly as
 * creating a link does (review round 2, F1): turning it *on* can expose this
 * environment's existing parent or references, and turning it *off* can leave
 * a still-production environment elsewhere reading values nobody with its own
 * access now governs. `confirmCrossesProtection` is the same field
 * `environmentParentSchema` takes, for the same reason — see
 * `ProtectionCrossing` and `ProtectionDependency` in `references-service.ts`.
 */
export const environmentPatchSchema = z
  .strictObject(
    {
      name: z.optional(nameSchema),
      isProduction: z.optional(z.boolean()),
      sortOrder: z.optional(z.int().check(z.gte(0), z.lte(SORT_ORDER_MAX))),
      slug: immutableSlugField,
      confirmCrossesProtection: z.optional(z.boolean()),
    },
    UNEXPECTED_FIELD,
  )
  .check(z.refine((patch) => Object.keys(patch).length > 0, { message: NON_EMPTY_PATCH }));

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
/**
 * `PUT …/environments/{env}/parent` (P19 §1): the slug of the environment to
 * inherit from, in the same project, or `null` to inherit from nothing.
 *
 * `confirmCrossesProtection` is the caller saying it knows that a production
 * environment is being made to inherit from one that is not — see
 * `ProtectionCrossing` in `references-service.ts`. Only `true` means anything;
 * a request that needs it and lacks it is answered 409 `link_crosses_protection:`.
 */
export const environmentParentSchema = z.strictObject(
  {
    parent: z.nullable(environmentSlugSchema),
    confirmCrossesProtection: z.optional(z.boolean()),
  },
  UNEXPECTED_FIELD,
);

export const pageQuerySchema = z.object({
  page: z._default(
    z.pipe(z.coerce.number(), z.int().check(z.gte(1, 'Pages are numbered from 1.'))),
    1,
  ),
  pageSize: z._default(
    z.pipe(
      z.coerce.number(),
      z
        .int()
        .check(z.gte(1), z.lte(MAX_PAGE_SIZE, `A page may hold at most ${MAX_PAGE_SIZE} items.`)),
    ),
    DEFAULT_PAGE_SIZE,
  ),
});

/**
 * The body of a destructive request.
 *
 * `confirm` carries what the person typed to say they meant it: a project's
 * Project ID, an environment's slug, an organisation's name. It defaults to an
 * empty object so a `DELETE` with no body at all is still a well-formed request
 * — only the routes that guard production data require the field to be present.
 *
 * Bounded by the longest of those, which is the general slug ceiling; an
 * organisation name is shorter still.
 */
export const destructiveRequestSchema = z._default(
  z.strictObject(
    { confirm: z.optional(z.string().check(z.maxLength(SLUG_MAX_LENGTH))) },
    UNEXPECTED_FIELD,
  ),
  {},
);

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

  throw errors.badRequest(IMMUTABLE_SLUG[resource]);
}

/**
 * Why, in the words each resource is known by. A project's slug is shown to
 * people as its Project ID, so the refusal calls it that; an organisation's is
 * shown to nobody, so the refusal says only that it is not the client's.
 */
const IMMUTABLE_SLUG: Readonly<Record<'organisation' | 'project' | 'environment', string>> = {
  organisation:
    "An organisation's slug cannot be changed. Organisations are addressed by their id.",
  project:
    "A project's Project ID (its slug) cannot be changed once the project is created: it appears in .xecret.yaml, in CLI commands and in CI configuration, so changing it would break every consumer that is not redeployed at the same instant.",
  environment:
    'The slug of an environment cannot be changed: it appears in .xecret.yaml, in CLI commands and in CI configuration, so a rename would break every consumer that is not redeployed at the same instant.',
};

/**
 * The refusal when an account already holds an organisation waiting for a paid
 * plan, and asks for another (`provisionOrganization`).
 *
 * No plan limits how many organisations an account holds; each paid one is
 * billed on its own. An account's open Free organisations work up to two, one
 * created past them waits for a paid plan, and an account may hold one that
 * waits at a time.
 * This is that bound, and the sentence says the two ways past it.
 *
 * ── Why a 409 and not the `plan_limit` 403 every other ceiling answers ──
 * The status is a wire contract: `conflict` is what the Go CLI and the
 * dashboard already branch on for a refused organisation, and it predates the
 * plan refusals. Nothing about the caller's permissions is wrong, either, and
 * the same request succeeds once the waiting organisation is paid for or
 * deleted, which is how `mapMembershipError` treats a seat limit too.
 *
 * Nothing derived from the request appears: the caller learns a rule, not an
 * echo of what they sent.
 */
export function organizationAwaitingLimitReached(): ApiError {
  return errors.conflict(
    'You already have an organisation waiting for a paid plan. ' +
      'Choose a plan for it or delete it, then create another.',
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
function deriveSlug(name: string, schema: ZodMiniType<string>): string {
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
 * `citext` column and because a value pasted from a page routinely arrives
 * with a trailing space. This is a check against a mistake, not against an
 * attacker: anyone who can call the endpoint can also read what it expects.
 * Loosening the comparison therefore costs nothing that matters and removes a
 * failure mode that would teach people to retry blindly.
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
  /**
   * The project's UUIDv7, and the name its dashboard address uses — see
   * `toOrganization` below for why publishing it is safe.
   */
  id: string;
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
  /**
   * Which key hierarchy this environment's values live under.
   *
   * Published, unlike most internal columns, because every client has to branch
   * on it: the body a secret write takes, whether a reveal returns a plaintext,
   * and whether an export can be requested at all all depend on it. A client that
   * had to *discover* the mode by sending the wrong body and reading the error
   * would put a plaintext credential in a request to an e2ee environment exactly
   * once, which is once too many.
   */
  encryptionMode: string;
  sortOrder: number;
  /**
   * The slug of the environment this one inherits from (P19 §1), or `null`.
   * A slug, like everything else in this payload, and always one of the same
   * project's environments.
   */
  parent: string | null;
  /** Whether `xecret pull` and `export` are refused here (P19 §9). */
  plaintextExport: 'allowed' | 'disabled';
  /**
   * The read-alert setting as stored (P19 §7) — `null` is "the default" — and
   * what it comes to: on for production, off elsewhere, unless set.
   */
  readAlerts: boolean | null;
  readAlertsActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Whether new-location read alerts apply to an environment — its setting, else its class. */
export function readAlertsActive(
  environment: Pick<EnvironmentRecord, 'readAlerts' | 'isProduction'>,
): boolean {
  return environment.readAlerts ?? environment.isProduction;
}

/**
 * Serialises a project's environments together, so each one's parent can be
 * named by slug from the same listing rather than by a lookup per row.
 */
export function toEnvironments(environments: readonly EnvironmentRecord[]): EnvironmentPayload[] {
  const slugs = new Map(environments.map((environment) => [environment.id, environment.slug]));
  return environments.map((environment) =>
    toEnvironment(
      environment,
      environment.parentEnvironmentId === null
        ? null
        : (slugs.get(environment.parentEnvironmentId) ?? null),
    ),
  );
}

/**
 * The organisation id is published because it is what the organisation is
 * addressed by: `/app/{orgId}/…` in the dashboard, `/api/orgs/{orgId}/…` in the
 * API. `slug` stays in the payload for the clients that predate that (an
 * installed CLI reads it at login and addresses the API by it), and is shown
 * to nobody.
 *
 * A project's id is published too, because the dashboard names a project by it:
 * `/app/{org}/{projectId}/…`, so that an address never spells out what a
 * project is called and stays the same for as long as the project exists. What
 * made ids unpublished before — an id handed out is one somebody can paste into
 * a URL that skips a level of the tenancy chain — is answered by where the id
 * is accepted rather than by withholding it. There is no route keyed by a bare project id: it is
 * read only as the project segment *under* its organisation, and
 * `resolveProject` looks it up with the organisation's id in the `WHERE` clause
 * (`findProjectById`), so another tenant's id is the same `not_found` as a slug
 * that does not exist.
 *
 * Environment ids stay unpublished on these payloads. The environment segment
 * is still its slug, so nothing a client builds needs one.
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
    id: project.id,
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

/**
 * One environment. `parentSlug` is the caller's to supply, because the row holds
 * the parent's id and this payload speaks slugs: `toEnvironments` for a listing,
 * `parentSlugOf` for a single environment.
 */
export function toEnvironment(
  environment: EnvironmentRecord,
  parentSlug: string | null,
): EnvironmentPayload {
  return {
    name: environment.name,
    slug: environment.slug,
    isProduction: environment.isProduction,
    encryptionMode: environment.encryptionMode,
    sortOrder: environment.sortOrder,
    parent: environment.parentEnvironmentId === null ? null : parentSlug,
    plaintextExport: environment.plaintextExportDisabled ? 'disabled' : 'allowed',
    readAlerts: environment.readAlerts,
    readAlertsActive: readAlertsActive(environment),
    createdAt: environment.createdAt.toISOString(),
    updatedAt: environment.updatedAt.toISOString(),
  };
}
