import type { AuditAction } from '@xecret/core/audit';
import {
  countNonSsoAccess,
  findOrganizationById,
  RepositoryError,
  setOrgWorkosOrgId,
  updateOrgSsoSettings,
} from '@xecret/db/repositories';
import { actorId } from '@/server/actor';
import type { ServiceContext } from '@/server/context';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { ssoSettingsPatchSchema, toSsoStatus } from '@/server/schemas/sso';
import type { NonSsoAccessPayload } from '@/server/schemas/sso';
import {
  authorizeSsoAdministration,
  authorizeSsoSettings,
  forgetWorkosLists,
  requireBrowserSession,
  requireSsoAddon,
  requireThisWorkosEnvironment,
  ssoFailureReason,
  ssoProviderFailure,
  ssoResource,
  ssoStatus,
  workosLists,
} from '@/server/sso-service';
import { authorize, resolveOrg } from '@/server/tenancy';
import { workosProvider } from '@/server/workos';

/**
 * An organisation's single sign-on: where it stands, turning it on, and its two
 * sign-in policies. The Admin Portal link is beside this, at `…/sso/portal`.
 *
 * Reading, and switching a policy off: owners and admins. Turning SSO on and
 * switching a policy on: owners only (`sso.manage`). A browser session for all
 * of it; the add-on for anything that switches something on; this
 * deployment's WorkOS environment for anything that touches the link.
 * `server/sso-service.ts` says why each gate is there.
 */

type Params = { orgSlug: string };

/**
 * Where the organisation's SSO stands: on or off, its connections and domains
 * at WorkOS, `sso_required`, the just-in-time opt-in, whether it holds the
 * add-on, and how many members sit outside the verified domains. Never gated
 * on the add-on — an organisation whose add-on lapsed can still see, and
 * switch off, what it has.
 *
 * Refused with a 409 for a link made in another WorkOS environment (review S9):
 * there is nothing true this deployment could say about it.
 *
 * WorkOS's two lists are reused for a few seconds (review S7) — a settings page
 * reloaded in a loop would otherwise be two WorkOS calls a time against the
 * rate limit the sign-in callback shares.
 */
export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  requireBrowserSession(principal);
  const scope = await resolveOrg(principal, params.orgSlug, services);
  // The read gate. A read files no denial: it could change nothing.
  authorize(scope, 'org.update');

  const organization = scope.organization;
  if (organization.workosOrgId !== null) {
    requireThisWorkosEnvironment(organization, workosProvider(services.env).clientId, null, []);
  }

  return json({
    sso: await ssoStatus(services, organization, scope.entitlements.addons.samlSso, () =>
      workosProvider(services.env),
    ),
  });
});

/**
 * Turns SSO on: creates the WorkOS organisation the identity-provider
 * connections will hang off, and links it — recording which WorkOS
 * environment it was made in. Nothing about who may sign in changes — a
 * connection still has to be set up in the portal, and both policies start
 * off. Owners only.
 *
 * Idempotent. An organisation already linked (in this environment) answers 200
 * with its status and creates nothing; the first enable answers 201. Two
 * enables racing each other get one WorkOS organisation (the creation is
 * idempotency-keyed by the xecret organisation), and exactly one of them — the
 * one whose write linked it — answers 201 and files `org.sso.enabled` (review
 * C5); if they ever got two, the loser deletes its orphan and answers with the
 * winner's.
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

    authorizeSsoAdministration(scope, file, ['org.sso.enabled']);

    const provider = workosProvider(services.env);

    // Already on: the answer is the status, and nothing is created or filed —
    // unless the link is another environment's, which no enable here adopts.
    if (organization.workosOrgId !== null) {
      requireThisWorkosEnvironment(organization, provider.clientId, file, ['org.sso.enabled']);
      return json({ sso: await ssoStatus(services, organization, addon, () => provider) });
    }

    requireSsoAddon(scope, file, ['org.sso.enabled']);

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

    let linked: Awaited<ReturnType<typeof setOrgWorkosOrgId>>;
    try {
      // The id this request's own call returned, never one a client named
      // (PR #100, note 7), and the environment this deployment talks to.
      linked = await setOrgWorkosOrgId(
        services.db,
        organization.id,
        workosOrgId,
        provider.clientId,
      );
    } catch (cause) {
      if (!(cause instanceof RepositoryError)) throw cause;
      if (cause.code === 'notFound') {
        throw errors.notFound('organisation deleted during SSO enable');
      }
      if (cause.code !== 'conflict') throw cause;
      return answerLostRace(services, organization.id, workosOrgId, addon, provider);
    }

    // Another enable linked this same WorkOS organisation first (the
    // idempotency key gave both requests the one organisation). It filed
    // `org.sso.enabled` and answered 201; this one changed nothing.
    if (!linked.changed) {
      return json({ sso: await ssoStatus(services, linked.organization, addon, () => provider) });
    }

    record(orgAudit.success('org.sso.enabled', ssoResource(organization.id)));

    // A WorkOS organisation made a moment ago has no connection and no domain
    // yet, so there is nothing to ask it.
    return json(
      {
        sso: toSsoStatus(linked.organization, addon, {
          connections: [],
          domains: [],
          membersOutsideVerifiedDomains: null,
          reachable: true,
        }),
      },
      { status: 201 },
    );
  },
);

/**
 * Switches `sso_required` and the just-in-time opt-in.
 *
 * Switching either **off** needs `org.update` (owners and admins) and nothing
 * else: relaxing a policy can never lock anybody out. Switching either **on**
 * needs `sso.manage` (owners only), SSO turned on in this WorkOS environment,
 * and the add-on; `sso_required` also needs an **active** connection and at
 * least one **verified domain** at WorkOS (review C2) — an identity provider
 * can only sign in addresses at a verified domain, so requiring it without one
 * would leave only the owners able to get in.
 *
 * ── Gated on what is asked for, not on what was there ──
 * Every gate above applies to the state the request asks for, whether or not
 * the row already holds it (review C4). Comparing with the row read before the
 * write's lock let a request that saw "already on" skip the gates while a
 * concurrent one switched it off — and then switch it back on, ungated. A
 * request that asks for "on" passes the gates for "on", every time; the setter
 * then writes under the lock, and only a flag that actually moved is audited.
 *
 * ── What switching `sso_required` on does at once ──
 * Every session and CLI token of a non-owner member that did not come through
 * this organisation's own single sign-on loses this organisation on its next
 * request (`resolveOrg`) — and keeps every other organisation its holder is
 * in. Nothing is revoked; the credentials simply stop reaching here. The
 * response says how many there are (`nonSsoAccess`), so the person who flipped
 * the switch knows how many people are about to be asked to sign in again.
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
    if (patch.ssoRequired === true) switchingOn.push('org.sso.required_toggled');
    if (patch.jitJoinEnabled === true) switchingOn.push('org.sso.jit_toggled');

    const provider = workosProvider(services.env);

    if (switchingOn.length > 0) {
      authorizeSsoAdministration(scope, file, switchingOn);
      if (organization.workosOrgId === null) {
        for (const action of switchingOn) record(orgAudit.error(action, resource, 'invalidInput'));
        throw errors.conflict(
          'Turn on single sign-on and connect an identity provider before changing its sign-in policy.',
        );
      }
      requireThisWorkosEnvironment(organization, provider.clientId, file, switchingOn);
      requireSsoAddon(scope, file, switchingOn);
    }

    if (patch.ssoRequired === true && organization.workosOrgId !== null) {
      let lists: Awaited<ReturnType<typeof workosLists>>;
      try {
        // Asked of WorkOS itself, never of the settings' cache: this is a
        // decision about who can sign in.
        lists = await workosLists(provider, organization.workosOrgId, { fresh: true });
      } catch (cause) {
        record(orgAudit.error('org.sso.required_toggled', resource, ssoFailureReason(cause)));
        throw ssoProviderFailure(services, cause, 'listing the SSO connections');
      }
      const active = lists.connections.some((connection) => connection.state === 'active');
      const verified = lists.domains.some((domain) => domain.state === 'verified');
      if (!active || !verified) {
        record(orgAudit.error('org.sso.required_toggled', resource, 'invalidInput'));
        throw errors.conflict(
          !active
            ? 'Requiring single sign-on needs an active identity-provider connection. Finish ' +
                'setting one up in the setup portal first — until then nobody but owners could ' +
                'sign in.'
            : 'Requiring single sign-on needs at least one verified domain. Verify your ' +
                'company’s domain in the setup portal first: your identity provider can only sign ' +
                'in addresses at a verified domain, so until then nobody but owners could sign in.',
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
        // The row under the lock was not the row the gates saw — only possible
        // if the link vanished in between, which nothing here can do. Answered
        // in the ordinary envelope, with the repository's fixed sentence.
        for (const action of switchingOn) record(orgAudit.error(action, resource, 'conflict'));
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

    const nonSsoAccess: NonSsoAccessPayload | null = after.ssoRequired
      ? await countNonSsoAccess(services.db, {
          orgId: after.id,
          workosOrgId: after.workosOrgId,
        })
      : null;

    return json({
      sso: await ssoStatus(services, after, scope.entitlements.addons.samlSso, () => provider),
      nonSsoAccess,
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

  requireThisWorkosEnvironment(current, provider.clientId, null, []);
  forgetWorkosLists(provider.clientId, current.workosOrgId);
  return json({
    sso: await ssoStatus(services, current, addon, () => provider),
  });
}
