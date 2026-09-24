import {
  checkLimit,
  cheapestPlanWithFeature,
  featureError,
  isControlPlaneActive,
  limitError,
} from '@xecret/core/entitlements';
import type {
  Entitlements,
  LimitedResource,
  PlanFeatures,
  PlanLimitError,
} from '@xecret/core/entitlements';
import { errors } from './errors';

/**
 * The third gate, at the route layer.
 *
 * Capability (`ROLE_CAPABILITIES`) asks whether this class of action is open to
 * this role. Access level (`resolveAccessLevel`) asks whether they hold enough
 * on this resource. These ask whether the organisation paid for it. All three
 * must pass and none substitutes for another — buying Scale does not make a
 * viewer a writer, and an owner on Free still cannot read an environment they
 * hold no grant on.
 *
 * ── ⚠ NOTHING IN THIS FILE HAS A CALL SITE YET. THAT IS DELIBERATE. ──
 * Every function below is written, tested and unused. Do not read the presence
 * of `requireCapacity` as evidence that project, seat, service-token,
 * environment, secret or webhook ceilings are enforced anywhere: they are not.
 * The only entitlement enforced in the product today is the organisations-per-
 * account ceiling, which lives in `provisionOrganization` because it needs a row
 * lock rather than a route-layer check.
 *
 * Why staged rather than wired: payments are the *eleventh* of twelve phases in
 * `.local/plans/v2/01-billing.md`, and this is the first. Every organisation is
 * on Free until a checkout page exists, so wiring these today would hand every
 * account in the product a hard ceiling with no way to pay past it — a refusal
 * whose `upgradeTo` points at a plan nobody can buy. The gates land with the
 * checkout that makes them answerable, and they exist now so that the phases
 * between here and there have something to call rather than each growing its own
 * temporary way to ask the same question.
 *
 * The seats ceiling is the one to know about, because it is enforced by a
 * *different* mechanism and the two numbers disagree: `FREE_LIMITS.seats` is 3,
 * and `organizations.seat_limit` — which `assertSeatAvailable` actually refuses
 * invitations against — defaults to 5. The looser number is what applies. See
 * the note on `seats` in `packages/core/src/entitlements/plans.ts`.
 *
 * When wiring does happen, the counts these take are pre-addition counts from
 * the repository layer, and `limit.exceeded` should be recorded on the refusal —
 * it is in `AuditAction` for that, and is likewise not yet emitted anywhere.
 *
 * ── The rule every function here obeys ──
 * **Nothing in this file may be called on the secret-fetch path.** A build never
 * fails for a billing reason (pricing-plan §5, and `isDataPlaneActive`). These
 * guard the control plane: creating, inviting, configuring. If a future change
 * puts `requireFeature` in front of a read, that is the change to refuse in
 * review — the promise it breaks is published, and the trust it costs is the
 * only durable moat this product has.
 *
 * `secrets-service.ts` has no import from this module, and it should stay that
 * way.
 */

/** Convert a core refusal into the API's `plan_limit` response. */
function toApiError(detail: PlanLimitError): never {
  throw errors.planLimit(detail.message, {
    resource: detail.resource,
    limit: detail.limit,
    current: detail.current,
    plan: detail.plan,
    upgradeTo: detail.upgradeTo,
  });
}

/**
 * Refuse unless the organisation's plan includes `feature`.
 *
 * The refusal names the cheapest plan that would have allowed it, so the
 * dashboard can render one button rather than the whole pricing table.
 */
export function requireFeature(entitlements: Entitlements, feature: keyof PlanFeatures): void {
  if (entitlements.features[feature]) return;
  toApiError(featureError(entitlements, feature, cheapestPlanWithFeature(feature)));
}

/**
 * Refuse unless the organisation holds a separately-purchased add-on.
 *
 * Add-ons are not plan features and have no `upgradeTo`: SAML and Directory
 * Sync are bought per connection at a published price, not by moving tier, so
 * pointing at a plan would be wrong. The message says to contact us, which is
 * the actual next step — each one costs us a $125/month WorkOS connection and
 * is provisioned deliberately.
 */
export function requireAddon(
  entitlements: Entitlements,
  addon: keyof Entitlements['addons'],
): void {
  if (entitlements.addons[addon]) return;

  throw errors.planLimit(`${addon} is an add-on this organisation has not purchased.`, {
    resource: addon,
    limit: null,
    current: null,
    plan: entitlements.plan,
    upgradeTo: null,
  });
}

/**
 * Refuse unless there is room for one more `resource`.
 *
 * `current` is the count **before** the addition, which is what every existing
 * counting query in the repository layer already returns — `seatUsage`,
 * `countSecrets`, `countOrganizationsHeldBy`. Passing the post-addition count
 * would silently allow one over every ceiling in the product.
 *
 * A `warn` verdict returns normally. Crossing a fair-use ceiling refuses
 * nothing; it is a support conversation, and the caller may surface it.
 */
export function requireCapacity(
  entitlements: Entitlements,
  resource: LimitedResource,
  current: number,
): void {
  const verdict = checkLimit(entitlements, resource, current);
  if (verdict.kind !== 'exceeded') return;
  toApiError(limitError(entitlements, resource, verdict));
}

/**
 * Refuse a control-plane write when the subscription has fully lapsed.
 *
 * Deliberately permissive: `past_due` and `on_hold` still pass. A declined card
 * must not lock an owner out of the dashboard, because the page that fixes the
 * card is in the dashboard. Only `cancelled` past its period and `expired`
 * close this, and even then nothing is deleted and no secret becomes
 * unreadable.
 */
export function requireControlPlane(entitlements: Entitlements): void {
  if (isControlPlaneActive(entitlements.status)) return;

  throw errors.planLimit(
    'This organisation’s subscription has ended. Your secrets are unaffected and remain readable; renewing restores changes to projects, members and tokens.',
    {
      resource: 'subscription',
      limit: null,
      current: null,
      plan: entitlements.plan,
      upgradeTo: null,
    },
  );
}

/**
 * Whether a ceiling is close enough to warn about, for the dashboard banner.
 *
 * Returns the verdict rather than throwing, because this is the *non*-refusing
 * half of the same check — 80% of a plan ceiling, or past a fair-use one.
 */
export function capacityWarning(
  entitlements: Entitlements,
  resource: LimitedResource,
  current: number,
): { resource: LimitedResource; limit: number | null; current: number } | null {
  const verdict = checkLimit(entitlements, resource, current);
  if (verdict.kind !== 'warn') return null;
  return { resource, limit: verdict.limit, current: verdict.current };
}
