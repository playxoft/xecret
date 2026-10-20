import type {
  AuditAction,
  AuditBuilder,
  AuditMetadata,
  AuditRecord,
  AuditResource,
} from '@xecret/core/audit';
import type { DeclaredReference, SecretReference } from '@xecret/core/references';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { requireFeature } from './entitlements';
import { errors } from './errors';
import {
  assertTokenReach,
  crossingRefusal,
  declareReferences,
  graphWriteGuard,
  reachesOutside,
  referenceCrossings,
} from './references-service';
import type { GraphGuard, ProtectionCrossing } from './references-service';
import type { EnvironmentScope } from './tenancy';

/**
 * The one decision every client-encrypted write makes about templates (P19 §1),
 * in one place so the create, update, restore, promotion and point-in-time
 * routes cannot disagree about it.
 *
 *  - **Not a template** → no declaration, and a request that sent one anyway is
 *    refused: references on a value that will be read as literal text are a
 *    client bug that would otherwise pass silently.
 *  - **A template** → the plan must include `secretReferencing` (the write is the
 *    control plane; *reading* an existing template never asks), the request must
 *    carry the declaration — an older client that sends none is told to upgrade
 *    rather than allowed to store a template that declares nothing — every
 *    reference must name an environment the writer may read, and one reaching
 *    outside this environment must not strand a CI token pinned here.
 *
 * Returns what to store beside the ciphertext: the resolved declaration, or
 * `null`. Whether the graph as it would be after the write still resolves in
 * every view it reaches is *not* asked here: that check reads the graph, so it
 * runs inside the write's transaction, under the graph lock — `templateGuard`
 * for one write, `graphWriteGuard` with `changes` for a batch.
 */
export async function prepareTemplateDeclaration(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
  params: {
    name: string;
    secretId: string;
    /** The type the secret will hold after the write — requested, else stored, else `string`. */
    effectiveType: string;
    requested: readonly SecretReference[] | undefined;
    /** Records the refusal when the plan does not include the feature. See `planRefusal`. */
    refused?: (() => void) | undefined;
    /**
     * What the version this write replaces declared, so a reference already
     * there is not asked about again. Absent for a create.
     */
    previous?: readonly DeclaredReference[] | null | undefined;
    /**
     * The request's `confirmCrossesProtection` — that it knows a production
     * template is being made to read from an environment that is not production.
     * Without it such a write is refused 409 `link_crosses_protection:`.
     */
    confirmCrossesProtection?: boolean | undefined;
    /**
     * Told the crossings a confirmed write makes, so the route can file
     * `environment.link_crosses_protection` once the write has landed.
     */
    onCrossing?: ((crossings: readonly ProtectionCrossing[]) => void) | undefined;
  },
): Promise<DeclaredReference[] | null> {
  if (params.effectiveType !== 'template') {
    if (params.requested !== undefined && params.requested.length > 0) {
      throw errors.validation([
        {
          field: 'references',
          message: 'Only a template declares references. Set its type to template, or send none.',
        },
      ]);
    }
    return null;
  }

  if (scope.environment.encryptionMode !== 'e2ee') {
    throw errors.conflict(
      'e2ee_required: templates and references need an end-to-end encrypted environment.',
    );
  }

  requireFeature(scope.entitlements, 'secretReferencing', params.refused);

  if (params.requested === undefined) {
    throw errors.validation([
      {
        field: 'references',
        message:
          `${params.name} is a template, so a write must declare its references. ` +
          'Upgrade the client that sent this, or change the type.',
      },
    ]);
  }

  const declared = await declareReferences(scope, services, principal, params.requested);
  if (reachesOutside(scope.environment.id, declared)) {
    await assertTokenReach(scope, services, 'reference');
  }

  // A production template newly reading from an environment that is not:
  // confirmed, or refused naming who could then change production's values.
  const crossings = await referenceCrossings(scope, services, declared, params.previous ?? null);
  if (crossings.length > 0) {
    if (params.confirmCrossesProtection !== true) {
      await crossingRefusal(scope, services, crossings);
    }
    params.onCrossing?.(crossings);
  }
  // The graph itself is checked by the write, inside its transaction and under
  // `lockReferenceGraph` — see `templateGuard` and `graphWriteGuard`.
  return declared;
}

/**
 * The graph check a single template write passes inside its transaction, or
 * `undefined` for a write that declares nothing (a value that is not a
 * template cannot add a reference, so it cannot make a loop or a dangling one).
 */
export function templateGuard(
  scope: EnvironmentScope,
  write: { name: string; secretId: string; declaredReferences: DeclaredReference[] | null },
): GraphGuard | undefined {
  if (write.declaredReferences === null) return undefined;
  return graphWriteGuard(scope, {
    kind: 'template',
    name: write.name,
    secretId: write.secretId,
    references: write.declaredReferences,
  });
}

/**
 * The `environment.link_crosses_protection` records of a confirmed template
 * write — one per environment it newly reads from — filed against the
 * production environment the template is in, naming the template.
 */
export function crossingRecords(
  builder: AuditBuilder,
  scope: EnvironmentScope,
  crossings: readonly { secretName: string; crossing: ProtectionCrossing }[],
): AuditRecord[] {
  return crossings.map(({ secretName, crossing }) =>
    builder.success(
      'environment.link_crosses_protection',
      {
        type: 'environment',
        id: scope.environment.id,
        projectId: scope.project.id,
        environmentId: scope.environment.id,
      },
      {
        projectSlug: scope.project.slug,
        environmentSlug: scope.environment.slug,
        sourceProjectSlug: crossing.source.projectSlug,
        sourceEnvironmentSlug: crossing.source.slug,
        secretName,
        reason: 'referenced',
      },
    ),
  );
}

/**
 * The audit record of a plan refusal, in the shape every gated route writes it:
 * an `error` of `quotaExceeded`, naming the feature and the plan. A customer
 * reaching for a feature their plan lacks is a support signal and an input to a
 * pricing decision, so the attempt is recorded, never only refused.
 */
export function planRefusal(
  record: (...events: AuditRecord[]) => void,
  builder: AuditBuilder,
  action: AuditAction,
  resource: AuditResource | null,
  feature: string,
  plan: string,
  metadata: Omit<AuditMetadata, 'reason' | 'limitName' | 'plan'> = {},
): () => void {
  return () =>
    record(
      builder.error(action, resource, 'quotaExceeded', { ...metadata, limitName: feature, plan }),
    );
}
