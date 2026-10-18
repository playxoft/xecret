import { IdentityVerificationError } from '@xecret/core/auth';
import type {
  AuditAction,
  AuditBuilder,
  AuditErrorReason,
  AuditRecord,
  AuditResource,
} from '@xecret/core/audit';
import { auditingDenials } from '@xecret/core/authz';
import type { Action } from '@xecret/core/authz';
import { findSessionFreshAuth, findWorkosHome, listMemberAddresses } from '@xecret/db/repositories';
import type { Organization } from '@xecret/db/repositories';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { describeError } from './logging';
import { errors } from './errors';
import { requireAddon } from './entitlements';
import { REAUTH_SIGN_IN_MAX_AGE_SECONDS } from './schemas/vault';
import { toSsoStatus } from './schemas/sso';
import type { SsoStatusPayload } from './schemas/sso';
import { emailDomain } from './sign-in';
import { authorize } from './tenancy';
import type { OrgScope } from './tenancy';
import { IdentityProviderUnavailableError } from './workos';
import type { SsoConnectionSummary, SsoDomainSummary, WorkosIdentityProvider } from './workos';

/**
 * The organisation's single sign-on settings (WS-5): what the four routes under
 * `/api/orgs/{orgSlug}/sso` share.
 *
 * ── Who may ──
 * Every route, reading included, asks these, in this order:
 *
 *  1. **A browser session.** A CLI token acts as its user for secrets, not for
 *     who can sign in as the organisation's members; a credential left on a
 *     build machine must not be able to open the identity-provider setup or
 *     switch the sign-in policy. Asked before the organisation is resolved, so
 *     a token learns nothing about which slugs exist.
 *  2. **The role, by what the request does** (review S2):
 *     - *Reading* the settings and switching a policy *off* need `org.update`
 *       — owners and admins, through the same `can()` every other
 *       organisation setting goes through, so an admin narrowed by a custom
 *       role that took it away is refused too.
 *     - *Turning SSO on*, *opening the setup portal* and switching a policy
 *       *on* need `sso.manage`, which **only owners hold** and no custom role
 *       can carry. Whoever controls these decides which identity provider
 *       vouches for the organisation's members — one that can then sign anybody
 *       in as any of them, and with the owner exemption out of the way, as an
 *       owner. An admin able to do that is an admin able to become an owner.
 *     A refused change files a `denied` record of what it attempted.
 *  3. **This deployment's WorkOS environment** (review S9). A link records the
 *     client id it was made with; a link made elsewhere — local development
 *     runs against WorkOS Staging over the production database — is refused
 *     rather than acted on, and an enable never adopts one. And anything that
 *     *writes* — turning SSO on, switching a policy on — also needs this
 *     deployment to be the environment the database belongs to
 *     (`workos_home`, review round 2, {@link requireWorkosHome}), so no other
 *     environment can write a link, or a requirement, in the first place.
 *  4. **The single sign-on add-on** (`samlSso`), for anything that turns
 *     something *on*: creating the WorkOS organisation, opening the setup
 *     portal, switching either policy on. Each WorkOS connection costs real
 *     money from the moment it exists (`.local/plans/v2/02-auth-sso.md`, P16),
 *     and the portal is where one is created — so it is gated on an add-on an
 *     operator set, never instant-on. Reading the status and switching a
 *     policy *off* are never gated: an organisation whose add-on lapsed can
 *     still see, and relax, what it has. **The add-on is the blast-radius
 *     gate**: an organisation without it can never attach an identity provider
 *     at all.
 *  5. For the setup portal only, **a fresh sign-in** of this session
 *     ({@link requireFreshSignIn}): the link is credential-grade.
 *
 * ── What WorkOS is trusted with ──
 * Nothing it says reaches the database except the id of an organisation this
 * request just created. Domains in particular are WorkOS's to verify, never
 * ours to declare (see `WorkosIdentityProvider.createOrganization`).
 */

/** The audit resource every SSO event is filed against: the organisation itself. */
export function ssoResource(orgId: string): AuditResource {
  return { type: 'org', id: orgId };
}

type AuditFile = { audit: AuditBuilder; record: (...events: AuditRecord[]) => void };

/** Step 1 above. */
export function requireBrowserSession(principal: Principal): void {
  if (principal.kind !== 'user') {
    throw errors.forbidden(
      'Single sign-on settings need a signed-in browser session, not a token.',
    );
  }
}

/**
 * Step 2 above, for reading and for switching off (`org.update`), filing a
 * `denied` record for each action the request attempted when it is refused.
 * `attempted` is empty for a read.
 */
export function authorizeSsoSettings(
  scope: OrgScope,
  file: AuditFile,
  attempted: readonly AuditAction[],
): void {
  authorizeFiling(scope, file, attempted, 'org.update');
}

/**
 * Step 2 above, for everything that turns something on (`sso.manage`, owners
 * only). Asked after {@link authorizeSsoSettings} where both apply, so an admin
 * is told no only about the part they may not do.
 */
export function authorizeSsoAdministration(
  scope: OrgScope,
  file: AuditFile,
  attempted: readonly AuditAction[],
): void {
  authorizeFiling(scope, file, attempted, 'sso.manage');
}

function authorizeFiling(
  scope: OrgScope,
  file: AuditFile,
  attempted: readonly AuditAction[],
  action: Action,
): void {
  const resource = ssoResource(scope.organization.id);
  auditingDenials(
    (decision) => {
      for (const attempt of attempted) file.record(file.audit.denied(attempt, resource, decision));
    },
    () => authorize(scope, action),
  );
}

/**
 * Step 3 above: whether the organisation's link — if it has one — was made in
 * this deployment's WorkOS environment. A link without a recorded client id (a
 * pre-release build's) counts as another environment's.
 */
export function linkIsThisEnvironment(
  organization: Pick<Organization, 'workosOrgId' | 'workosClientId'>,
  clientId: string,
): boolean {
  return organization.workosOrgId === null || organization.workosClientId === clientId;
}

/** Step 3 above, refusing — and filing `error` (`conflict`) for each action it stopped. */
export function requireThisWorkosEnvironment(
  organization: Pick<Organization, 'id' | 'workosOrgId' | 'workosClientId'>,
  clientId: string,
  file: AuditFile | null,
  attempted: readonly AuditAction[],
): void {
  if (linkIsThisEnvironment(organization, clientId)) return;
  if (file !== null) {
    for (const action of attempted) {
      file.record(file.audit.error(action, ssoResource(organization.id), 'conflict'));
    }
  }
  throw errors.ssoEnvironmentMismatch();
}

/**
 * Step 3 again, for anything that *writes* (review round 2): turning SSO on —
 * the only writer of the link — and switching a policy on refuse unless this
 * deployment's WorkOS environment is the one this database belongs to
 * (`workos_home`, migration 0023). Comparing a link with this deployment, as
 * {@link requireThisWorkosEnvironment} does, only refuses to *act on* another
 * environment's link; local development against WorkOS Staging over the
 * production database could still *write* one — a permanent link no
 * production sign-in can ever come through — or require a single sign-on
 * nobody in production can satisfy. Files `error` (`conflict`) for each action
 * it stopped.
 */
export async function requireWorkosHome(
  services: ServiceContext,
  clientId: string,
  file: AuditFile,
  organizationId: string,
  attempted: readonly AuditAction[],
): Promise<void> {
  const home = await findWorkosHome(services.db);
  if (home === clientId) return;
  for (const action of attempted) {
    file.record(file.audit.error(action, ssoResource(organizationId), 'conflict'));
  }
  if (home === null) {
    services.log
      .at('sso')
      .error(
        'Refused an SSO change: this database has no WorkOS environment recorded in workos_home ' +
          '(docs/self-hosting.md)',
      );
    throw errors.ssoHomeUnrecorded();
  }
  services.log
    .at('sso')
    .warn('Refused an SSO change from a WorkOS environment this database does not belong to', {
      clientId,
    });
  throw errors.ssoNotHomeEnvironment();
}

/**
 * Step 4 above. Files an `error` record (`quotaExceeded`, naming the add-on)
 * for each action the refusal stopped, then refuses with the `plan_limit`
 * the dashboard knows how to render.
 */
export function requireSsoAddon(
  scope: OrgScope,
  file: AuditFile,
  attempted: readonly AuditAction[],
): void {
  if (scope.entitlements.addons.samlSso) return;
  const resource = ssoResource(scope.organization.id);
  for (const action of attempted) {
    file.record(
      file.audit.error(action, resource, 'quotaExceeded', {
        addonName: 'saml',
        plan: scope.entitlements.plan,
      }),
    );
  }
  requireAddon(scope.entitlements, 'samlSso');
}

/**
 * Step 5 above: the setup portal needs a fresh sign-in of **this** session
 * (review S2).
 *
 * The link is credential-grade — whoever opens it chooses the identity provider
 * that signs in as the organisation's members — so a stolen session cookie or
 * an unlocked laptop must not be enough to mint one. The proof: `GET
 * /api/auth/login?reauth=1` makes AuthKit ask for the credential again
 * (`max_age=0`), the callback checks WorkOS's `auth_time` to see that it did,
 * and the brand-new session it issues records *when* the person authenticated
 * (`sessions.fresh_auth_at`). What is asked for here is that: this session's
 * own, under {@link REAUTH_SIGN_IN_MAX_AGE_SECONDS} old. Read, never spent, so
 * the owner can open the portal more than once in those minutes (each link is
 * audited).
 *
 * ── Its own record, not the vault reset's (review round 2, L7) ──
 * Round 1 borrowed the vault reset's first lock, which refuses an emailed code
 * (`MagicAuth`) by design — the reset's second lock is an emailed code, and
 * counting the first would make them one inbox twice. The portal has no second
 * lock, and an owner who signs in by emailed code could never open it. So the
 * session records a fresh authentication by any of
 * `FRESH_AUTHENTICATION_METHODS` (an emailed code included) under the same
 * freshness rule, and the reset's own record and rule are untouched — a spent
 * or exhausted reset attempt no longer closes the portal either. The ten
 * minutes run from the authentication itself, not from when the session was
 * written, which a held-back sign-in can delay by five.
 *
 * What it inherits, honestly: for a Google or SSO owner, a live Google or
 * identity-provider session satisfies the sign-in without a prompt (ADR 0010).
 */
export async function requireFreshSignIn(
  services: ServiceContext,
  principal: Extract<Principal, { kind: 'user' }>,
  file: AuditFile,
  organizationId: string,
): Promise<void> {
  const freshAuthAt = await findSessionFreshAuth(services.db, {
    sessionId: principal.sessionId,
    userId: principal.user.id,
  });
  if (
    freshAuthAt !== null &&
    freshAuthAt.getTime() >= Date.now() - REAUTH_SIGN_IN_MAX_AGE_SECONDS * 1000
  ) {
    return;
  }
  file.record(
    file.audit.error(
      'org.sso.portal_link_created',
      ssoResource(organizationId),
      'invalidCredentials',
    ),
  );
  throw errors.reauthRequired(
    'Confirm it’s you before opening the setup portal: sign in again, then open it within ten ' +
      'minutes.',
  );
}

/**
 * A failed WorkOS call, as the response the settings give.
 *
 * Every failure is ours or WorkOS's, never the caller's — the request was
 * well-formed by the time anything was forwarded — and the two kinds get two
 * answers (review C7):
 *
 *  - **WorkOS could not be asked** — unreachable, a 5xx, our key refused, a
 *    rate limit: a 503 (a 429 for the rate limit) that says nothing was changed
 *    and to try again.
 *  - **WorkOS answered and refused** — a 4xx about a request this server built:
 *    an organisation deleted in the WorkOS dashboard, a parameter WorkOS
 *    stopped accepting. Trying again changes nothing, so a 502 that names
 *    WorkOS's own category (bounded, log-safe) for whoever takes it to support.
 *
 * What went wrong goes to the log at `error` either way.
 */
export function ssoProviderFailure(
  services: ServiceContext,
  cause: unknown,
  call: string,
): unknown {
  const log = services.log.at('sso');
  if (cause instanceof IdentityProviderUnavailableError) {
    log.error(`WorkOS was ${cause.reason} during ${call}; the SSO settings change did not happen`, {
      reason: cause.reason,
    });
    return cause.reason === 'rate-limited'
      ? errors.rateLimited()
      : errors.ssoProviderUnavailable(`workos ${cause.reason}`);
  }
  if (cause instanceof IdentityVerificationError) {
    log.error(`WorkOS refused ${call}; the SSO settings change did not happen`, {
      // A category minted by `providerFailure`, already bounded and log-safe.
      reason: cause.reason,
    });
    return errors.ssoProviderRefused(cause.reason, `workos refused ${call}`);
  }
  return cause;
}

/**
 * What a failed WorkOS call is filed as: `upstreamUnavailable` when WorkOS
 * could not be asked or refused the request, `internal` for anything else —
 * which {@link ssoProviderFailure} passes through to become a 500.
 */
export function ssoFailureReason(cause: unknown): AuditErrorReason {
  return cause instanceof IdentityProviderUnavailableError ||
    cause instanceof IdentityVerificationError
    ? 'upstreamUnavailable'
    : 'internal';
}

/* ── What WorkOS says, briefly remembered ─────────────────────────────────── */

interface WorkosLists {
  connections: SsoConnectionSummary[];
  domains: SsoDomainSummary[];
}

/**
 * How long the settings reuse what WorkOS last said about one organisation's
 * connections and domains (review S7).
 *
 * The status read costs two WorkOS calls, and a Worker has six outbound
 * connections to spend per request; a settings page left open, a tab reloaded
 * in a loop, or a script polling it would otherwise turn each read into two
 * more calls against WorkOS's rate limit — which the sign-in callback shares.
 * Twenty seconds is short enough that somebody back from the setup portal sees
 * their new connection on the next refresh or two, and long enough to absorb a
 * burst.
 */
export const WORKOS_LIST_CACHE_TTL_MS = 20_000;

/** A bound on the cache, so an isolate serving many organisations cannot grow it without end. */
const WORKOS_LIST_CACHE_LIMIT = 256;

/**
 * Per isolate, keyed by the WorkOS environment *and* organisation — the whole
 * of the tenancy this data belongs to, so no organisation can be answered with
 * another's (the rule `context.ts` sets for anything cached). Filled only after
 * the request reading it was authorised for that organisation. Only successes
 * are kept: a WorkOS outage is asked about again on the next read.
 */
const workosListCache = new Map<string, { at: number; lists: WorkosLists }>();

function cacheKey(clientId: string, workosOrgId: string): string {
  return `${clientId}\u0000${workosOrgId}`;
}

/**
 * The organisation's connections and domains: from the cache when `fresh` is
 * not asked for and an answer under {@link WORKOS_LIST_CACHE_TTL_MS} old is
 * held, from WorkOS otherwise. A decision that turns something on — requiring
 * SSO — always asks WorkOS itself.
 */
export async function workosLists(
  provider: Pick<WorkosIdentityProvider, 'listConnections' | 'domains' | 'clientId'>,
  workosOrgId: string,
  options: { fresh?: boolean } = {},
): Promise<WorkosLists> {
  const key = cacheKey(provider.clientId, workosOrgId);
  const now = Date.now();
  const held = workosListCache.get(key);
  if (options.fresh !== true && held !== undefined && now - held.at < WORKOS_LIST_CACHE_TTL_MS) {
    return held.lists;
  }

  const [connections, domains] = await Promise.all([
    provider.listConnections(workosOrgId),
    provider.domains(workosOrgId),
  ]);
  const lists = { connections, domains };

  workosListCache.delete(key);
  workosListCache.set(key, { at: now, lists });
  while (workosListCache.size > WORKOS_LIST_CACHE_LIMIT) {
    const oldest = workosListCache.keys().next().value;
    if (oldest === undefined) break;
    workosListCache.delete(oldest);
  }
  return lists;
}

/** Forgets what WorkOS said about one organisation — after anything that changes it. */
export function forgetWorkosLists(clientId: string, workosOrgId: string): void {
  workosListCache.delete(cacheKey(clientId, workosOrgId));
}

/** Exists for tests. */
export function resetWorkosListCacheForTesting(): void {
  workosListCache.clear();
}

/** How many member addresses the domain warning reads, at most. */
const MEMBER_ADDRESS_LIMIT = 1000;

/**
 * How many active non-owner members have an address outside the
 * organisation's verified domains (review C2) — people whose identity-provider
 * sign-in the callback will refuse (an SSO sign-in is believed only for a
 * verified domain), and so who would be shut out of the organisation the
 * moment `sso_required` goes on. Owners are left out: they are exempt.
 */
export async function membersOutsideVerifiedDomains(
  services: ServiceContext,
  orgId: string,
  domains: readonly SsoDomainSummary[],
): Promise<number> {
  const verified = new Set(
    domains.filter((domain) => domain.state === 'verified').map((domain) => domain.domain),
  );
  const addresses = await listMemberAddresses(services.db, orgId, MEMBER_ADDRESS_LIMIT);
  return addresses.filter((address) => {
    const domain = emailDomain(address);
    return domain === null || !verified.has(domain);
  }).length;
}

/**
 * The status the settings show: the organisation's own row, plus — once SSO is
 * on — its connections and domains as WorkOS reports them, and how many
 * members sit outside the verified domains.
 *
 * WorkOS being unreachable does not fail the read. The page still needs to
 * show, and switch off, what this deployment holds; the lists come back `null`
 * with `providerReachable: false`, and the outage is logged. A link made in
 * another WorkOS environment is not asked about at all — the lists are `null`
 * the same way; `GET` refuses such a link outright before it gets here.
 */
export async function ssoStatus(
  services: ServiceContext,
  organization: Pick<
    Organization,
    'id' | 'workosOrgId' | 'workosClientId' | 'ssoRequired' | 'jitJoinEnabled' | 'seatLimit'
  >,
  addonEnabled: boolean,
  provider: () => Pick<WorkosIdentityProvider, 'listConnections' | 'domains' | 'clientId'>,
  options: { fresh?: boolean } = {},
): Promise<SsoStatusPayload> {
  const workosOrgId = organization.workosOrgId;
  const unknown = { connections: null, domains: null, membersOutsideVerifiedDomains: null };
  if (workosOrgId === null) {
    return toSsoStatus(organization, addonEnabled, { ...unknown, reachable: true });
  }

  // Constructed only now: an organisation without SSO answers from the row
  // alone, so a deployment missing its WorkOS configuration can still say so.
  const workos = provider();
  if (!linkIsThisEnvironment(organization, workos.clientId)) {
    return toSsoStatus(organization, addonEnabled, { ...unknown, reachable: false });
  }
  try {
    const { connections, domains } = await workosLists(workos, workosOrgId, options);
    return toSsoStatus(organization, addonEnabled, {
      connections,
      domains,
      membersOutsideVerifiedDomains: await membersOutsideVerifiedDomains(
        services,
        organization.id,
        domains,
      ),
      reachable: true,
    });
  } catch (cause) {
    if (
      !(cause instanceof IdentityProviderUnavailableError) &&
      !(cause instanceof IdentityVerificationError)
    ) {
      throw cause;
    }
    services.log
      .at('sso')
      .warn('Could not read the organisation’s SSO connections from WorkOS; showing the rest', {
        error: describeError(cause),
      });
    return toSsoStatus(organization, addonEnabled, { ...unknown, reachable: false });
  }
}
