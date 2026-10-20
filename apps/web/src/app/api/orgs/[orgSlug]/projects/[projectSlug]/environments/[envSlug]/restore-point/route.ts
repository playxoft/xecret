import { auditingDenials } from '@xecret/core/authz';
import type { Denial } from '@xecret/core/authz';
import { fromBase64Url } from '@xecret/core/crypto';
import type { Principal } from '@/server/actor';
import { requireFeature } from '@/server/entitlements';
import {
  assertDistinctNames,
  countResults,
  perSecretRecords,
  toChangeWrites,
} from '@/server/environment-changes';
import { errors } from '@/server/errors';
import { json, parseJsonBody, parseQuery } from '@/server/http';
import { assertEnvironmentChanges } from '@/server/references-service';
import {
  assertWithinWindow,
  matchesInstant,
  planRestore,
  toRestorePlanPayload,
} from '@/server/restore-point';
import type { RestoreItem } from '@/server/restore-point';
import { authenticatedRoute } from '@/server/route';
import { restorePointBody, restorePointQuery } from '@/server/schemas/secrets';
import {
  applyClientSecretWrites,
  auditSource,
  enforceSecretRateLimit,
  secretWriter,
} from '@/server/secrets-service';
import { planRefusal } from '@/server/template-writes';
import { authorize, resolveEnvironmentPath } from '@/server/tenancy';
import type { EnvironmentScope } from '@/server/tenancy';

/**
 * Point-in-time restore (P19 §4): `GET …/restore-point?at=` is the preview —
 * always first — and `POST …/restore-point` applies it. `restore-point.ts` says
 * what "the environment at that instant" means and why the restore only ever
 * writes forward.
 *
 * ── Who may ──
 * A person — a restore is a reviewed change, and a service token can neither
 * review one nor read the history it would need — holding `secret.read` for the
 * preview, and `secret.create`, `secret.update` and `secret.delete` to apply it:
 * a restore can do all three.
 *
 * ── The plan ──
 * `pointInTimeRestore`, and an instant no older than `plans.pitrDays`; past the
 * window the refusal names the plan whose window would reach it. Both are asked
 * of the preview as well as the apply, because the preview serves history.
 *
 * ── Both halves are audited ──
 * The preview serves every historical ciphertext the restore needs, which is a
 * read of the environment as it was — recorded as `secret.read` with the count,
 * exactly as a pull is. The apply records one `environment.restored` with the
 * instant and the counts, and one record per secret written, revived or removed.
 */

type Params = { orgSlug: string; projectSlug: string; envSlug: string };

function personOnly(principal: Principal): void {
  if (principal.kind === 'serviceToken') {
    throw errors.forbidden(
      'A point-in-time restore is a reviewed change made by a person. A service token cannot make one.',
    );
  }
}

function e2eeOnly(scope: EnvironmentScope): void {
  if (scope.environment.encryptionMode !== 'e2ee') {
    throw errors.conflict(
      'e2ee_required: point-in-time restore needs an end-to-end encrypted environment.',
    );
  }
}

function environmentResource(scope: EnvironmentScope) {
  return {
    type: 'environment' as const,
    id: scope.environment.id,
    projectId: scope.project.id,
    environmentId: scope.environment.id,
  };
}

export const GET = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    const builder = audit(scope.organization.id);
    const resource = environmentResource(scope);
    personOnly(principal);
    auditingDenials(
      (decision: Denial) => record(builder.denied('environment.restored', resource, decision)),
      () => authorize(scope, 'secret.read'),
    );
    await enforceSecretRateLimit(services, principal, 'read');
    e2eeOnly(scope);

    const { at: raw } = parseQuery(request, restorePointQuery);
    const at = new Date(raw);
    const context = {
      projectSlug: scope.project.slug,
      environmentSlug: scope.environment.slug,
      restoredTo: at.toISOString(),
    };
    requireFeature(
      scope.entitlements,
      'pointInTimeRestore',
      planRefusal(
        record,
        builder,
        'environment.restored',
        resource,
        'pointInTimeRestore',
        scope.entitlements.plan,
        context,
      ),
    );
    const now = new Date();
    assertWithinWindow(scope, at, now);

    const plan = await planRestore(scope, services, principal, at);
    const served = plan.items.filter((item) => item.from !== null).length;
    record(
      builder.success('secret.read', resource, {
        ...context,
        secretCount: served,
        reason: 'restore-preview',
        source: auditSource(principal),
      }),
    );

    return json({ plan: toRestorePlanPayload(plan, scope, now) });
  },
);

export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    const builder = audit(scope.organization.id);
    const resource = environmentResource(scope);
    personOnly(principal);
    auditingDenials(
      (decision: Denial) => record(builder.denied('environment.restored', resource, decision)),
      () => {
        authorize(scope, 'secret.create');
        authorize(scope, 'secret.update');
        authorize(scope, 'secret.delete');
      },
    );
    await enforceSecretRateLimit(services, principal, 'write');
    e2eeOnly(scope);

    const body = await parseJsonBody(request, restorePointBody);
    const at = new Date(body.at);
    const context = {
      projectSlug: scope.project.slug,
      environmentSlug: scope.environment.slug,
      restoredTo: at.toISOString(),
    };
    requireFeature(
      scope.entitlements,
      'pointInTimeRestore',
      planRefusal(
        record,
        builder,
        'environment.restored',
        resource,
        'pointInTimeRestore',
        scope.entitlements.plan,
        context,
      ),
    );
    assertWithinWindow(scope, at, new Date());
    assertDistinctNames(body.writes);

    // The plan is decided again, here, from the database — never taken from the
    // client. What the client contributes is ciphertext, and each entry is held
    // to the plan's item for its name.
    const plan = await planRestore(scope, services, principal, at);
    const byName = new Map(plan.items.map((item) => [item.name, item]));
    const owed = plan.items.filter((item) => item.expectedVersion !== null && item.available);

    for (const entry of body.writes) {
      const item = byName.get(entry.name);
      if (item === undefined || item.expectedVersion === null || !item.available) {
        throw errors.validation([
          {
            field: entry.name,
            message: `The restore to this point writes nothing to ${entry.name}.`,
          },
        ]);
      }
      // An update lands on today's row, at the version after its current one; a
      // re-creation is a new row, version 1, under an id the client chose.
      const misplaced =
        item.action === 'recreate'
          ? entry.expectedVersion !== 1
          : entry.id !== item.secretId || entry.expectedVersion !== item.expectedVersion;
      if (misplaced) {
        throw errors.conflict(
          `version_conflict: ${entry.name} changed since the preview. Preview the restore again.`,
        );
      }
      if (!matchesInstant(item, fromBase64Url(entry.value.valueHmac))) {
        throw errors.validation([
          {
            field: entry.name,
            message: `The value sent for ${entry.name} is not its value at this point. Preview the restore again.`,
          },
        ]);
      }
    }
    const sent = new Set(body.writes.map((entry) => entry.name));
    const missing = owed.filter((item) => !sent.has(item.name)).map((item) => item.name);
    if (missing.length > 0) {
      throw errors.validation([
        {
          field: 'writes',
          message: `A restore writes every value it changes; missing: ${missing.join(', ')}.`,
        },
      ]);
    }

    const writes = await toChangeWrites(scope, services, principal, body.writes, {
      existing: (name) => byName.get(name)?.existing,
      typeOf: (entry) => byName.get(entry.name)?.valueType ?? 'string',
      refused: (entry) =>
        planRefusal(
          record,
          builder,
          'environment.restored',
          resource,
          'secretReferencing',
          scope.entitlements.plan,
          { ...context, secretName: entry.name },
        ),
    });

    const removed = plan.items.flatMap((item) =>
      item.action === 'delete' && item.secretId !== null
        ? [{ secretId: item.secretId, name: item.name }]
        : [],
    );
    const skipped = plan.items.filter((item) => !item.available);

    await assertEnvironmentChanges(scope, services, {
      set: writes.map((write) => ({
        name: write.name,
        secretId: write.existing?.secretId ?? write.secretId,
        references: write.declaredReferences ?? null,
      })),
      remove: removed.map((item) => item.name),
    });

    const results = await applyClientSecretWrites(scope, services, {
      writer: secretWriter(principal),
      writes,
      removals: removed.map((item) => item.secretId),
      dryRun: body.dryRun,
    });
    const counts = countResults(results, removed.length);

    if (!body.dryRun) {
      record(
        builder.success('environment.restored', resource, {
          ...context,
          createdCount: counts.created,
          updatedCount: counts.updated,
          deletedCount: counts.deleted,
          source: auditSource(principal),
        }),
        ...perSecretRecords(builder, scope, results, removed, {
          reason: 'restored',
          restoredTo: at.toISOString(),
          source: auditSource(principal),
        }),
      );
    }

    return json({
      dryRun: body.dryRun,
      at: at.toISOString(),
      counts: {
        updated: counts.updated,
        recreated: counts.created,
        deleted: counts.deleted,
        unchanged:
          plan.items.filter((item) => item.action === 'unchanged').length + counts.unchanged,
      },
      items: plan.items.map((item: RestoreItem) => ({
        name: item.name,
        action: item.action,
        applied: item.available,
      })),
      skipped: skipped.map((item) => item.name),
    });
  },
);
