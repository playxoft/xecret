import { auditingDenials } from '@xecret/core/authz';
import type { Denial } from '@xecret/core/authz';
import { RepositoryError, updateEnvironmentPolicy } from '@xecret/db/repositories';
import { actorId } from '@/server/actor';
import { requireFeature } from '@/server/entitlements';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { parentSlugOf } from '@/server/references-service';
import { authenticatedRoute } from '@/server/route';
import { environmentPolicySchema } from '@/server/schemas/policies';
import { readAlertsActive, toEnvironment } from '@/server/schemas/resources';
import { planRefusal } from '@/server/template-writes';
import { authorize, resolveEnvironmentPath } from '@/server/tenancy';

/**
 * An environment's two policy switches: whether its values may be exported in
 * plaintext (P19 §9) and whether a read from a new address alerts the
 * organisation's administrators (P19 §7).
 *
 * `PATCH {"plaintextExport": "disabled"}`, `PATCH {"readAlerts": false}` — each
 * field optional, each absent one left alone, `readAlerts: null` back to the
 * default (on for production, off elsewhere).
 *
 * ── Who may ──
 * `environment.update`: the same administrative act as renaming the environment
 * or reclassifying it as production. "An owner or admin can change it" is what
 * every refusal the export policy produces says, and this is where.
 *
 * ── The plan ──
 * Switching export off needs `disableEnvExport` (Team); switching alerts on
 * where they would otherwise be off needs `newIpReadAlerts` (Pro). Undoing
 * either never does, and a downgrade leaves the export switch enforced — it is a
 * control the customer chose. Alerts, by contrast, are a service we deliver, and
 * stop being delivered when the plan no longer includes them: the switch is kept,
 * and starts working again on an upgrade.
 */

type Params = { orgSlug: string; projectSlug: string; envSlug: string };

export const PATCH = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([actorId(principal)]));

    const scope = await resolveEnvironmentPath(principal, params, services);
    const orgId = scope.organization.id;
    const builder = audit(orgId);
    const resource = {
      type: 'environment' as const,
      id: scope.environment.id,
      projectId: scope.project.id,
      environmentId: scope.environment.id,
    };
    const context = { projectSlug: scope.project.slug, environmentSlug: scope.environment.slug };

    auditingDenials(
      (decision: Denial) =>
        record(builder.denied('environment.policy_changed', resource, decision)),
      () => authorize(scope, 'environment.update'),
    );

    const body = await parseJsonBody(request, environmentPolicySchema);
    if (body.plaintextExport === undefined && body.readAlerts === undefined) {
      throw errors.validation([
        { field: 'plaintextExport', message: 'Send plaintextExport, readAlerts, or both.' },
      ]);
    }

    const disablingExport =
      body.plaintextExport === 'disabled' && !scope.environment.plaintextExportDisabled;
    if (disablingExport) {
      requireFeature(
        scope.entitlements,
        'disableEnvExport',
        planRefusal(
          record,
          builder,
          'environment.policy_changed',
          resource,
          'disableEnvExport',
          scope.entitlements.plan,
          {
            ...context,
            policyName: 'plaintextExport',
          },
        ),
      );
    }

    const alertsAfter =
      body.readAlerts === undefined
        ? readAlertsActive(scope.environment)
        : readAlertsActive({
            readAlerts: body.readAlerts,
            isProduction: scope.environment.isProduction,
          });
    if (alertsAfter && !readAlertsActive(scope.environment)) {
      requireFeature(
        scope.entitlements,
        'newIpReadAlerts',
        planRefusal(
          record,
          builder,
          'environment.policy_changed',
          resource,
          'newIpReadAlerts',
          scope.entitlements.plan,
          {
            ...context,
            policyName: 'readAlerts',
          },
        ),
      );
    }

    const exportChanged =
      body.plaintextExport !== undefined &&
      (body.plaintextExport === 'disabled') !== scope.environment.plaintextExportDisabled;
    const alertsChanged =
      body.readAlerts !== undefined && body.readAlerts !== scope.environment.readAlerts;

    let environment = scope.environment;
    if (exportChanged || alertsChanged) {
      environment = await updateEnvironmentPolicy(services.db, orgId, scope.environment.id, {
        ...(exportChanged ? { plaintextExportDisabled: body.plaintextExport === 'disabled' } : {}),
        ...(alertsChanged ? { readAlerts: body.readAlerts } : {}),
      }).catch((cause: unknown) => {
        if (cause instanceof RepositoryError && cause.code === 'notFound') {
          throw errors.notFound('environment deleted concurrently');
        }
        throw cause;
      });
    }

    if (exportChanged) {
      record(
        builder.success('environment.policy_changed', resource, {
          ...context,
          policyName: 'plaintextExport',
        }),
      );
    }
    if (alertsChanged) {
      record(
        builder.success('environment.policy_changed', resource, {
          ...context,
          policyName: 'readAlerts',
        }),
      );
    }

    return json({
      environment: toEnvironment(environment, await parentSlugOf(services, orgId, environment)),
    });
  },
);
