import { actorId } from '@/server/actor';
import { publicOrigin } from '@/server/bindings';
import { errors } from '@/server/errors';
import { json } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import {
  authorizeSsoSettings,
  requireBrowserSession,
  requireSsoAddon,
  ssoFailureReason,
  ssoProviderFailure,
  ssoResource,
} from '@/server/sso-service';
import { resolveOrg } from '@/server/tenancy';
import { workosProvider } from '@/server/workos';

/**
 * A WorkOS Admin Portal link for the organisation's single sign-on: the page
 * where its IT admin connects Okta, Microsoft Entra ID, Google Workspace or any
 * SAML or OIDC identity provider, and proves the organisation's domains by DNS.
 * xecret never handles the identity provider's metadata or certificates.
 *
 * `POST`, though it changes nothing here, because what it hands out is as good
 * as a credential for a few minutes: whoever opens the link decides which
 * identity provider vouches for this organisation's members. So it is minted
 * only for an owner or admin in a browser session, only once SSO is on and the
 * add-on is held, it is rate limited like a write and audited every time
 * (`org.sso.portal_link_created`) — and the link itself is never logged,
 * stored or put in the audit record. `json()` marks the response `no-store`.
 *
 * The portal sends the person back to this organisation's settings, to the
 * single sign-on section, when they are done.
 */

type Params = { orgSlug: string };

export const POST = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    requireBrowserSession(principal);
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    const organization = scope.organization;
    const orgAudit = audit(organization.id);
    const file = { audit: orgAudit, record };
    const resource = ssoResource(organization.id);

    authorizeSsoSettings(scope, file, ['org.sso.portal_link_created']);

    if (organization.workosOrgId === null) {
      record(orgAudit.error('org.sso.portal_link_created', resource, 'invalidInput'));
      throw errors.conflict(
        'Turn on single sign-on for this organisation before setting up its identity provider.',
      );
    }

    requireSsoAddon(scope, file, ['org.sso.portal_link_created']);

    let link: string;
    try {
      link = await workosProvider(services.env).generatePortalLink({
        workosOrgId: organization.workosOrgId,
        returnUrl: `${publicOrigin(services.env)}/app/${encodeURIComponent(organization.slug)}/settings#single-sign-on`,
      });
    } catch (cause) {
      record(orgAudit.error('org.sso.portal_link_created', resource, ssoFailureReason(cause)));
      throw ssoProviderFailure(services, cause, 'generating an Admin Portal link');
    }

    record(orgAudit.success('org.sso.portal_link_created', resource));

    return json({ link });
  },
);
