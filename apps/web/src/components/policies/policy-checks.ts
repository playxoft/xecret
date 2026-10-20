import {
  checkNameAgainstPolicy,
  checkValueAgainstPolicy,
  policyApplies,
} from '@xecret/core/policy';
import type { PolicyViolation, SecretPolicy } from '@xecret/core/policy';
import { parseTemplate } from '@xecret/core/references';
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
 * A template's text is not its value: `postgres://${DB_USER}@${DB_HOST}` carries
 * no credential of its own, and the secrets it names are held to the rules
 * where they are written. So for a template the entropy rule is not asked — a
 * reference is short and predictable by design, and `${DB_PASSWORD}` would fail
 * it every time — and the forbidden-word rule is asked of the literal text
 * only, so a reference *named* `DB_PASSWORD` is not mistaken for the word
 * "password" sitting in the value. A template that does not parse is checked
 * whole: it is about to be refused for its syntax anyway, and checking less of
 * it would be the wrong way to be lenient.
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

/** The text of a value the value rules are asked about. See the header on templates. */
function checkedText(value: string, valueType: string | undefined): string {
  if (valueType !== 'template') return value;
  try {
    return parseTemplate(value)
      .flatMap((segment) => (segment.kind === 'text' ? [segment.text] : []))
      .join('\n');
  } catch {
    return value;
  }
}

function valueViolations(
  policy: SecretPolicy,
  name: string,
  value: string,
  valueType: string | undefined,
  isProduction: boolean,
): PolicyViolation[] {
  const violations = checkValueAgainstPolicy(
    policy,
    name,
    checkedText(value, valueType),
    isProduction,
  );
  return valueType === 'template'
    ? violations.filter((violation) => violation.rule !== 'minValueEntropyBits')
    : violations;
}

/**
 * Every rule a write breaks, name first.
 *
 * `null` policy — not loaded yet, or the request failed — breaks nothing. The
 * dashboard does not refuse a write because it could not read the rulebook: the
 * server still asks the name rule, and a screen that froze every save on a
 * failed `GET /policies` would turn a transient error into an outage.
 */
export function policyViolations(
  policy: SecretPolicy | null,
  write: PolicyWrite,
): PolicyViolation[] {
  if (policy === null || !policyApplies(policy, write.isProduction)) return [];

  const violations: PolicyViolation[] = [];
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
export function violationField(violation: PolicyViolation): 'name' | 'value' {
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
