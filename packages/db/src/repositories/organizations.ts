import { and, asc, eq, isNull } from 'drizzle-orm';
import type { OrgRole } from '@xecret/core/authz';
import { randomBytes } from '@xecret/core/crypto';
import type { EnvelopeService } from '@xecret/core/crypto';
import { uuidv7 } from '@xecret/core/ids';
import {
  DEFAULT_ENVIRONMENTS,
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_SLUG_MAX_LENGTH,
  isReservedSlug,
  slugify,
  truncateName,
} from '@xecret/core/validation';
import { envKeys, orgKeys } from '../schema/keys';
import { environments, projects } from '../schema/resources';
import { orgMembers, organizations } from '../schema/tenancy';
import { addMember } from './membership';
import type { MemberRecord } from './membership';
import { RepositoryError } from './shared';
import type { Executor } from './shared';
import { isUniqueViolation } from './users';
import type { User } from './users';

/**
 * Organisations, and the bootstrap that turns a verified identity into a usable
 * account. See docs/architecture/database-schema.md §2 and §4.
 */

export type Organization = typeof organizations.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Environment = typeof environments.$inferSelect;

/** An organisation together with the caller's role in it. */
export interface OrganizationMembership {
  organization: Organization;
  role: OrgRole;
}

const SLUG_UNIQUE_CONSTRAINT = 'organizations_slug_unique';

/**
 * How many `-2`, `-3`, … suffixes to try before falling back to randomness.
 *
 * Eight indexed lookups is a cheap price for a readable slug; beyond that the
 * name is contested enough that a random suffix is both faster and no less
 * meaningful than `acme-14`.
 */
const SLUG_ATTEMPT_LIMIT = 8;

/** Used when an email address yields nothing sluggable at all. */
const FALLBACK_SLUG_BASE = 'org';

const FALLBACK_ORGANIZATION_NAME = 'My Organisation';

/**
 * The project every new organisation starts with.
 *
 * A fixed slug rather than a derived one so the first CLI command in the
 * documentation — `xecret run --project default` — works for everybody.
 */
const DEFAULT_PROJECT_NAME = 'Default';
const DEFAULT_PROJECT_SLUG = 'default';

export async function findOrganizationBySlug(
  exec: Executor,
  slug: string,
): Promise<Organization | null> {
  const [row] = await exec
    .select()
    .from(organizations)
    .where(and(eq(organizations.slug, slug), isNull(organizations.deletedAt)))
    .limit(1);

  return row ?? null;
}

export async function findOrganizationById(
  exec: Executor,
  orgId: string,
): Promise<Organization | null> {
  const [row] = await exec
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1);

  return row ?? null;
}

/**
 * The organisations a user can switch between, with the role they hold in each.
 *
 * The role comes back with the organisation because the switcher needs it to
 * decide what to show, and fetching it per organisation afterwards is the
 * N+1 this join exists to avoid.
 *
 * Ordered by name for the switcher, then by id — `organizations.name` carries
 * no unique constraint, and two personal organisations both left at their
 * default name would otherwise come back in whatever order the plan happened to
 * produce. The dashboard reloads this list on every lock, unlock and account
 * refresh, and treats the first row as the organisation to fall back to when a
 * route names none, so an unstable head is a shell that re-points itself
 * mid-session.
 */
export async function listOrganizationsForUser(
  exec: Executor,
  userId: string,
): Promise<OrganizationMembership[]> {
  return organizationsForUserQuery(exec, userId);
}

/**
 * Finds a free slug close to what the caller asked for.
 *
 * Soft-deleted organisations still hold their slug — `organizations_slug_unique`
 * is a total constraint, not a partial index — so this deliberately does not
 * filter on `deleted_at`. A slug that reads as free but fails on insert would be
 * worse than one that is honestly taken.
 *
 * The suffix search is bounded. Looping until something is free is how a
 * contested name turns a sign-up into an unbounded number of queries, so after
 * `SLUG_ATTEMPT_LIMIT` tries this switches to a random suffix and stops.
 */
export async function generateUniqueOrgSlug(exec: Executor, desiredSlug: string): Promise<string> {
  const base = slugify(desiredSlug) || FALLBACK_SLUG_BASE;

  for (let attempt = 0; attempt < SLUG_ATTEMPT_LIMIT; attempt += 1) {
    const candidate = orgSlugCandidate(base, attempt);
    if (isReservedSlug(candidate)) continue;
    if (!(await isSlugTaken(exec, candidate))) return candidate;
  }

  const candidate = withSlugSuffix(base, randomSlugSuffix());
  if (await isSlugTaken(exec, candidate)) {
    throw new RepositoryError('conflict', 'Could not derive a free organisation slug.');
  }

  return candidate;
}

/**
 * Whether an organisation slug is free to claim.
 *
 * Answers the question the create form asks while somebody types. Two properties
 * matter, and both are about agreeing with the insert that follows:
 *
 *  - **Soft-deleted organisations still hold their slug.** The unique constraint
 *    is total, not partial, so this does not filter `deleted_at` — for the same
 *    reason `generateUniqueOrgSlug` does not. A form that says "available" and
 *    then 409s is worse than one that says "taken".
 *  - **Reserved slugs are unavailable**, not merely invalid later. They would
 *    shadow an application route for every tenant, so the honest answer to "can
 *    I have this one?" is no.
 *
 * It is a snapshot, never a reservation: the slug can be claimed by somebody
 * else between this answer and the insert. That race is settled by the unique
 * index, which is the only thing that can settle it — this check exists to make
 * the common case legible, not to make the rare one impossible.
 */
export async function isOrgSlugAvailable(exec: Executor, slug: string): Promise<boolean> {
  if (isReservedSlug(slug)) return false;
  return !(await isSlugTaken(exec, slug));
}

export interface ProvisionOrganizationParams {
  user: Pick<User, 'id' | 'email' | 'displayName'>;
  envelope: EnvelopeService;
  /** Overrides the name derived from the user's profile. */
  name?: string | undefined;
  /**
   * The exact slug to claim — the one the user chose and can see.
   *
   * Takes precedence over `slugSeed`, and **fails rather than adapts**: if it is
   * taken, this throws `conflict` instead of quietly handing back `acme-2`. That
   * difference is the whole point. A slug is permanent, so a caller who typed
   * one and got a different one back would be holding an identifier they never
   * agreed to, in every URL, forever.
   */
  slug?: string | undefined;
  /**
   * What the slug is derived from, before uniquifying. Ignored when `slug` is
   * given.
   *
   * This is the path that *is* allowed to adapt, because nobody is watching: it
   * serves the organisation created at first sign-in, which has nothing to go on
   * but the address that just signed in and no form in which to object.
   */
  slugSeed?: string | undefined;
}

export interface ProvisionedOrganization {
  organization: Organization;
  membership: MemberRecord;
  project: Project;
  environments: Environment[];
}

/**
 * Builds an organisation that can hold a secret: the organisation itself, an
 * owner membership for the caller, an Org Master Key, a default project, its
 * default environments, and an Env Data Key for each.
 *
 * Two paths reach this. The first is sign-up — a verified identity with no
 * membership anywhere gets one here, which is what makes the product usable
 * within a minute of signing up. The second is `POST /api/orgs`, where somebody
 * who already has an account starts a second organisation. The work is
 * identical; only the name and the slug seed differ.
 *
 * All of it in one transaction. A user who ends up with an organisation but no
 * Org Master Key is permanently broken — they cannot store a secret, and nothing
 * in the product can repair it without an operator going in by hand. That is the
 * single strongest argument for the transaction: partial state here is not an
 * inconvenience to retry past, it is an unrecoverable organisation.
 *
 * Note the ordering constraint honestly: the `EnvelopeService` calls are awaited
 * inside the transaction, so it is held open across CPU-bound cryptography. That
 * is acceptable *here* because it happens once per organisation, on a path
 * nobody waits on twice. Do not copy the shape into a request-serving path,
 * where holding a connection through key derivation is a self-inflicted
 * throughput limit. The environment keys are derived concurrently to keep the
 * window as short as it can be.
 */
export async function provisionOrganization(
  exec: Executor,
  params: ProvisionOrganizationParams,
): Promise<ProvisionedOrganization> {
  const { user, envelope } = params;

  return exec.transaction(async (tx) => {
    const now = new Date();
    const orgId = uuidv7();
    // An explicit slug is used as given; only a derived one is uniquified. The
    // insert below is what actually settles a race for either, via the unique
    // index — no amount of checking first can, and pretending otherwise is how
    // two organisations end up believing they own `acme`.
    const slug =
      params.slug ??
      (await generateUniqueOrgSlug(tx, params.slugSeed ?? personalOrgSlugSeed(user.email)));

    if (isReservedSlug(slug)) {
      throw new RepositoryError('conflict', 'That slug is reserved.');
    }

    const [organization] = await tx
      .insert(organizations)
      .values({
        id: orgId,
        name: params.name?.trim() || defaultOrganizationName(user),
        slug,
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      // The unique index is the arbiter. Mapped to `conflict` so the route can
      // answer 409 and put the message on the slug field, rather than letting an
      // unmapped driver error become a 500 for a race the user can resolve by
      // picking another name.
      .catch(rethrowSlugCollision);
    // A single-row `INSERT … RETURNING` either returns its row or throws, so this
    // and the checks below are unreachable. They exist because
    // `noUncheckedIndexedAccess` is on and a `!` here would hide a genuine
    // failure if that ever stopped being true.
    if (!organization) throw new Error('Organisation insert returned no row.');

    const membership = await addMember(tx, {
      orgId,
      userId: user.id,
      role: 'owner',
      invitedBy: null,
    });

    const orgKey = await envelope.createOrgKey(orgId);
    const [orgKeyRow] = await tx
      .insert(orgKeys)
      .values({
        id: uuidv7(),
        orgId,
        version: orgKey.version,
        wrappedKey: orgKey.ciphertext,
        wrapIv: orgKey.iv,
        rootKeyVersion: orgKey.rootKeyVersion,
        // Recorded from the key that was actually produced rather than left to
        // the column default, so a future algorithm change cannot silently
        // mislabel rows written during the changeover.
        algorithm: orgKey.algorithm,
        createdAt: now,
      })
      .returning();
    if (!orgKeyRow) throw new Error('Organisation key insert returned no row.');

    const projectId = uuidv7();
    const [project] = await tx
      .insert(projects)
      .values({
        id: projectId,
        orgId,
        name: DEFAULT_PROJECT_NAME,
        slug: DEFAULT_PROJECT_SLUG,
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!project) throw new Error('Project insert returned no row.');

    const createdEnvironments = await tx
      .insert(environments)
      .values(
        DEFAULT_ENVIRONMENTS.map((environment) => ({
          id: uuidv7(),
          projectId,
          name: environment.name,
          slug: environment.slug,
          isProduction: environment.isProduction,
          sortOrder: environment.sortOrder,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning();

    const envKeyRows = await Promise.all(
      createdEnvironments.map(async (environment) => {
        const envKey = await envelope.createEnvKey({
          orgId,
          environmentId: environment.id,
          orgKey,
        });

        return {
          id: uuidv7(),
          environmentId: environment.id,
          orgKeyId: orgKeyRow.id,
          version: envKey.version,
          wrappedKey: envKey.ciphertext,
          wrapIv: envKey.iv,
          algorithm: envKey.algorithm,
          createdAt: now,
        };
      }),
    );
    await tx.insert(envKeys).values(envKeyRows);

    return { organization, membership, project, environments: createdEnvironments };
  });
}

export interface OrganizationPatch {
  name?: string | undefined;
  slug?: string | undefined;
}

/**
 * Renames an organisation. Name and slug only — everything else about an
 * organisation has its own path with its own authorization check.
 */
export async function updateOrganization(
  exec: Executor,
  orgId: string,
  patch: OrganizationPatch,
): Promise<Organization> {
  if (patch.name === undefined && patch.slug === undefined) {
    const current = await findOrganizationById(exec, orgId);
    if (!current) throw new RepositoryError('notFound', 'Organisation not found.');
    return current;
  }

  // The route validates with `slugSchema`, which already rejects these. Checking
  // again costs a set lookup and means a reserved slug cannot reach the database
  // through some future caller that forgot to validate — it would shadow an
  // application route for every tenant, not just this one.
  if (patch.slug !== undefined && isReservedSlug(patch.slug)) {
    throw new RepositoryError('conflict', 'That slug is reserved.');
  }

  const [row] = await exec
    .update(organizations)
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.slug === undefined ? {} : { slug: patch.slug }),
      updatedAt: new Date(),
    })
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .returning()
    .catch(rethrowSlugCollision);

  if (!row) throw new RepositoryError('notFound', 'Organisation not found.');
  return row;
}

/**
 * Soft-deletes an organisation.
 *
 * One column, and everything inside stops resolving at once: every read joins
 * through `organizations` with a `deleted_at is null` filter, so projects,
 * environments and secrets become unreachable without touching their rows —
 * they remain what the audit log points at. The wrapped keys remain too, and
 * remain wrapped; nothing here needs, or touches, key material.
 *
 * Idempotent, and deliberately without a last-owner style guard: the caller
 * decides whether an organisation may die (account deletion deletes the ones
 * the leaver was alone in), and a repository second-guessing that would need
 * the caller's context to do it correctly.
 */
export async function softDeleteOrganization(exec: Executor, orgId: string): Promise<void> {
  const now = new Date();
  await exec
    .update(organizations)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)));
}

/**
 * The slug seed for a personal organisation, taken from an email address.
 *
 * The local part is the closest thing to a name available at first login. A
 * `+tag` is dropped because it is a routing detail of the address rather than
 * part of who the person is, and nobody wants `acme-signup-2024` in every URL.
 */
export function personalOrgSlugSeed(email: string): string {
  const at = email.indexOf('@');
  const localPart = at === -1 ? email : email.slice(0, at);
  const tag = localPart.indexOf('+');

  return tag === -1 ? localPart : localPart.slice(0, tag);
}

/**
 * The candidate slug for a given attempt: attempt 0 is the bare slug, and later
 * attempts append `-2`, `-3`, … Pure, so the suffixing is testable without a
 * database.
 *
 * Every branch is bounded by `ORGANIZATION_SLUG_MAX_LENGTH`, including attempt
 * 0. The seed reaching here is a display name or an email local part, neither of
 * which is under that limit by construction — and a sign-up that quietly minted
 * a 40-character slug would create an organisation whose own settings page
 * reports its slug as invalid.
 */
export function orgSlugCandidate(base: string, attempt: number): string {
  if (attempt === 0) return trimTrailingHyphens(base.slice(0, ORGANIZATION_SLUG_MAX_LENGTH));
  return withSlugSuffix(base, String(attempt + 1));
}

/**
 * Appends a suffix, trimming the base so the result still fits.
 *
 * Truncating the base rather than the suffix keeps the result unique — a
 * truncated suffix would collide with the very slug it was meant to distinguish.
 */
function withSlugSuffix(base: string, suffix: string): string {
  const room = ORGANIZATION_SLUG_MAX_LENGTH - suffix.length - 1;
  return `${trimTrailingHyphens(base.slice(0, room))}-${suffix}`;
}

/**
 * A slice can land on a hyphen, and `SLUG_PATTERN` forbids both a trailing one
 * and the double hyphen that a suffix would then create.
 */
function trimTrailingHyphens(value: string): string {
  return value.replace(/-+$/, '');
}

/** Six lowercase base-36 characters, from a CSPRNG: ~1.7 × 10⁷ possibilities. */
function randomSlugSuffix(): string {
  return Array.from(randomBytes(3), (byte) => byte.toString(36).padStart(2, '0')).join('');
}

async function isSlugTaken(exec: Executor, slug: string): Promise<boolean> {
  const [row] = await exec
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);

  return row !== undefined;
}

/**
 * The organisation is named after the person, because at first login that is the
 * only meaningful name available. Renaming it is one field in settings.
 *
 * Truncated to the limit the API enforces on a name somebody types. The source
 * here is a display name from an identity provider, which arrives at whatever
 * length that provider allows — and an organisation created at sign-up that the
 * settings page then refuses to save would be a rule the product breaks on the
 * user's behalf and then blames them for.
 */
function defaultOrganizationName(user: Pick<User, 'email' | 'displayName'>): string {
  const source =
    user.displayName?.trim() || personalOrgSlugSeed(user.email) || FALLBACK_ORGANIZATION_NAME;
  return truncateName(source, ORGANIZATION_NAME_MAX_LENGTH) || FALLBACK_ORGANIZATION_NAME;
}

/**
 * Two organisations renamed to the same slug at the same moment is a conflict
 * the caller can act on, not the 500 an unmapped driver error would produce.
 */
function rethrowSlugCollision(error: unknown): never {
  if (isUniqueViolation(error, SLUG_UNIQUE_CONSTRAINT)) {
    throw new RepositoryError('conflict', 'That slug is already taken.');
  }
  throw error;
}

/**
 * @internal Exported so `identity.test.ts` can assert that the membership join
 * carries the tenancy predicate, without needing a database to prove it.
 */
export function organizationsForUserQuery(exec: Executor, userId: string) {
  return exec
    .select({ organization: organizations, role: orgMembers.role })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(
      and(
        eq(orgMembers.userId, userId),
        eq(orgMembers.status, 'active'),
        isNull(organizations.deletedAt),
      ),
    )
    .orderBy(asc(organizations.name), asc(organizations.id));
}
