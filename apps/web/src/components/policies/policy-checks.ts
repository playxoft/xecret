import {
  checkNameAgainstPolicy,
  checkValueAgainstPolicy,
  DEFAULT_SECRET_POLICY,
  policyApplies,
} from '@xecret/core/policy';
import type { PolicyViolation, SecretPolicy } from '@xecret/core/policy';
import { ApiError } from '@/lib/api';
import type { FieldProblem } from '@/lib/api';

/**
 * The organisation's secret policy (P19 §8), as the dashboard applies it to its
 * own writes — and the warnings it puts beside secrets that predate the rule.
 *
 * ── Who enforces what, again ──
 * `@xecret/core/policy` says it at length: the server enforces the **name** rule
 * on every write that introduces a name, because names are plaintext, and the
 * **value** rules are enforced by whichever client holds the plaintext, because
 * the server never does. The dashboard is one of those clients. So every value
 * this screen encrypts is held to the value rules here, before encryption, and
 * a refusal never reaches the network; the name rule is asked here too, so the
 * person hears it while the name is under the cursor rather than as a 422.
 *
 * ── Enforced at write, warned on existing, never on a read ──
 * The write helpers below refuse. The warning helpers only describe: a policy
 * switched on today does not make yesterday's secrets unreadable, and a reveal
 * is never refused because of what it reveals. The next *write* of such a value
 * is held to the rule, which is the moment the plaintext is legitimately being
 * replaced anyway.
 *
 * ── Templates ──
 * A template's literal text is what the value rules read, without the entropy
 * rule — decided in `checkValueAgainstPolicy` itself, so this screen and the
 * CLI give the same answer (`policy-fixtures.json` pins it for both).
 *
 * Every message comes from `@xecret/core/policy`, which builds them from the
 * policy's own fields and never from the value — the forbidden-word rule does
 * not even say which word matched.
 */

/** One write, as the policy sees it. */
export interface PolicyWrite {
  name: string;
  /**
   * Whether this write introduces the name — a create, a rename, a key new to
   * the target of a promotion. Only then is the name rule asked: an existing
   * name was allowed when it was written, and refusing a rotation of it would
   * be the policy breaking the product.
   */
  newName: boolean;
  /** The plaintext about to be encrypted, or absent for a write that carries none. */
  value?: string | undefined;
  /** The type the value will hold, so a template is read as one. */
  valueType?: string | undefined;
  /** Whether the environment being written is production, for a `production`-scoped policy. */
  isProduction: boolean;
}

function valueViolations(
  policy: SecretPolicy,
  name: string,
  value: string,
  valueType: string | undefined,
  isProduction: boolean,
): PolicyViolation[] {
  return checkValueAgainstPolicy(policy, name, value, isProduction, valueType);
}

/* ── a policy this screen does not have ───────────────────────────────────── */

/**
 * Stand-ins for a policy this screen could not read, or has not yet (review
 * round 1, M5).
 *
 * ── Fail closed, like the CLI ──
 * The value rules exist nowhere but in the clients, so a client that writes a
 * value without having read them has skipped them — and this screen used to do
 * exactly that whenever `GET /policies` failed or had not landed, while the CLI
 * refused. Both now refuse: a write that carries a value, against either of
 * these, is refused with a sentence that says why. A write that carries none — a
 * rename, a note — goes ahead, because its only rule is the name rule and the
 * server asks that itself.
 *
 * Frozen, disabled policies rather than a wider type, so every helper that only
 * *describes* (`nameWarning`, `valueWarning`) reads them as "no rule" and says
 * nothing, and only the refusing path below needs to know.
 */
export const PENDING_SECRET_POLICY: SecretPolicy = Object.freeze({
  ...DEFAULT_SECRET_POLICY,
  enabled: false,
});
export const UNREADABLE_SECRET_POLICY: SecretPolicy = Object.freeze({
  ...DEFAULT_SECRET_POLICY,
  enabled: false,
});

/** Why a value cannot be saved against a policy this screen does not have. */
export const POLICY_PENDING_MESSAGE =
  'The organisation’s secret policy is still loading, so this value was not saved. Try again in a moment.';
export const POLICY_UNREADABLE_MESSAGE =
  'The organisation’s secret policy could not be read, so this value was not saved. Reload the page and try again.';

/**
 * The policy a screen applies, from its `GET /policies`: the organisation's
 * when it has landed, and otherwise the stand-in that says why not.
 */
export function secretPolicyFrom(resource: {
  data: { secrets: SecretPolicy } | null;
  error: unknown;
}): SecretPolicy {
  if (resource.data !== null) return resource.data.secrets;
  return resource.error === null || resource.error === undefined
    ? PENDING_SECRET_POLICY
    : UNREADABLE_SECRET_POLICY;
}

/** A broken rule, or the one refusal a missing policy produces. */
export type WriteViolation =
  PolicyViolation | { readonly rule: 'policyUnavailable'; readonly message: string };

/**
 * Every rule a write breaks, name first.
 *
 * `null` is "no policy applies" — a caller with nothing to enforce. A screen
 * that reads the organisation's passes `secretPolicyFrom(…)`, and the two
 * stand-ins it can hand back refuse a value outright; see above.
 */
export function policyViolations(
  policy: SecretPolicy | null,
  write: PolicyWrite,
): WriteViolation[] {
  if (policy === PENDING_SECRET_POLICY || policy === UNREADABLE_SECRET_POLICY) {
    if (write.value === undefined) return [];
    return [
      {
        rule: 'policyUnavailable',
        message:
          policy === PENDING_SECRET_POLICY ? POLICY_PENDING_MESSAGE : POLICY_UNREADABLE_MESSAGE,
      },
    ];
  }
  if (policy === null || !policyApplies(policy, write.isProduction)) return [];

  const violations: WriteViolation[] = [];
  if (write.newName) {
    violations.push(...checkNameAgainstPolicy(policy, write.name, write.isProduction));
  }
  if (write.value !== undefined) {
    violations.push(
      ...valueViolations(policy, write.name, write.value, write.valueType, write.isProduction),
    );
  }
  return violations;
}

/**
 * Why a write is refused, as one sentence for the row it belongs to — or `null`
 * when it may go ahead.
 *
 * Several broken rules are joined rather than reported first-only: fixing the
 * entropy and then being told about the forbidden word is two round trips for
 * one value.
 */
export function policyProblem(policy: SecretPolicy | null, write: PolicyWrite): string | null {
  const violations = policyViolations(policy, write);
  return violations.length === 0
    ? null
    : violations.map((violation) => violation.message).join(' ');
}

/**
 * A batch the policy refused before anything was encrypted, as the failure a
 * server validation would have produced — so the dialog that reports it needs
 * no second code path.
 *
 * ── Why an `ApiError` the server never sent ──
 * `errorMessage` collapses every non-`ApiError` to a fixed sentence, on purpose:
 * an arbitrary exception's message may have been built from a request body,
 * which on these paths is a credential. These messages are not that — each is
 * a policy sentence prefixed by the key it concerns — and they have to reach
 * the person, so they travel in the one shape the dashboard already trusts to
 * carry a field-by-field refusal. `status` is 0: no response was ever received,
 * which is also what `network_error` uses, and nothing branches on it.
 */
export function policyRefusal(problems: readonly FieldProblem[]): ApiError {
  return new ApiError({
    code: 'validation_failed',
    message: 'The organisation’s secret policy refused these values.',
    status: 0,
    requestId: null,
    fields: problems,
  });
}

/** Which field a broken rule belongs under, for a form that has both. */
export function violationField(violation: WriteViolation): 'name' | 'value' {
  return violation.rule === 'namePattern' ? 'name' : 'value';
}

/**
 * The warning beside an existing name the name rule would refuse today, or
 * `null`.
 *
 * Phrased as a fact about the past, not an instruction: the secret is fine to
 * read and to rotate, and only a rename or a fresh key would be held to it.
 */
export function nameWarning(
  policy: SecretPolicy | null,
  name: string,
  isProduction: boolean,
): string | null {
  if (policy === null) return null;
  const violations = checkNameAgainstPolicy(policy, name, isProduction);
  if (violations.length === 0) return null;
  return `This name predates the organisation’s naming rule (${policy.namePattern ?? ''}). It still works; a new secret or a rename would be held to the rule.`;
}

/**
 * The warning beside a revealed value the value rules would refuse today, or
 * `null`. Never blocks the read it is shown beside.
 */
export function valueWarning(
  policy: SecretPolicy | null,
  write: { name: string; value: string; valueType?: string | undefined; isProduction: boolean },
): string | null {
  if (policy === null || !policyApplies(policy, write.isProduction)) return null;
  const violations = valueViolations(
    policy,
    write.name,
    write.value,
    write.valueType,
    write.isProduction,
  );
  if (violations.length === 0) return null;
  const rules = violations.map((violation) =>
    violation.rule === 'minValueEntropyBits'
      ? `carries fewer than ${policy.minValueEntropyBits ?? 0} bits of entropy`
      : 'contains one of the forbidden words',
  );
  return `This value ${rules.join(' and ')} under the organisation’s policy. It still works; the next change to it must meet the rule.`;
}
