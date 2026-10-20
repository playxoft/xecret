import { auditingDenials } from '@xecret/core/authz';
import type { Denial } from '@xecret/core/authz';
import { loadEnvironmentSecrets } from '@xecret/db/repositories';
import type { SecretMaterial } from '@xecret/db/repositories';
import { batchChanges, emitEnvironmentChange } from '@/server/change-events';
import { requireFeature } from '@/server/entitlements';
import {
  assertDistinctNames,
  countResults,
  perSecretRecords,
  toChangeWrites,
} from '@/server/environment-changes';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { enforceSecretPolicy, secretPolicyRefusal } from '@/server/policies-service';
import { assertEnvironmentChanges } from '@/server/references-service';
import { authenticatedRoute } from '@/server/route';
import { promoteClientBody } from '@/server/schemas/secrets';
import {
  applyClientSecretWrites,
  auditSource,
  enforceSecretRateLimit,
  secretWriter,
} from '@/server/secrets-service';
import { planRefusal } from '@/server/template-writes';
import { authorize, resolveEnvironment, resolveEnvironmentPath } from '@/server/tenancy';

/**
 * Promoting one environment's values into another (P19 §3, `environmentPromotion`):
 * `POST …/environments/{target}/promote` with the source's slug, the values to
 * write and the names to remove.
 *
 * ── Who builds the diff ──
 * The client. Both environments are end-to-end encrypted, so the server can read
 * neither value and could not tell "changed" from "unchanged" even if it tried —
 * each environment's value tags are keyed by its own HMAC key. The dashboard
 * reads both, shows added / changed / removed with every value masked until
 * asked, and re-encrypts each value it promotes under the target's key, for the
 * target's row and version. A `dryRun` runs every check below and writes nothing,
 * so the preview is the promotion's own decision rather than a second opinion.
 *
 * ── What the server holds the client to ──
 *  - a person, never a token: a promotion is a reviewed change, and a service
 *    token is pinned to one environment and could not read the source anyway;
 *  - `secret.read` on the source, `secret.create` and `secret.update` on the
 *    target, and `secret.delete` there if anything is removed — "a normal write,
 *    subject to grants";
 *  - every written name is one the source holds, with the source's type, and
 *    every removed name is one the target holds and the source does not;
 *  - the target's secret policy for every name the promotion introduces, and the
 *    whole batch's templates checked together, so the promotion cannot leave a
 *    reference dangling;
 *  - **one transaction**: every value lands, and every removal, or none does.
 *
 * ── What it records ──
 * One `environment.promoted` with the counts, and one record per secret written
 * or removed, so each secret's own history shows the promotion too.
 *
 * Change approvals (P18) do not exist yet; when they do, a promotion into an
 * environment that requires them is the first thing they gate.
 */

type Params = { orgSlug: string; projectSlug: string; envSlug: string };

export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const target = await resolveEnvironmentPath(principal, params, services);
    const orgId = target.organization.id;
    const builder = audit(orgId);
    const resource = {
      type: 'environment' as const,
      id: target.environment.id,
      projectId: target.project.id,
      environmentId: target.environment.id,
    };
    const denied = (decision: Denial) =>
      record(builder.denied('environment.promoted', resource, decision));

    if (principal.kind === 'serviceToken') {
      throw errors.forbidden(
        'A promotion is a reviewed change made by a person. A service token cannot promote.',
      );
    }
    auditingDenials(denied, () => {
      authorize(target, 'secret.create');
      authorize(target, 'secret.update');
    });
    await enforceSecretRateLimit(services, principal, 'write');

    const body = await parseJsonBody(request, promoteClientBody);
    if (body.removals.length > 0) {
      auditingDenials(denied, () => authorize(target, 'secret.delete'));
    }
    assertDistinctNames(body.writes, body.removals);

    const source = await resolveEnvironment(target, body.source, services);
    auditingDenials(denied, () => authorize(source, 'secret.read'));

    if (source.environment.id === target.environment.id) {
      throw errors.validation([
        { field: 'source', message: 'An environment cannot be promoted into itself.' },
      ]);
    }
    if (
      source.environment.encryptionMode !== 'e2ee' ||
      target.environment.encryptionMode !== 'e2ee'
    ) {
      throw errors.conflict(
        'e2ee_required: promotion needs both environments to be end-to-end encrypted.',
      );
    }

    const context = {
      projectSlug: target.project.slug,
      environmentSlug: target.environment.slug,
      sourceEnvironmentSlug: source.environment.slug,
    };
    requireFeature(
      target.entitlements,
      'environmentPromotion',
      planRefusal(
        record,
        builder,
        'environment.promoted',
        resource,
        'environmentPromotion',
        target.entitlements.plan,
        context,
      ),
    );

    const sourceSecrets = byName(
      await loadEnvironmentSecrets(services.db, orgId, source.environment.id),
    );
    const targetSecrets = byName(
      await loadEnvironmentSecrets(services.db, orgId, target.environment.id),
    );

    for (const write of body.writes) {
      const from = sourceSecrets.get(write.name);
      if (from === undefined) {
        throw errors.validation([
          {
            field: write.name,
            message: `${source.environment.slug} holds no secret named ${write.name}.`,
          },
        ]);
      }
      if (write.valueType !== undefined && write.valueType !== from.valueType) {
        throw errors.validation([
          {
            field: write.name,
            message: `A promotion keeps ${write.name}'s type, ${from.valueType}.`,
          },
        ]);
      }
    }
    const removed = body.removals.map((name) => {
      const secret = targetSecrets.get(name);
      if (secret === undefined || sourceSecrets.has(name)) {
        throw errors.validation([
          {
            field: name,
            message: `Only a secret ${target.environment.slug} holds and ${source.environment.slug} does not can be removed by a promotion.`,
          },
        ]);
      }
      return { secretId: secret.secretId, name };
    });

    const writes = await toChangeWrites(target, services, principal, body.writes, {
      existing: (name) => {
        const current = targetSecrets.get(name);
        return current === undefined
          ? undefined
          : {
              secretId: current.secretId,
              version: current.version,
              valueHmac: current.valueHmac,
              valueType: current.valueType,
              declaredReferences: current.declaredReferences,
            };
      },
      typeOf: (entry) => sourceSecrets.get(entry.name)?.valueType ?? 'string',
      refused: (entry) =>
        planRefusal(
          record,
          builder,
          'environment.promoted',
          resource,
          'secretReferencing',
          target.entitlements.plan,
          { ...context, secretName: entry.name },
        ),
    });

    await assertEnvironmentChanges(target, services, {
      set: writes.map((write) => ({
        name: write.name,
        secretId: write.existing?.secretId ?? write.secretId,
        references: write.declaredReferences ?? null,
      })),
      remove: body.removals,
    });

    await enforceSecretPolicy(
      target,
      services,
      writes.map((write) => ({ name: write.name, newName: write.existing === undefined })),
      body.dryRun
        ? undefined
        : secretPolicyRefusal(record, builder, 'environment.promoted', resource, context),
    );

    const results = await applyClientSecretWrites(target, services, {
      writer: secretWriter(principal),
      writes,
      removals: removed.map((secret) => secret.secretId),
      dryRun: body.dryRun,
    });
    const counts = countResults(results, removed.length);

    if (!body.dryRun) {
      record(
        builder.success('environment.promoted', resource, {
          ...context,
          createdCount: counts.created,
          updatedCount: counts.updated,
          deletedCount: counts.deleted,
          source: auditSource(principal),
        }),
        ...perSecretRecords(builder, target, results, removed, {
          reason: 'promoted',
          sourceEnvironmentSlug: source.environment.slug,
          source: auditSource(principal),
        }),
      );
      emitEnvironmentChange(
        services,
        target,
        principal,
        {
          type: 'environment.promoted',
          source: { id: source.environment.id, slug: source.environment.slug },
          counts,
        },
        batchChanges(results, removed),
      );
    }

    return json({
      dryRun: body.dryRun,
      source: source.environment.slug,
      counts,
      items: [
        ...results.map((result) => ({ name: result.name, status: result.status })),
        ...removed.map((secret) => ({ name: secret.name, status: 'deleted' as const })),
      ],
    });
  },
);

function byName(materials: readonly SecretMaterial[]): Map<string, SecretMaterial> {
  return new Map(materials.map((material) => [material.name, material]));
}
