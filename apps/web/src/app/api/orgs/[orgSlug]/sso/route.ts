import type { AuditAction } from '@xecret/core/audit';
import {
  findOrganizationById,
  RepositoryError,
  setOrgWorkosOrgId,
  updateOrgSsoSettings,
} from '@xecret/db/repositories';
import type { Organization } from '@xecret/db/repositories';
import { actorId } from '@/server/actor';
import type { ServiceContext } from '@/server/context';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { ssoSettingsPatchSchema, toSsoStatus } from '@/server/schemas/sso';
import {
  authorizeSsoSettings,
  requireBrowserSession,
  requireSsoAddon,
  ssoFailureReason,
  ssoProviderFailure,
  ssoResource,
  ssoStatus,
} from '@/server/sso-service';
import { authorize, resolveOrg } from '@/server/tenancy';
import { workosProvider } from '@/server/workos';

/**
 * An organisation's single sign-on: where it stands, turning it on, and its two
 * sign-in policies. The Admin Portal link is beside this, at `…/sso/portal`.
 *
 * Owners and admins, from a browser session; the add-on for anything that
 * switches something on. `server/sso-service.ts` says why each gate is there.
 */

type Params = { orgSlug: string };

/**
 * Where the organisation's SSO stands: on or off, its connections and domains
 * at WorkOS, `sso_required`, the just-in-time opt-in, and whether it holds the
 * add-on. Never gated on the add-on — an organisation whose add-on lapsed can
 * still see, and switch off, what it has.
 */
export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  requireBrowserSession(principal);
  const scope = await resolveOrg(principal, params.orgSlug, services);
  // The same gate as the writes. A read files no denial: it could change nothing.
  authorize(scope, 'org.update');

  return json({
    sso: await ssoStatus(services, scope.organization, scope.entitlements.addons.samlSso, () =>
      workosProvider(services.env),
    ),
  });
});

/**
 * Turns SSO on: creates the WorkOS organisation the identity-provider
 * connections will hang off, and links it. Nothing about who may sign in
 * changes — a connection still has to be set up in the portal, and both
 * policies start off.
 *
 * Idempotent. An organisation already linked answers 200 with its status and
 * creates nothing; the first enable answers 201. Two enables racing each other
 * get one WorkOS organisation (the creation is idempotency-keyed by the
 * xecret organisation), and if they ever got two, the loser deletes its orphan
 * and answers with the winner's.
 *
 * The WorkOS organisation is created with a name and this organisation's id,
 * and **no domains** — domains are added and verified through WorkOS's own
 * flow, never declared here (PR #114).
 */
export const POST = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    requireBrowserSession(principal);
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    const organization = scope.organization;
    const orgAudit = audit(organization.id);
    const file = { audit: orgAudit, record };
    const addon = scope.entitlements.addons.samlSso;

    authorizeSsoSettings(scope, file, ['org.sso.enabled']);

    // Already on: the answer is the status, and nothing is created or filed.
    if (organization.workosOrgId !== null) {
      return json({
        sso: await ssoStatus(services, organization, addon, () => workosProvider(services.env)),
      });
    }

    requireSsoAddon(scope, file, ['org.sso.enabled']);

    const provider = workosProvider(services.env);
    let workosOrgId: string;
    try {
      workosOrgId = await provider.createOrganization({
        name: organization.name,
        externalId: organization.id,
      });
    } catch (cause) {
      record(
        orgAudit.error('org.sso.enabled', ssoResource(organization.id), ssoFailureReason(cause)),
      );
      throw ssoProviderFailure(services, cause, 'creating the WorkOS organisation');
    }

    let linked: Organization;
    try {
      // The id this request's own call returned, never one a client named
      // (PR #100, note 7).
      linked = await setOrgWorkosOrgId(services.db, organization.id, workosOrgId);
    } catch (cause) {
      if (!(cause instanceof RepositoryError)) throw cause;
      if (cause.code === 'notFound') {
        throw errors.notFound('organisation deleted during SSO enable');
      }
      if (cause.code !== 'conflict') throw cause;
      return answerLostRace(services, organization.id, workosOrgId, addon, provider);
    }

    record(orgAudit.success('org.sso.enabled', ssoResource(organization.id)));

    // A WorkOS organisation made a moment ago has no connection and no domain
    // yet, so there is nothing to ask it.
    return json(
      { sso: toSsoStatus(linked, addon, { connections: [], domains: [], reachable: true }) },
      { status: 201 },
    );
  },
);

/**
 * Switches `sso_required` and the just-in-time opt-in.
 *
 * Switching either **off** is always allowed. Switching either **on** needs
 * SSO turned on and the add-on, and `sso_required` also needs an **active**
 * connection at WorkOS: requiring a sign-in nobody can complete would leave
 * only owners able to get in (they are exempt — see `server/sign-in.ts`).
 * Each switch that actually moved is audited with its new value; one that was
 * already where it was asked to be files nothing.
 */
export const PATCH = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    requireBrowserSession(principal);
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveOrg(principal, params.orgSlug, services);
    const organization = scope.organization;
    const orgAudit = audit(organization.id);
    const file = { audit: orgAudit, record };
    const resource = ssoResource(organization.id);

    // Authorised before the body is read, so a caller without the role learns
    // nothing from which bodies are well-formed. Without a body there is no
    // knowing which switch was reached for, so a refusal names both.
    authorizeSsoSettings(scope, file, ['org.sso.required_toggled', 'org.sso.jit_toggled']);

    const patch = await parseJsonBody(request, ssoSettingsPatchSchema);

    const switchingOn: AuditAction[] = [];
    if (patch.ssoRequired === true && !organization.ssoRequired) {
      switchingOn.push('org.sso.required_toggled');
    }
    if (patch.jitJoinEnabled === true && !organization.jitJoinEnabled) {
      switchingOn.push('org.sso.jit_toggled');
    }

    if (switchingOn.length > 0) {
      if (organization.workosOrgId === null) {
        for (const action of switchingOn) record(orgAudit.error(action, resource, 'invalidInput'));
        throw errors.conflict(
          'Turn on single sign-on and connect an identity provider before changing its sign-in policy.',
        );
      }
      requireSsoAddon(scope, file, switchingOn);
    }

    if (switchingOn.includes('org.sso.required_toggled') && organization.workosOrgId !== null) {
      const provider = workosProvider(services.env);
      let active: boolean;
      try {
        const connections = await provider.listConnections(organization.workosOrgId);
        active = connections.some((connection) => connection.state === 'active');
      } catch (cause) {
        record(orgAudit.error('org.sso.required_toggled', resource, ssoFailureReason(cause)));
        throw ssoProviderFailure(services, cause, 'listing the SSO connections');
      }
      if (!active) {
        record(orgAudit.error('org.sso.required_toggled', resource, 'invalidInput'));
        throw errors.conflict(
          'Requiring single sign-on needs an active identity-provider connection. Finish setting ' +
            'one up in the setup portal first — until then nobody but owners could sign in.',
        );
      }
    }

    const change = await updateOrgSsoSettings(services.db, organization.id, {
      ssoRequired: patch.ssoRequired,
      jitJoinEnabled: patch.jitJoinEnabled,
    }).catch((cause: unknown) => {
      if (cause instanceof RepositoryError && cause.code === 'notFound') {
        throw errors.notFound('organisation deleted during SSO settings update');
      }
      if (cause instanceof RepositoryError && cause.code === 'conflict') {
        throw errors.conflict(cause.message);
      }
      throw cause;
    });

    // Only what moved, measured against the row as it stood under the lock.
    const after = change.organization;
    if (after.ssoRequired !== change.previous.ssoRequired) {
      record(
        orgAudit.success('org.sso.required_toggled', resource, { enabled: after.ssoRequired }),
      );
    }
    if (after.jitJoinEnabled !== change.previous.jitJoinEnabled) {
      record(orgAudit.success('org.sso.jit_toggled', resource, { enabled: after.jitJoinEnabled }));
    }

    return json({
      sso: await ssoStatus(services, after, scope.entitlements.addons.samlSso, () =>
        workosProvider(services.env),
      ),
    });
  },
);

/**
 * Another request linked this organisation between the lookup and the write.
 *
 * If it linked a *different* WorkOS organisation, the one this request created
 * is an orphan nobody will ever resolve to, and is deleted — after the
 * response, and never allowed to fail it. If the organisation is still
 * unlinked, the WorkOS organisation already belongs to another xecret
 * organisation (`organizations_workos_org_id_unique`), which nothing here can
 * produce; it is left alone, because it is somebody else's, and refused loudly.
 */
async function answerLostRace(
  services: ServiceContext,
  orgId: string,
  createdWorkosOrgId: string,
  addon: boolean,
  provider: ReturnType<typeof workosProvider>,
): Promise<Response> {
  const current = await findOrganizationById(services.db, orgId);
  if (!current) throw errors.notFound('organisation deleted during SSO enable');

  if (current.workosOrgId === null) {
    services.log
      .at('sso')
      .error(
        'WorkOS answered an SSO enable with an organisation already linked to another ' +
          'organisation here; nothing was linked',
      );
    throw errors.conflict('Single sign-on could not be turned on. Contact support.');
  }

  if (current.workosOrgId !== createdWorkosOrgId) {
    services.waitUntil(
      provider.deleteOrganization(createdWorkosOrgId).catch((cause: unknown) => {
        services.log
          .at('sso')
          .error('Could not delete an orphaned WorkOS organisation after a lost SSO enable race', {
            error: cause instanceof Error ? cause.name : 'unknown',
          });
      }),
    );
  }

  return json({
    sso: await ssoStatus(services, current, addon, () => provider),
  });
}
