import { IdentityVerificationError } from '@xecret/core/auth';
import type {
  AuditAction,
  AuditBuilder,
  AuditErrorReason,
  AuditRecord,
  AuditResource,
} from '@xecret/core/audit';
import { auditingDenials } from '@xecret/core/authz';
import type { Organization } from '@xecret/db/repositories';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { describeError } from './logging';
import { errors } from './errors';
import { requireAddon } from './entitlements';
import { toSsoStatus } from './schemas/sso';
import type { SsoStatusPayload } from './schemas/sso';
import { authorize } from './tenancy';
import type { OrgScope } from './tenancy';
import { IdentityProviderUnavailableError } from './workos';
import type { WorkosIdentityProvider } from './workos';

/**
 * The organisation's single sign-on settings (WS-5): what the four routes under
 * `/api/orgs/{orgSlug}/sso` share.
 *
 * ── Who may ──
 * Every route, reading included, asks the same three things, in this order:
 *
 *  1. **A browser session.** A CLI token acts as its user for secrets, not for
 *     who can sign in as the organisation's members; a credential left on a
 *     build machine must not be able to open the identity-provider setup or
 *     switch the sign-in policy. Asked before the organisation is resolved, so
 *     a token learns nothing about which slugs exist.
 *  2. **`org.update`** — owners and admins, through the same `can()` every
 *     other organisation setting goes through, so an admin narrowed by a custom
 *     role that took `org.update` away is refused too. A refused mutation files
 *     a `denied` record of what it attempted.
 *  3. **The single sign-on add-on** (`samlSso`), for anything that turns
 *     something *on*: creating the WorkOS organisation, opening the setup
 *     portal, switching either policy on. Each WorkOS connection costs real
 *     money from the moment it exists (`.local/plans/v2/02-auth-sso.md`, P16),
 *     and the portal is where one is created — so it is gated on an add-on an
 *     operator set, never instant-on. Reading the status and switching a
 *     policy *off* are never gated: an organisation whose add-on lapsed can
 *     still see, and relax, what it has.
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

/** Step 1 above. */
export function requireBrowserSession(principal: Principal): void {
  if (principal.kind !== 'user') {
    throw errors.forbidden(
      'Single sign-on settings need a signed-in browser session, not a token.',
    );
  }
}

/**
 * Step 2 above, filing a `denied` record for each action the request
 * attempted when it is refused. `attempted` is empty for a read.
 */
export function authorizeSsoSettings(
  scope: OrgScope,
  file: { audit: AuditBuilder; record: (...events: AuditRecord[]) => void },
  attempted: readonly AuditAction[],
): void {
  const resource = ssoResource(scope.organization.id);
  auditingDenials(
    (decision) => {
      for (const action of attempted) file.record(file.audit.denied(action, resource, decision));
    },
    () => authorize(scope, 'org.update'),
  );
}

/**
 * Step 3 above. Files an `error` record (`quotaExceeded`, naming the add-on)
 * for each action the refusal stopped, then refuses with the `plan_limit`
 * the dashboard knows how to render.
 */
export function requireSsoAddon(
  scope: OrgScope,
  file: { audit: AuditBuilder; record: (...events: AuditRecord[]) => void },
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
 * A failed WorkOS call, as the response the settings give.
 *
 * Every failure is ours or WorkOS's, never the caller's — the request was
 * well-formed by the time anything was forwarded — so every one is the same
 * 503 with a sentence that says nothing was changed, and what went wrong goes
 * to the log at `error`, where somebody can act on it. A rate limit is the one
 * exception, answered as a 429 because waiting is what fixes it.
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
    // A 4xx about a request this server built: an organisation deleted in the
    // WorkOS dashboard, a parameter WorkOS stopped accepting. Not something
    // the person can fix, so not something they are blamed for.
    log.error(`WorkOS refused ${call}; the SSO settings change did not happen`, {
      // A category minted by `providerFailure`, already bounded and log-safe.
      reason: cause.reason,
    });
    return errors.ssoProviderUnavailable(`workos refused ${call}`);
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

/**
 * The status the settings show: the organisation's own row, plus — once SSO is
 * on — its connections and domains as WorkOS reports them.
 *
 * WorkOS being unreachable does not fail the read. The page still needs to
 * show, and switch off, what this deployment holds; the two lists come back
 * `null` with `providerReachable: false`, and the outage is logged.
 */
export async function ssoStatus(
  services: ServiceContext,
  organization: Pick<Organization, 'workosOrgId' | 'ssoRequired' | 'jitJoinEnabled' | 'seatLimit'>,
  addonEnabled: boolean,
  provider: () => Pick<WorkosIdentityProvider, 'listConnections' | 'domains'>,
): Promise<SsoStatusPayload> {
  const workosOrgId = organization.workosOrgId;
  if (workosOrgId === null) {
    return toSsoStatus(organization, addonEnabled, {
      connections: null,
      domains: null,
      reachable: true,
    });
  }

  // Constructed only now: an organisation without SSO answers from the row
  // alone, so a deployment missing its WorkOS configuration can still say so.
  const workos = provider();
  try {
    const [connections, domains] = await Promise.all([
      workos.listConnections(workosOrgId),
      workos.domains(workosOrgId),
    ]);
    return toSsoStatus(organization, addonEnabled, { connections, domains, reachable: true });
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
    return toSsoStatus(organization, addonEnabled, {
      connections: null,
      domains: null,
      reachable: false,
    });
  }
}
