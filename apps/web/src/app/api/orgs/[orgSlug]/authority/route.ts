import { grantableAccessLevel } from '@xecret/core/authz';
import { listEnvironmentsForOrganization } from '@xecret/db/repositories';
import { json } from '@/server/http';
import { requireMembership } from '@/server/members-service';
import { authenticatedRoute } from '@/server/route';
import { authorize, resolveOrg, toGrantContext } from '@/server/tenancy';

/**
 * What the caller may grant in this organisation: per environment, the highest
 * level they could grant there.
 *
 * The grant and invite dialogs draw their level controls from this, so a
 * segment the server would refuse (`grantWithinAuthority`) is never offered:
 * an admin whose custom role caps them at `none` on production sees no
 * production level to give, rather than three that each come back 403. Each
 * level is `grantableAccessLevel` for a grant on that one environment —
 * `resolveAccessLevel` on the caller, the enforcement path — so the dialog and
 * the refusal cannot disagree. The grants those dialogs write are always
 * per-environment; a project-wide grant, which also lands on the project's
 * future production environments, is measured more strictly by the server and
 * is not what this answers.
 *
 * The rest of the caller's authority — effective role, capabilities, the roles
 * they may hand out — is per organisation, not per environment, and already
 * arrives with the session (`GET /api/auth/me`), so it is not repeated here.
 *
 * `member.read`: the answer is the caller's own authority, which is theirs to
 * know. Like everything a client renders from, it decides which controls are
 * drawn, never what is permitted — the grant routes measure every write again.
 */

type Params = { orgSlug: string };

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const scope = await resolveOrg(principal, params.orgSlug, services);
  authorize(scope, 'member.read');
  const membership = requireMembership(scope);

  const environments = await listEnvironmentsForOrganization(services.db, scope.organization.id);
  const measured = toGrantContext(membership);

  return json({
    grantable: environments.map((environment) => ({
      projectSlug: environment.project.slug,
      environmentSlug: environment.slug,
      accessLevel: grantableAccessLevel(measured, {
        projectId: environment.project.id,
        environment: { id: environment.id, isProduction: environment.isProduction },
      }),
    })),
  });
});
