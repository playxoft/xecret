import type { AuditBuilder, AuditMetadata, AuditRecord } from '@xecret/core/audit';
import type { SecretReference } from '@xecret/core/references';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { errors } from './errors';
import type {
  ClientSecretValue,
  ClientSecretWrite,
  ExistingSecret,
  SecretWriteResult,
} from './secrets-service';
import { prepareTemplateDeclaration } from './template-writes';
import type { EnvironmentScope } from './tenancy';

/**
 * What a promotion and a point-in-time restore have in common (P19 §3, §4): many
 * client-encrypted values written into one environment at once, atomically, with
 * the templates among them declared and checked together.
 *
 * The routes decide *which* values — a promotion from another environment's
 * current state, a restore from this environment's own past — and this module
 * turns the client's re-encrypted entries into writes the ordinary write path
 * commits, in one transaction, with the same version and key checks as any
 * other write. Neither feature is a back door around them.
 */

/** One entry as it arrives: see `changeEntrySchema` in `schemas/secrets.ts`. */
export interface ChangeEntry {
  id: string;
  name: string;
  expectedVersion: number;
  value: ClientSecretValue;
  valueType?: string | undefined;
  references?: readonly SecretReference[] | undefined;
}

/** Refuses a body naming one secret twice — by name, before anything is read. */
export function assertDistinctNames(
  entries: readonly { name: string }[],
  also: readonly string[] = [],
): void {
  const seen = new Set<string>();
  for (const name of [...entries.map((entry) => entry.name), ...also]) {
    if (seen.has(name)) {
      throw errors.badRequest(
        `This change names "${name}" more than once. Each secret may appear once.`,
      );
    }
    seen.add(name);
  }
}

/**
 * The client's entries as writes: each matched to the row it lands on, its type
 * decided, and — for a template — its references declared and checked for reach
 * (the graph itself is checked once, for the whole batch, by the caller).
 */
export async function toChangeWrites(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
  entries: readonly ChangeEntry[],
  options: {
    /** The row each entry appends to, by name — absent for a create. */
    existing: (name: string) => ExistingSecret | undefined;
    /** The type the secret holds after the write. */
    typeOf: (entry: ChangeEntry) => string;
    /** Records the plan refusal when a template needs `secretReferencing`. */
    refused: (entry: ChangeEntry) => () => void;
  },
): Promise<ClientSecretWrite[]> {
  const writes: ClientSecretWrite[] = [];
  for (const entry of entries) {
    const existing = options.existing(entry.name);
    const valueType = options.typeOf(entry);
    const declaredReferences = await prepareTemplateDeclaration(scope, services, principal, {
      name: entry.name,
      secretId: existing?.secretId ?? entry.id,
      effectiveType: valueType,
      requested: entry.references,
      refused: options.refused(entry),
      batched: true,
    });
    writes.push({
      name: entry.name,
      secretId: entry.id,
      expectedVersion: entry.expectedVersion,
      value: entry.value,
      valueType,
      declaredReferences,
      ...(existing === undefined ? {} : { existing }),
    });
  }
  return writes;
}

/** The counts an `environment.promoted` / `environment.restored` record carries. */
export interface ChangeCounts {
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
}

export function countResults(results: readonly SecretWriteResult[], deleted: number): ChangeCounts {
  const counts: ChangeCounts = { created: 0, updated: 0, unchanged: 0, deleted };
  for (const result of results) counts[result.status] += 1;
  return counts;
}

/**
 * The per-secret records under one change — "plus the underlying per-secret
 * versions" (P19 §3) — so a secret's own history shows that a promotion or a
 * restore wrote it, not only the environment's.
 */
export function perSecretRecords(
  builder: AuditBuilder,
  scope: EnvironmentScope,
  results: readonly SecretWriteResult[],
  removed: readonly { secretId: string; name: string }[],
  metadata: Pick<AuditMetadata, 'reason' | 'sourceEnvironmentSlug' | 'restoredTo' | 'source'>,
): AuditRecord[] {
  const resource = (id: string) => ({
    type: 'secret' as const,
    id,
    projectId: scope.project.id,
    environmentId: scope.environment.id,
  });
  const base = {
    projectSlug: scope.project.slug,
    environmentSlug: scope.environment.slug,
    ...metadata,
  };
  return [
    ...results
      .filter((result) => result.status !== 'unchanged')
      .map((result) =>
        builder.success(
          result.status === 'created' ? 'secret.created' : 'secret.updated',
          resource(result.secretId),
          { ...base, secretName: result.name },
        ),
      ),
    ...removed.map((secret) =>
      builder.success('secret.deleted', resource(secret.secretId), {
        ...base,
        secretName: secret.name,
      }),
    ),
  ];
}
