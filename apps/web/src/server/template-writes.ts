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
  assertTemplateWrite,
  assertTokenReach,
  declareReferences,
  reachesOutside,
} from './references-service';
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
 *    reference must name an environment the writer may read, one reaching outside
 *    this environment must not strand a CI token pinned here, and the graph as it
 *    would be after the write must still resolve in every view it reaches.
 *
 * Returns what to store beside the ciphertext: the resolved declaration, or
 * `null`.
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
  await assertTemplateWrite(scope, services, {
    name: params.name,
    secretId: params.secretId,
    references: declared,
  });
  return declared;
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
