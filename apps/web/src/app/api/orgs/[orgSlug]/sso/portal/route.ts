import { actorId } from '@/server/actor';
import { publicOrigin } from '@/server/bindings';
import { errors } from '@/server/errors';
import { json } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import {
  authorizeSsoAdministration,
  forgetWorkosLists,
  requireBrowserSession,
  requireFreshSignIn,
  requireSsoAddon,
  requireThisWorkosEnvironment,
  requireWorkosHome,
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
 * `POST`, though it changes nothing here, because what it hands out is
 * **credential-grade** for a few minutes: whoever opens the link decides which
 * identity provider vouches for this organisation's members — one that can
 * then sign in as any of them. So it is minted only:
 *
 *  - for an **owner** (`sso.manage`; review S2 — an admin able to do this is an
 *    admin able to sign in as an owner),
 *  - in a browser session that **signed in again within the last ten minutes**
 *    (`requireFreshSignIn` — the session's own fresh authentication, by any
 *    method that re-proves who the person is, an emailed code included; a
 *    stolen cookie or an unattended laptop is not enough),
 *  - once SSO is on, in this deployment's WorkOS environment — which must be
 *    the one this database belongs to — with the add-on held,
 *
 * rate limited like a write and audited every time
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
    if (principal.kind !== 'user') throw errors.forbidden();
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    const organization = scope.organization;
    const orgAudit = audit(organization.id);
    const file = { audit: orgAudit, record };
    const resource = ssoResource(organization.id);

    authorizeSsoAdministration(scope, file, ['org.sso.portal_link_created']);

    if (organization.workosOrgId === null) {
      record(orgAudit.error('org.sso.portal_link_created', resource, 'invalidInput'));
      throw errors.conflict(
        'Turn on single sign-on for this organisation before setting up its identity provider.',
      );
    }

    const provider = workosProvider(services.env);
    requireThisWorkosEnvironment(organization, provider.clientId, file, [
      'org.sso.portal_link_created',
    ]);
    requireSsoAddon(scope, file, ['org.sso.portal_link_created']);
    // The portal is where connections are made: only from the environment
    // this database belongs to (review round 2).
    await requireWorkosHome(services, provider.clientId, file, organization.id, [
      'org.sso.portal_link_created',
    ]);
    // Last of the gates, because it is the one the person can do something
    // about in the moment: sign in again and come back.
    await requireFreshSignIn(services, principal, file, organization.id);

    let link: string;
    try {
      link = await provider.generatePortalLink({
        workosOrgId: organization.workosOrgId,
        returnUrl: `${publicOrigin(services.env)}/app/${encodeURIComponent(organization.slug)}/settings#single-sign-on`,
      });
    } catch (cause) {
      record(orgAudit.error('org.sso.portal_link_created', resource, ssoFailureReason(cause)));
      throw ssoProviderFailure(services, cause, 'generating an Admin Portal link');
    }

    record(orgAudit.success('org.sso.portal_link_created', resource));
    // What the portal is for is changing the connections and domains, so the
    // settings ask WorkOS afresh once the person is back.
    forgetWorkosLists(provider.clientId, organization.workosOrgId);

    return json({ link });
  },
);
