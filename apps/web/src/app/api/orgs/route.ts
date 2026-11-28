import {
  countOrganizationsHeldBy,
  listOrganizationsForUser,
  provisionOrganization,
  QuotaExceededError,
  RepositoryError,
} from '@xecret/db/repositories';
import { billingConfigured } from '@/server/billing/config';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import type { RouteContext } from '@/server/route';
import {
  organizationAwaitingLimitReached,
  organizationCreateSchema,
  toOrganization,
} from '@/server/schemas/resources';

/**
 * The organisations the caller can act in.
 *
 * This is what the dashboard's organisation switcher reads and what the CLI uses
 * to resolve `--org`. Every other route in this tree takes an organisation in
 * its `{orgSlug}` segment (its id, or an older client's slug) and resolves it
 * through `tenancy.ts`; this one has nothing to resolve, because it is the
 * route that tells the client which organisations exist for them.
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
 * ── Why there is a bound as well as a rate limit ──
 * A rate limit bounds the cost per minute, and this endpoint's cost is not only
 * per minute: every organisation mints an Org Master Key, and a deleted one is
 * kept for thirty days. No plan limits how many organisations an account
 * holds (each paid one is billed on its own), so the bound is the free tier's:
 * an account's open Free organisations work up to two, one created past them
 * waits for a paid plan, and an account may hold one that waits at a time. Creating past the free allowance is allowed, so
 * somebody can start an organisation and then buy it a plan; creating one that
 * would wait while another already waits is refused, with
 * `organizationAwaitingLimitReached`. None of it applies where this deployment
 * takes no payments (`billingConfigured`).
 *
 * Decided inside `provisionOrganization`, behind the row lock it takes on the
 * account, so two concurrent requests cannot both read "none waiting". The
 * answer says whether the new one is waiting (`awaitingPaidPlan`), which is
 * what sends the dashboard to its plans page.
 *
 * ── A name, and nothing else ──
 * The body names the organisation and that is all it needs to. Any text the
 * name schema admits, and not unique: two organisations called "Acme" are two
 * organisations, told apart by their ids. The slug the row still carries is
 * derived from the new id (`organizationSlugFor`) and shown to nobody, so a
 * `slug` a client sends is accepted and ignored rather than refused: a tab
 * still running the form from before is creating an organisation, not making a
 * mistake. The free allowance and the derived slug are settled in the same
 * transaction as the organisation itself.
 *
 * ── What it provisions, and what it deliberately does not ──
 * `provisionOrganization` mints the organisation, the caller's owner membership
 * and the Org Master Key in one transaction. An organisation without that key is
 * not a lighter version of one — it is an organisation nothing can be stored in,
 * and one the product has no path to repair, because minting a key later
 * requires unwrapping a key that was never created.
 *
 * It stops there. It used to seed a `Default` project with three environments,
 * and that became unserviceable when `e2ee` became the column default: an
 * end-to-end encrypted environment's keys are sealed to a public key this server
 * has never seen, and at this point in a new account's life there is no vault to
 * seal to. The first project is created by `POST …/projects` from an unlocked
 * browser, which is the only place that material can come from.
 */
export const POST = authenticatedRoute(async ({ request, principal, services, audit, record }) => {
  if (principal.kind !== 'user') {
    throw errors.forbidden('Creating an organisation requires a signed-in browser session.');
  }

  // Before the body is read and long before the transaction: provisioning an
  // organisation derives an Org Master Key, which is the expensive part.
  await enforce(services.env, 'RL_MUTATION', rateLimitKey([principal.user.id]));

  const body = await parseJsonBody(request, organizationCreateSchema);

  const created = await provisionOrganization(services.db, {
    user: principal.user,
    envelope: services.envelope,
    // Only where a plan can be bought: an organisation created waiting with no
    // way to pay would be locked for good.
    freeAllowance: billingConfigured(services.env),
    name: body.name,
  }).catch(async (cause: unknown) => {
    // A derived slug that collided, which `provisionOrganization` explains is
    // all but impossible. A conflict rather than a field error: there is no
    // field the caller could change, and trying again mints a new id.
    if (cause instanceof RepositoryError && cause.code === 'conflict') {
      throw errors.conflict('The organisation could not be created. Try again.');
    }

    // One organisation already waiting for a paid plan: pay for it or delete
    // it first. Recorded, because a script working through this endpoint looks
    // nothing like a person clicking Create twice, and the log is where the
    // difference shows.
    if (cause instanceof QuotaExceededError) {
      await recordQuotaRefusal({ services, audit, record }, principal.user.id);
      throw organizationAwaitingLimitReached();
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
    // `awaitingPaidPlan` says the account's free allowance was already spent,
    // so this one needs a plan before it can be used.
    {
      organization: toOrganization(created.organization, created.membership.role),
      awaitingPaidPlan: created.awaitingPaidPlan,
    },
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
 * every record, and `GET /api/orgs/{org}/audit` shows an organisation's
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
 * Nothing is recorded when the account holds none, as `POST /api/auth/vault/lock`
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
