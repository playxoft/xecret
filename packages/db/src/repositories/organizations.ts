import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { OrgRole } from '@xecret/core/authz';
import { DEFAULT_PLAN, FAIR_USE, PLANS } from '@xecret/core/entitlements';
import type { PlanId } from '@xecret/core/entitlements';
import { randomBytes } from '@xecret/core/crypto';
import type { EnvelopeService } from '@xecret/core/crypto';
import { uuidv7 } from '@xecret/core/ids';
import {
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_SLUG_MAX_LENGTH,
  isReservedSlug,
  slugify,
  truncateName,
} from '@xecret/core/validation';
import { users } from '../schema/identity';
import { orgKeys } from '../schema/keys';
import { environments, projects } from '../schema/resources';
import { orgSubscriptions } from '../schema/billing';
import { orgMembers, organizations } from '../schema/tenancy';
import { addMember } from './membership';
import type { MemberRecord } from './membership';
import { QuotaExceededError, RepositoryError } from './shared';
import type { Executor } from './shared';
import { createFreeSubscription, entitlementColumns } from './subscriptions';
import type { SubscriptionEntitlementRow } from './subscriptions';
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
 * An organisation and its entitlement columns, in one row.
 *
 * ── Why a join and not a second lookup ──
 * Entitlements are the third authorization gate, so they are needed on every
 * tenant-scoped request. `resolveOrg` already reads the organisation by slug;
 * adding a second query to answer a billing question would put a round trip on
 * the path of every secret fetch, for a value that changes about once a month.
 *
 * A `LEFT JOIN` rather than an inner one: migration 0016 backfilled every
 * organisation and provisioning inserts alongside, so the row is always there —
 * but an inner join would turn a missing subscription into a *missing
 * organisation*, which is a 404 for a tenant that plainly exists. The null case
 * resolves to Free, which is the same answer the migration would have written.
 */
export interface OrganizationWithEntitlements {
  organization: Organization;
  entitlements: SubscriptionEntitlementRow | null;
}

/**
 * @internal Exported so `subscriptions.test.ts` can assert the join exists and
 * that the projection carries no provider identifier, without a database.
 */
export function organizationBySlugWithEntitlementsQuery(exec: Executor, slug: string) {
  return exec
    .select({ organization: organizations, entitlements: entitlementColumns })
    .from(organizations)
    .leftJoin(orgSubscriptions, eq(orgSubscriptions.orgId, organizations.id))
    .where(and(eq(organizations.slug, slug), isNull(organizations.deletedAt)))
    .limit(1);
}

export async function findOrganizationBySlugWithEntitlements(
  exec: Executor,
  slug: string,
): Promise<OrganizationWithEntitlements | null> {
  const [row] = await organizationBySlugWithEntitlementsQuery(exec, slug);
  if (!row) return null;
  return { organization: row.organization, entitlements: row.entitlements };
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

/** What `countOrganizationsHeldBy` found. */
export interface HeldOrganizations {
  /** How many, counted no further than the limit that was asked about. */
  total: number;
  /** The most recent of them, or `null` when the account holds none. */
  latestId: string | null;
  /**
   * The plan of each organisation counted.
   *
   * Carried because the ceiling on *how many organisations an account may hold*
   * is a plan limit, and an account has no plan of its own — only the
   * organisations it belongs to have one. `accountOrganizationCeiling` resolves
   * the two into a number; see the reasoning there.
   */
  plans: PlanId[];
}

/**
 * How many live organisations one account **created and is still in**.
 *
 * Both halves of that are load-bearing, and each answers a way the other one
 * alone fails:
 *
 *  - **`created_by`**, so that being promoted to owner of somebody else's
 *    organisation does not spend this account's allowance. Ten colleagues
 *    handing somebody an owner seat must not stop them starting their own.
 *  - **an active membership**, so that a place can always be given back. The
 *    only way to release one is `DELETE /api/orgs/{slug}`, which resolves
 *    through `resolveOrg` and answers 404 without a membership — so counting
 *    `created_by` alone meant an organisation you were removed from stood
 *    against your ceiling for ever, with no request you could make to clear it.
 *    A co-owner removing the creator from ten organisations was enough to stop
 *    that account creating an eleventh, permanently. What you can no longer
 *    reach is not something you are still holding.
 *
 * The membership join is what makes the ceiling coherent elsewhere, too: an
 * account with no memberships counts zero, so the organisation created at first
 * sign-in is within any cap by construction rather than by an exemption
 * somebody has to remember to keep correct.
 *
 * `status = 'active'` for the same reason the read exists at all — a suspended
 * member cannot delete the organisation either, so a suspension frees the place
 * rather than freezing it.
 *
 * Soft-deleted organisations are excluded, so deleting one frees a place. Note
 * what that does *not* give back: `organizations_slug_unique` is a total
 * constraint, so the slug stays claimed for ever. The limit bounds the standing
 * cost; only the rate limiter bounds the churn.
 *
 * ── Why a bounded row scan rather than `count(*)` ──
 * The caller is asking "is this account at its limit", which `LIMIT n` answers
 * exactly, and it can stop at `n` rows rather than aggregating over every
 * organisation an account has ever created. That is only true because
 * `organizations_creator_idx` supplies the rows in `id desc` order under the
 * `created_by` predicate — without it PostgreSQL has to find every candidate
 * row before it can sort, and the `LIMIT` saves nothing on the common path
 * where the account is under the ceiling. The ids are UUIDv7, so descending id
 * is descending creation time, and the first row is the one the refusal is
 * filed against — `audit_logs.org_id` being NOT NULL.
 */
export async function countOrganizationsHeldBy(
  exec: Executor,
  userId: string,
  limit: number,
): Promise<HeldOrganizations> {
  const rows = await organizationsHeldByQuery(exec, userId, limit);
  return {
    total: rows.length,
    latestId: rows[0]?.id ?? null,
    // A null plan means no subscription row, which migration 0016 made
    // impossible and which resolves to Free everywhere else. Same answer here.
    plans: rows.map((row) => row.plan ?? DEFAULT_PLAN),
  };
}

/**
 * How many organisations this account may hold.
 *
 * ── The problem this solves ──
 * `organizations` is a plan limit — Free allows one, every paid plan allows as
 * many as fair use permits. But a *plan* belongs to an organisation and this
 * ceiling belongs to an *account*, and an account is not a billable thing. So
 * the question "which plan applies" has no answer until one is chosen.
 *
 * ── The rule ──
 * The most generous ceiling among the organisations the account **created and is
 * still in**. Unlimited wins outright; otherwise the largest number does.
 *
 * Note which set that is, because it is narrower than "organisations the account
 * belongs to" and the difference is deliberate. The plans come from
 * `organizationsHeldByQuery`, which filters `created_by = userId` — so an
 * account that was *invited* into somebody else's Team organisation is measured
 * against the plans it bought itself, and being a member of a paid tenant does
 * not raise its personal allowance. Anything wider would make a colleague's
 * purchase spend on your behalf, and would let one Scale organisation hand an
 * unlimited ceiling to everybody it ever invited.
 *
 * Chosen over the alternatives because each of those punishes somebody who paid.
 * Taking the *lowest* of the set would mean starting a second Free organisation
 * silently revoked the Team allowance you are paying for. Taking the plan of the
 * organisation being created is circular — it does not exist yet, and it would be
 * Free. Taking the account's "own" organisation requires picking one, and an
 * account invited into every organisation it belongs to has none.
 *
 * ── The consequences, stated plainly ──
 * An account holding nothing but Free organisations may create one. That is a
 * tightening: the previous fixed ceiling was ten for everybody. It is also what
 * the pricing page says, and the pricing page is the contract.
 *
 * And: somebody who has created one Free organisation and been invited into a
 * colleague's Team organisation is still capped at one. Their own account is on
 * Free, which is the plan they are on; the upgrade that lifts it is one they buy.
 *
 * ── Why unlimited still lands on a number ──
 * `FAIR_USE.organizations`. Not to sell anything past it — crossing a fair-use
 * ceiling is a conversation, not a refusal — but because this particular count
 * is the one an abuse script drives in a loop, and every organisation created
 * derives an Org Master Key. The ceiling here is an abuse bound that happens to
 * coincide with a published number, and support raises it with an override like
 * any other.
 */
export function accountOrganizationCeiling(plans: readonly PlanId[]): number {
  if (plans.length === 0) return PLANS[DEFAULT_PLAN].limits.organizations ?? FAIR_USE.organizations;

  let best = 0;
  for (const plan of plans) {
    const ceiling = PLANS[plan]?.limits.organizations;
    if (ceiling === null || ceiling === undefined) return FAIR_USE.organizations;
    if (ceiling > best) best = ceiling;
  }
  return best;
}

/**
 * @internal Exported so `identity.test.ts` can assert that the count is joined
 * to membership, excludes soft-deleted rows and stops at the limit, without
 * needing a database.
 */
export function organizationsHeldByQuery(exec: Executor, userId: string, limit: number) {
  return (
    exec
      // The plan rides along on a primary-key join, so the count that was
      // already being made now also answers which ceilings apply. A second
      // query would be a round trip on the first-login path, which is the one
      // request in the product a new user judges the whole thing by.
      .select({ id: organizations.id, plan: orgSubscriptions.plan })
      .from(organizations)
      // `org_members_org_user_unique` makes this at most one row per
      // organisation, so the join cannot inflate the count it is part of.
      .innerJoin(orgMembers, eq(orgMembers.orgId, organizations.id))
      .leftJoin(orgSubscriptions, eq(orgSubscriptions.orgId, organizations.id))
      .where(
        and(
          eq(organizations.createdBy, userId),
          eq(orgMembers.userId, userId),
          eq(orgMembers.status, 'active'),
          isNull(organizations.deletedAt),
        ),
      )
      .orderBy(desc(organizations.id))
      .limit(limit)
  );
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
  /**
   * The most organisations this account may hold, counted by
   * `countOrganizationsHeldBy` and refused with `quotaExceeded`.
   *
   * Required, and deliberately not defaulted. This is the only ceiling on
   * organisation creation there is, and a parameter with a default is one a
   * future caller can omit and silently get no ceiling at all — which is
   * precisely how the bootstrap at `POST /api/auth/session` came to create
   * organisations without consulting one.
   */
  limit: number;
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
}

/**
 * Builds an organisation that can hold a secret: the organisation itself, an
 * owner membership for the caller, and an Org Master Key.
 *
 * ── Why it stops there, and does not seed a project ──
 * It used to create a `Default` project with the three standard environments and
 * an Env Data Key for each. That became wrong the moment migration 0013 made
 * `e2ee` the column default: the environments were written straight through this
 * function rather than through `createEnvironment`, so they took the new default
 * while still receiving the old server-wrapped `env_keys` and no
 * `env_data_keys`/`env_key_grants` at all. The product has a name for that state
 * and it is not a recoverable one — `env-key-notice.tsx` tells the user "no key
 * was ever recorded for it… nothing can repair it. Create a new environment and
 * delete this one." Every organisation created since that migration was born
 * holding three of them.
 *
 * It cannot be fixed by keying them here either, and that is the deeper reason
 * this is gone rather than repaired: an end-to-end encrypted environment's keys
 * are generated in a browser and sealed to a public key **this server has never
 * seen**. At sign-up there is no vault to seal to yet, so there is no honest key
 * this function could write. The first project is therefore created by
 * `POST …/projects` from an unlocked browser, which is the only place the
 * material can come from, and a new organisation opens on an empty projects
 * screen instead of on three environments nothing can be written to.
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
 *
 * ── Why the ceiling is enforced in here rather than by the caller ──
 * It used to be a count in `POST /api/orgs`, one statement before this
 * transaction and with the whole of it in between. That is check-then-act:
 * every concurrent request that read `total = 9` passed, and nothing downstream
 * disagreed — no unique constraint expresses "at most ten", so the database
 * accepted every one of them. The rate limiter is not a backstop for it either.
 * Cloudflare's counters are per-colo, so a distributed caller gets roughly its
 * whole `RL_MUTATION` allowance *per data centre* in flight at once, and
 * `consume` fails open when the binding is absent — which is the documented
 * state of a local or self-hosted deployment, where the overshoot is then
 * unbounded.
 *
 * So the count happens here, behind `lockAccount`, and the number it compares
 * against is the caller's — one place where the ceiling is decided and one
 * place where it is applied.
 */
export async function provisionOrganization(
  exec: Executor,
  params: ProvisionOrganizationParams,
): Promise<ProvisionedOrganization> {
  const { user, envelope } = params;

  return exec.transaction(async (tx) => {
    // First, before the slug lookup and long before any key material: nothing
    // below is worth doing for a request that is about to be refused, and the
    // lock has to be held across the count *and* the insert for the count to
    // mean anything.
    await lockAccount(tx, user.id);

    // Counted up to the abuse cap rather than to the plan ceiling, because the
    // ceiling is not known until the plans of the organisations already held
    // have been read — and they are read by this same query. Counting to the
    // larger of the two costs at most a few extra index rows and removes the
    // second round trip that computing it first would need.
    const held = await countOrganizationsHeldBy(tx, user.id, params.limit);

    // The plan ceiling, bounded by the caller's abuse cap. `min` rather than
    // either alone: the plan says what was sold, the cap says what this system
    // will mint Org Master Keys for in one account, and neither is allowed to
    // override the other.
    const ceiling = Math.min(accountOrganizationCeiling(held.plans), params.limit);

    if (held.total >= ceiling) {
      // The ceiling rides along on the error: the route has to say the number
      // out loud, and this transaction is the only place it was ever computed.
      throw new QuotaExceededError(
        `An account can hold at most ${ceiling} organisations.`,
        ceiling,
      );
    }

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

    // Inside the same transaction, so an organisation and its subscription
    // commit together or not at all. The alternative — creating the row lazily
    // on first read — makes every entitlement lookup a left join with a
    // fallback, and a fallback that duplicates the Free plan is a fallback that
    // will one day disagree with it.
    await createFreeSubscription(tx, orgId);

    return { organization, membership };
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

/**
 * Serialises one account's organisation creations against each other.
 *
 * The lock is taken on the *account* row rather than on anything the
 * transaction is about to write, for the same reason `lockOrgAndLoadMember`
 * locks the organisation rather than the member being changed: "at most ten" is
 * a property of a set, and locking the rows a transaction writes serialises
 * nothing when each writes a different row. Two concurrent creations insert two
 * different organisations, each counts nine, and both commit — and no
 * constraint downstream disagrees, because none of them can express a ceiling
 * across rows. `users` is the only row the two have in common, so holding it
 * forces the second to count again under the first one's committed effect.
 *
 * The honest cost: the lock is held for the rest of the transaction, which in
 * `provisionOrganization` means across the Org Master Key derivation — so a second
 * creation from the same account waits the first one out. That is the intent —
 * one account may not mint Org Master Keys in parallel — and the contention is
 * confined to that account, since nobody else has any reason to touch this row.
 * The one other writer of it is `upsertUserFromIdentity`, so a sign-in landing
 * mid-creation for the same person waits too, on a request that has just spent
 * far longer verifying a Firebase token.
 *
 * A soft-deleted account is filtered out rather than locked. It cannot
 * authenticate, so this is unreachable from the two callers; if it ever became
 * reachable, `notFound` is a better ending than provisioning an organisation
 * for a row on its way out.
 */
async function lockAccount(exec: Executor, userId: string): Promise<void> {
  const [account] = await accountLockQuery(exec, userId);
  if (!account) throw new RepositoryError('notFound', 'Account not found.');
}

/**
 * @internal Exported so `identity.test.ts` can assert that the serialisation is
 * a `SELECT … FOR UPDATE` on one account row, without needing a database to
 * demonstrate the race it closes.
 */
export function accountLockQuery(exec: Executor, userId: string) {
  return exec
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1)
    .for('update');
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
