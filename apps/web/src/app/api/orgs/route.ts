import {
  countOrganizationsHeldBy,
  listOrganizationsForUser,
  provisionOrganization,
  RepositoryError,
} from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import type { RouteContext } from '@/server/route';
import {
  organizationCreateSchema,
  organizationLimitReached,
  ORGANIZATIONS_PER_ACCOUNT_LIMIT,
  toOrganization,
} from '@/server/schemas/resources';

/**
 * The organisations the caller can act in.
 *
 * This is what the dashboard's organisation switcher reads and what the CLI uses
 * to resolve `--org`. Every other route in this tree takes an `{orgSlug}` and
 * resolves it through `tenancy.ts`; this one has no slug to resolve, because it
 * is the route that tells the client which slugs exist for them.
 *
 * That is also why there is no `authorize()` call here, and why that is not a
 * hole. `authorize` decides whether an actor may act on a *named* resource, and
 * there is none in scope: the answer this route returns is precisely the set of
 * organisations the caller holds an active membership in, which
 * `listOrganizationsForUser` establishes in SQL — the join to `org_members` with
 * `status = 'active'`, and the `deleted_at is null` filter, are the boundary.
 * Resolving each row back through `resolveOrg` to have something to authorise
 * would issue two more queries per organisation to reach the same set, in a
 * runtime that is allowed six outgoing connections in total.
 */
export const GET = authenticatedRoute(async ({ principal, services }) => {
  // A service token is pinned to one organisation, one project and one
  // environment by construction (threat T5). It has no membership rows and no
  // switcher, so the honest answer is a refusal rather than a list of one — an
  // empty or single-entry list would invite a client to treat this endpoint as
  // the place a CI credential discovers what else it can reach.
  if (principal.kind === 'serviceToken') {
    throw errors.forbidden('Service tokens act in a single organisation.');
  }

  const userId = principal.kind === 'user' ? principal.user.id : principal.userId;
  const memberships = await listOrganizationsForUser(services.db, userId);

  return json({
    organizations: memberships.map((membership) =>
      toOrganization(membership.organization, membership.role),
    ),
  });
});

/**
 * Creates an organisation, with the caller as its owner.
 *
 * ── Why there is no `authorize()` call here either ──
 * For the same reason the listing above has none, from the other direction:
 * there is no resource yet to authorise against. `can()` answers "may this actor
 * act on *that* organisation", and the organisation this request is about does
 * not exist until the transaction below commits. The gate that matters is the
 * one above it — a signed-in browser session — and the ownership the caller ends
 * up holding is granted by the same statement that creates the thing it is over.
 *
 * ── Why a browser session, and not a CLI token ──
 * The same rule `DELETE /api/auth/account` states: a CLI token acts as its user
 * for secrets, not for existence. Minting a new Org Master Key from a credential
 * sitting on a build machine is not something the product needs and not
 * something a leaked one should be able to do (threat T5). It is also a hard
 * requirement rather than a policy: `organizations.created_by` is NOT NULL and a
 * service token has no user behind it at all.
 *
 * ── Why there is a ceiling as well as a rate limit ──
 * See `ORGANIZATIONS_PER_ACCOUNT_LIMIT`. In short: a rate limit bounds the cost
 * per minute, and this endpoint's cost is not only per minute — a slug is
 * claimed out of a global namespace permanently, deleted or not.
 *
 * The ceiling is *stated* here and *enforced* inside `provisionOrganization`,
 * behind the row lock it takes on the account. It used to be counted here, one
 * statement before the transaction, which made it advisory: every concurrent
 * request that read nine passed, and nothing further down disagreed. This route
 * now names the number and reads the refusal back off the transaction that
 * applied it, so there is one place the ceiling is decided and one place it is
 * imposed.
 *
 * ── Why the whole bootstrap, rather than an empty organisation ──
 * `provisionOrganization` mints the Org Master Key, a default project, its three
 * environments and an Env Data Key for each, in one transaction. An organisation
 * without those is not a lighter version of one — it is an organisation nothing
 * can be stored in, and one the product has no path to repair, because minting a
 * key requires unwrapping a key that was never created.
 */
export const POST = authenticatedRoute(async ({ request, principal, services, audit, record }) => {
  if (principal.kind !== 'user') {
    throw errors.forbidden('Creating an organisation requires a signed-in browser session.');
  }

  // Before the body is read and long before the transaction: provisioning an
  // organisation costs four key derivations and six inserts, which is the most
  // expensive thing an authenticated caller can ask for in one request.
  await enforce(services.env, 'RL_MUTATION', rateLimitKey([principal.user.id]));

  const body = await parseJsonBody(request, organizationCreateSchema);

  const created = await provisionOrganization(services.db, {
    user: principal.user,
    envelope: services.envelope,
    // The standing limit, which is a different control from the rate. Sixty of
    // these a minute, sustained, is still an unbounded number of Org Master Keys
    // and an unbounded number of slugs burned out of a namespace every tenant
    // shares — `isOrgSlugAvailable` and `generateUniqueOrgSlug` do not filter
    // `deleted_at`, deliberately, so deleting the organisation afterwards gives
    // none of them back.
    limit: ORGANIZATIONS_PER_ACCOUNT_LIMIT,
    name: body.name,
    // Two different contracts, and the difference matters:
    //
    //  - `slug` is what the caller chose and has seen. It is used exactly, and a
    //    collision is a 409 they resolve by choosing again. Adapting it would
    //    hand them a permanent identifier they never agreed to.
    //  - `slugSeed` is the fallback for a caller who expressed no preference —
    //    an API client sending only a name. There it is derived and suffixed,
    //    because there is nobody to ask and a refusal would be worse.
    ...(body.slug === undefined ? { slugSeed: body.name } : { slug: body.slug }),
  }).catch(async (cause: unknown) => {
    // Lost the race, or the availability check was stale. Reported against the
    // slug field so the form marks the input the user can actually change,
    // rather than as a sentence at the foot of a form with two fields.
    if (cause instanceof RepositoryError && cause.code === 'conflict') {
      throw errors.validation([
        { field: 'slug', message: 'That slug is already taken. Choose a different one.' },
      ]);
    }

    if (cause instanceof RepositoryError && cause.code === 'quotaExceeded') {
      await recordQuotaRefusal({ services, audit, record }, principal.user.id);
      throw organizationLimitReached();
    }

    throw cause;
  });

  record(
    audit(created.organization.id).success('org.created', {
      type: 'org',
      id: created.organization.id,
    }),
  );

  return json(
    // `role` is read from the membership the transaction just wrote rather than
    // hard-coded as `owner`, so this response cannot disagree with the row.
    { organization: toOrganization(created.organization, created.membership.role) },
    { status: 201 },
  );
});

/**
 * Records the refusal, against an organisation the account is actually in.
 *
 * ── Why an account-scoped refusal has no clean home ──
 * `audit_logs.org_id` is NOT NULL, because a record no organisation's audit view
 * can reach is a record nobody reads. But the rule broken here belongs to an
 * *account*, and organisations do not nest — so there is no organisation this
 * event is truthfully "in". Wherever it lands, `org.created` with
 * `outcome: error` and a null `resourceId` reads as a failed attempt to create
 * something inside that organisation, which is not what happened. It is written
 * anyway because the alternative is worse: one person clicking Create twice
 * looks nothing like a script working through a word list, and the audit log is
 * the only place that difference is visible.
 *
 * ── Why the anchor has to be a membership ──
 * `createAuditBuilder` stamps the actor's email address, IP and user agent onto
 * every record, and `GET /api/orgs/{orgSlug}/audit` shows an organisation's
 * records to its members. This used to be filed against the most recent
 * organisation the account had *created*, which — once the account had been
 * removed from it — was an organisation of strangers, handed a current email,
 * IP and user agent belonging to somebody with no relationship to their tenant.
 * `countOrganizationsHeldBy` only returns organisations the account is an active
 * member of, so the record cannot cross a boundary the actor is not already
 * inside.
 *
 * ── Why this re-reads ──
 * The transaction counted the same rows and then rolled back, taking the answer
 * with it. One indexed lookup on a path that has already been refused is a
 * better trade than keeping a second, permanently advisory count on every
 * successful creation — which is exactly the check-then-act this change removed.
 *
 * Nothing is recorded when the account holds none, as `POST /api/auth/pin/reset`
 * does with a null organisation: the record has nowhere to live, and inventing
 * somewhere for it is worse than the gap. Reachable only if the last membership
 * disappeared between the transaction's count and this one.
 */
async function recordQuotaRefusal(
  context: Pick<RouteContext<unknown>, 'services' | 'audit' | 'record'>,
  userId: string,
): Promise<void> {
  // One row, because one is all this uses: the most recent organisation the
  // account holds. Ids are UUIDv7, so that is the newest by creation time.
  const held = await countOrganizationsHeldBy(context.services.db, userId, 1);
  if (held.latestId === null) return;

  // Queued rather than written: `record` buffers and the route wrapper flushes
  // in a `finally`, so the refusal survives the exception thrown to carry it out.
  context.record(
    context.audit(held.latestId).error('org.created', { type: 'org', id: null }, 'quotaExceeded'),
  );
}
