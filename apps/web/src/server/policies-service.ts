import {
  checkNameAgainstPolicy,
  checkValueAgainstPolicy,
  policyApplies,
} from '@xecret/core/policy';
import type { PolicyViolation, SecretPolicy } from '@xecret/core/policy';
import type {
  AuditAction,
  AuditBuilder,
  AuditMetadata,
  AuditRecord,
  AuditResource,
} from '@xecret/core/audit';
import type { Entitlements } from '@xecret/core/entitlements';
import { loadOrgPolicies } from '@xecret/db/repositories';
import type { OrgPolicies } from '@xecret/db/repositories';
import type { ServiceContext } from './context';
import { featureStatus } from './entitlements';
import { errors } from './errors';
import type { OrgPoliciesPayload } from './schemas/policies';
import type { EnvironmentScope } from './tenancy';

/**
 * The organisation's policies, applied (P19 §6 and §8).
 *
 * ── Enforcement never asks the plan ──
 * The plan decides who may *turn a policy on or tighten it*; once on, it is
 * enforced whatever the plan says next. A policy is a security control the
 * customer chose, and "never remove a security control someone already relies on
 * because they downgraded" (P19 §6) is the rule for all of them, not only the
 * token one. Loosening or switching one off is always allowed.
 *
 * ── The secret policy, and where each half of it runs ──
 * The **name** rule runs here, on every write that introduces a name: a create,
 * a rename, an import, a promotion. The server sees names, so the server can
 * hold every client to it.
 *
 * The **value** rules — entropy and forbidden words — need the plaintext, which
 * the server has only for a `server`-mode environment. There it enforces them
 * too. For an end-to-end encrypted environment they run in the clients that do
 * the encrypting (the dashboard and `xecret secrets set`), before encryption,
 * from the same fixtures; a modified client can skip them, and the docs say so
 * rather than claiming a guarantee the architecture cannot give.
 *
 * Neither rule ever blocks a read, a restore or a rollback: a policy adopted
 * today is not a reason to make yesterday's value unreachable. Existing names and
 * values that break it are reported, as warnings, by the dashboard.
 */

export function toOrgPoliciesPayload(
  entitlements: Entitlements,
  policies: OrgPolicies,
): OrgPoliciesPayload {
  return {
    tokens: policies.tokens,
    secrets: policies.secrets,
    features: {
      tokenIpAllowlist: featureStatus(entitlements, 'tokenIpAllowlist'),
      secretPolicy: featureStatus(entitlements, 'secretPolicy'),
      disableEnvExport: featureStatus(entitlements, 'disableEnvExport'),
      newIpReadAlerts: featureStatus(entitlements, 'newIpReadAlerts'),
    },
    updatedAt: policies.updatedAt?.toISOString() ?? null,
  };
}

/**
 * Whether storing `next` in place of `current` needs the `secretPolicy` feature:
 * any change that leaves the policy switched on. Switching it off, or editing a
 * policy that stays off, does not.
 */
export function secretPolicyChangeNeedsPlan(current: SecretPolicy, next: SecretPolicy): boolean {
  if (!next.enabled) return false;
  return !current.enabled || !sameSecretPolicy(current, next);
}

function sameSecretPolicy(a: SecretPolicy, b: SecretPolicy): boolean {
  return (
    a.enabled === b.enabled &&
    a.scope === b.scope &&
    a.namePattern === b.namePattern &&
    a.minValueEntropyBits === b.minValueEntropyBits &&
    sameList(a.entropyAppliesTo, b.entropyAppliesTo) &&
    sameList(a.forbiddenSubstrings, b.forbiddenSubstrings)
  );
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/** One secret a write introduces or replaces, and its plaintext when the server has one. */
export interface PolicyCheckedWrite {
  name: string;
  /** Whether the write introduces this name — a create, a rename, an import of a new key. */
  newName: boolean;
  /** `server` mode only. An e2ee write never has one, and its value rules ran in the client. */
  value?: string | undefined;
}

/**
 * Refuses a write the organisation's secret policy forbids, with every broken
 * rule as a field error. Reads the policy only when there is something to check
 * it against; an organisation without one pays a single primary-key read.
 *
 * `refused` runs before the throw, for the audit record of the attempt.
 */
export async function enforceSecretPolicy(
  scope: EnvironmentScope,
  services: ServiceContext,
  writes: readonly PolicyCheckedWrite[],
  refused?: (names: readonly string[]) => void,
): Promise<void> {
  const checked = writes.filter((write) => write.newName || write.value !== undefined);
  if (checked.length === 0) return;

  const { secrets: policy } = await loadOrgPolicies(services.db, scope.organization.id);
  if (!policyApplies(policy, scope.environment.isProduction)) return;

  const problems: { field: string; message: string }[] = [];
  const offending: string[] = [];
  for (const write of checked) {
    const violations: PolicyViolation[] = [
      ...(write.newName
        ? checkNameAgainstPolicy(policy, write.name, scope.environment.isProduction)
        : []),
      ...(write.value === undefined
        ? []
        : checkValueAgainstPolicy(policy, write.name, write.value, scope.environment.isProduction)),
    ];
    if (violations.length === 0) continue;
    offending.push(write.name);
    for (const violation of violations) {
      problems.push({
        field:
          checked.length === 1 ? (violation.rule === 'namePattern' ? 'name' : 'value') : write.name,
        message: checked.length === 1 ? violation.message : `${write.name}: ${violation.message}`,
      });
    }
  }

  if (problems.length === 0) return;
  refused?.(offending);
  throw errors.validation(problems);
}

/**
 * The audit record of a secret-policy refusal: an `error` of `policyRefused`
 * naming the policy and the first name that broke it. The rule and the value
 * are not recorded — the rule is in the response, and the value is never.
 */
export function secretPolicyRefusal(
  record: (...events: AuditRecord[]) => void,
  builder: AuditBuilder,
  action: AuditAction,
  resource: AuditResource | null,
  metadata: Omit<AuditMetadata, 'reason' | 'policyName' | 'secretName'> = {},
): (names: readonly string[]) => void {
  return (names) =>
    record(
      builder.error(action, resource, 'policyRefused', {
        ...metadata,
        policyName: 'secrets',
        ...(names[0] === undefined ? {} : { secretName: names[0] }),
      }),
    );
}
