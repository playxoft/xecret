import { createAuditBuilder } from '@xecret/core/audit';
import type { AuditBuilder, AuditResource } from '@xecret/core/audit';
import type { ServiceContext } from '../context';

/** Every billing record is about the organisation's subscription, by organisation id. */
export function subscriptionResource(orgId: string): AuditResource {
  // The row's primary key, never a provider identifier: those stay out of the
  // audit log entirely.
  return { type: 'subscription', id: orgId };
}

/**
 * The audit identity of a billing change nobody in the organisation made: a
 * `system` actor labelled by what it was — the payment webhook, the seat sync,
 * the billing job, the reconciler. No `operator`, which is what distinguishes
 * these from the operator tool's `plan.changed` (see `AuditMetadata.operator`).
 */
export function systemAudit(
  services: Pick<ServiceContext, 'meta'>,
  orgId: string,
  label: 'Dodo webhook' | 'seat sync' | 'billing job' | 'billing reconciler',
): AuditBuilder {
  return createAuditBuilder({
    orgId,
    actorType: 'system',
    actorId: null,
    actorLabel: label,
    ipAddress: services.meta.ipAddress,
    userAgent: services.meta.userAgent,
    requestId: services.meta.requestId,
  });
}
