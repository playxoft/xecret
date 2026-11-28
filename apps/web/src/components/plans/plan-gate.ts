import {
  AWAITING_ORGANIZATIONS_PER_ACCOUNT,
  checkLimit,
  cheapestPlanWithFeature,
  cheapestPlanWithLimit,
  describeLimit,
  FREE_ORGANIZATIONS_PER_ACCOUNT,
  hasFeature,
  PLAN_IDS,
  PLAN_RANK,
  PLANS,
} from '@xecret/core/entitlements';
import type {
  Entitlements,
  LimitedResource,
  OrgAddons,
  PlanFeatures,
  PlanId,
  PlanLimits,
  SubscriptionStatus,
} from '@xecret/core/entitlements';
import type { PlanProblem } from '@/lib/api';

/**
 * Whether the organisation's plan allows an action, decided in the browser the
 * way the server decides it, so a control can be drawn locked before anybody
 * presses it.
 *
 * ── The same decision, not a second one ──
 * Every answer here is `checkLimit`, `hasFeature`, `cheapestPlanWithFeature` or
 * `cheapestPlanWithLimit` from `@xecret/core`, asked of the entitlements
 * `GET …/entitlements` resolved on the server, support overrides and the seat
 * column included. So a raised ceiling is never drawn as reached, and a lock
 * here is the refusal the server would give. The server still refuses on its
 * own: this decides what is drawn, never what is allowed, and until the
 * entitlements arrive nothing is locked at all.
 *
 * ── What a lock says ──
 * One sentence of fact ("Your Free plan allows 5 projects.") and the cheapest
 * plan that lifts it. Who is told to do what about it (an owner is offered the
 * plans page, anybody else is told to ask an owner) is `lockCopy`'s, because it
 * depends on who is looking rather than on the plan.
 */

/** `GET /api/orgs/{org}/entitlements`, restated for the browser. See `server/schemas/entitlements.ts`. */
export interface OrgEntitlements {
  plan: PlanId;
  status: SubscriptionStatus;
  controlPlaneActive: boolean;
  awaitingPaidPlan: boolean;
  limits: PlanLimits;
  features: PlanFeatures;
  addons: OrgAddons;
  usage: { projects: number; serviceTokens: number; webhooks: number; seats: number };
  account: { freeOrganizations: number; awaitingOrganizations: number };
  upgrades: boolean;
}

export interface EntitlementsResponse {
  entitlements: OrgEntitlements;
}

/**
 * Why an action is locked.
 *
 * `kind` says what upgrading would do, which decides the sentence after the
 * reason: a `limit` lifts a ceiling ("to add more"), a `feature` turns a
 * capability on, `awaiting` opens an organisation waiting for its first paid
 * plan, and `notice` is a lock no purchase on this organisation lifts.
 */
export interface PlanBlock {
  kind: 'limit' | 'feature' | 'awaiting' | 'notice';
  /** The fact, as a sentence: "Your Free plan allows 5 projects." */
  reason: string;
  /** The cheapest plan that would allow it, or `null` when none would. */
  upgradeTo: PlanId | null;
  /** For a `limit`, the ceiling reached: none at all reads "add one", not "add more". */
  limit?: number | undefined;
}

/** The plan's name as the pricing page says it. */
function nameOf(plan: string): string {
  return Object.hasOwn(PLANS, plan) ? PLANS[plan as PlanId].name : plan;
}

/** The sentence every write is locked with while the organisation waits for a plan. */
export const AWAITING_REASON = 'Choose a plan to start using this organisation.';

/** The lock for an organisation whose control plane is closed, or `null` while it is open. */
export function controlPlaneBlock(entitlements: OrgEntitlements): PlanBlock | null {
  if (entitlements.controlPlaneActive) return null;
  if (entitlements.awaitingPaidPlan) {
    return {
      kind: 'awaiting',
      reason: AWAITING_REASON,
      upgradeTo: PLAN_IDS.find((id) => id !== 'free') ?? null,
    };
  }
  return {
    kind: 'notice',
    reason: 'This organisation’s subscription has ended. Renew it to make changes.',
    upgradeTo: null,
  };
}

/**
 * The browser's own copy of the entitlements `checkLimit` and `hasFeature`
 * read. They take the resolved object, and these fields are exactly the
 * resolved object's: nothing here re-derives a limit from the plan.
 */
function asEntitlements(entitlements: OrgEntitlements): Entitlements {
  return {
    plan: entitlements.plan,
    status: entitlements.status,
    limits: entitlements.limits,
    features: entitlements.features,
    addons: entitlements.addons,
    awaitingPaidPlan: entitlements.awaitingPaidPlan,
    controlPlaneActive: entitlements.controlPlaneActive,
  };
}

/**
 * "Your Free plan allows 5 projects." The sentence says whose number it is: the
 * plan's, or the organisation's own where support raised it above the plan's,
 * so an organisation granted ten is never told Free allows ten.
 */
function limitReason(
  entitlements: OrgEntitlements,
  resource: LimitedResource,
  limit: number,
): string {
  const planLimit = PLANS[entitlements.plan].limits[resource];
  const plan = nameOf(entitlements.plan);
  // "allows 0 webhooks" reads as a typo; a ceiling of nothing is said as one.
  if (limit === 0)
    return `Your ${plan} plan includes no ${describeLimit(resource, 2).replace(/^2 /, '')}.`;
  const allows = describeLimit(resource, limit);
  return planLimit === limit
    ? `Your ${plan} plan allows ${allows}.`
    : `This organisation’s limit is ${allows}.`;
}

/**
 * Whether `adding` more `resource` fit, given `current` held now.
 *
 * `current` is the count before the addition, as on the server. A closed
 * control plane locks it first, whatever the count, because the server refuses
 * every write to such an organisation.
 */
export function limitBlock(
  entitlements: OrgEntitlements,
  resource: LimitedResource,
  current: number,
  adding = 1,
): PlanBlock | null {
  const closed = controlPlaneBlock(entitlements);
  if (closed !== null) return closed;

  const verdict = checkLimit(asEntitlements(entitlements), resource, current, adding);
  if (verdict.kind !== 'exceeded') return null;
  return {
    kind: 'limit',
    reason: limitReason(entitlements, resource, verdict.limit),
    upgradeTo: verdict.upgradeTo,
    limit: verdict.limit,
  };
}

/**
 * How each gated capability reads as the subject of a sentence, and whether it
 * takes "is" or "are". Every `PlanFeatures` flag has one, so a lock on any of
 * them can be worded; the compiler holds the list complete.
 */
const FEATURE_SUBJECTS: Readonly<Record<keyof PlanFeatures, readonly [string, 'is' | 'are']>> = {
  secretReferencing: ['Secret referencing', 'is'],
  personalOverrides: ['Personal overrides', 'are'],
  environmentPromotion: ['Environment promotion', 'is'],
  pointInTimeRestore: ['Point-in-time restore', 'is'],
  tokenIpAllowlist: ['The token policy', 'is'],
  newIpReadAlerts: ['New-address read alerts', 'are'],
  perEnvironmentGrants: ['Per-environment grants', 'are'],
  oidcSso: ['Single sign-on', 'is'],
  changeApprovals: ['Change approvals', 'are'],
  secretPolicy: ['The secret policy', 'is'],
  disableEnvExport: ['Turning off plaintext export', 'is'],
  breakGlass: ['Break-glass access', 'is'],
  bulkRotate: ['Bulk rotation', 'is'],
  customRoles: ['Custom roles', 'are'],
  githubOidcFederation: ['GitHub OIDC federation', 'is'],
  scheduledSecrets: ['Scheduled secrets', 'are'],
  siemStreaming: ['SIEM streaming', 'is'],
};

/** "Secret referencing is on Pro and above." */
export function featureReason(feature: keyof PlanFeatures, upgradeTo: PlanId | null): string {
  const [subject, verb] = FEATURE_SUBJECTS[feature];
  if (upgradeTo === null) return `${subject} ${verb} not part of this organisation’s plan.`;
  const top = PLAN_IDS[PLAN_IDS.length - 1];
  return upgradeTo === top
    ? `${subject} ${verb} on ${nameOf(upgradeTo)}.`
    : `${subject} ${verb} on ${nameOf(upgradeTo)} and above.`;
}

/** Whether the plan includes `feature`; a closed control plane locks it first. */
export function featureBlock(
  entitlements: OrgEntitlements,
  feature: keyof PlanFeatures,
): PlanBlock | null {
  const closed = controlPlaneBlock(entitlements);
  if (closed !== null) return closed;
  if (hasFeature(asEntitlements(entitlements), feature)) return null;
  const upgradeTo = cheapestPlanWithFeature(feature);
  return { kind: 'feature', reason: featureReason(feature, upgradeTo), upgradeTo };
}

/**
 * The lock for a capability, from the `{ enabled, upgradeTo }` a listing
 * already carries (`featureStatus` on the server): the policies, the custom
 * roles, the overrides. The same decision `featureBlock` makes, read from the
 * screen's own answer, so the lock is there as soon as that screen has loaded.
 */
export function featureLockFrom(
  feature: keyof PlanFeatures,
  status: { enabled: boolean; upgradeTo: string | null },
): PlanBlock | null {
  if (status.enabled) return null;
  const upgradeTo = Object.hasOwn(PLANS, status.upgradeTo ?? '')
    ? (status.upgradeTo as PlanId)
    : null;
  return { kind: 'feature', reason: featureReason(feature, upgradeTo), upgradeTo };
}

/* ── Organisations per account ─────────────────────────────────────────────── */

/**
 * Whether the asking account may create another organisation: not while it
 * holds one still waiting for a paid plan. No purchase on the organisation
 * being looked at lifts this (the one waiting may be another), so it is a
 * `notice`, offering no upgrade.
 */
export function organizationCreateBlock(account: OrgEntitlements['account']): PlanBlock | null {
  if (account.awaitingOrganizations < AWAITING_ORGANIZATIONS_PER_ACCOUNT) return null;
  return {
    kind: 'notice',
    reason:
      'You already have an organisation waiting for a paid plan. Choose a plan for it or delete it, then create another.',
    upgradeTo: null,
  };
}

/**
 * The sentence the create dialog says before an organisation that would wait
 * for a paid plan is created, or `null` when the next one is free.
 */
export function freeAllowanceNotice(account: OrgEntitlements['account']): string | null {
  if (account.freeOrganizations < FREE_ORGANIZATIONS_PER_ACCOUNT) return null;
  if (account.awaitingOrganizations >= AWAITING_ORGANIZATIONS_PER_ACCOUNT) return null;
  return `You already have ${FREE_ORGANIZATIONS_PER_ACCOUNT} free organisations. This one needs a paid plan before you can use it.`;
}

/* ── A refusal that arrived anyway ─────────────────────────────────────────── */

/**
 * A `plan_limit` refusal read as the same lock, for the race a lock cannot
 * close: two people creating the last project at once. The server's own
 * sentence is long and written for every client; this says it the way the
 * lock would have, from the facts the refusal carries.
 */
export function blockFromRefusal(problem: PlanProblem, message?: string): PlanBlock {
  const named = Object.hasOwn(PLANS, problem.upgradeTo ?? '')
    ? (problem.upgradeTo as PlanId)
    : null;
  const upgradeTo = named ?? ladderAbove(problem);

  if (problem.resource === 'awaitingPaidPlan') {
    return { kind: 'awaiting', reason: AWAITING_REASON, upgradeTo };
  }
  if (Object.hasOwn(FEATURE_SUBJECTS, problem.resource)) {
    const feature = problem.resource as keyof PlanFeatures;
    return { kind: 'feature', reason: featureReason(feature, upgradeTo), upgradeTo };
  }
  if (
    problem.limit !== null &&
    isLimitedResource(problem.resource) &&
    Object.hasOwn(PLANS, problem.plan)
  ) {
    const plan = problem.plan as PlanId;
    const planLimit = PLANS[plan].limits[problem.resource];
    const allows = describeLimit(problem.resource, problem.limit);
    return {
      kind: 'limit',
      reason:
        planLimit === problem.limit
          ? `Your ${nameOf(plan)} plan allows ${allows}.`
          : `This organisation’s limit is ${allows}.`,
      upgradeTo,
    };
  }
  // Anything else (a lapsed subscription, an add-on) is said in the server's
  // own words, which are the only ones that know what it was.
  return {
    kind: 'notice',
    reason: message ?? 'This organisation’s plan does not allow that.',
    upgradeTo,
  };
}

/**
 * The plan a limit refusal would have named, for one that named none it could
 * be read by: the cheapest plan holding one more, and only one above the plan
 * the organisation is on, because "upgrade to Free" is no advice.
 */
function ladderAbove(problem: PlanProblem): PlanId | null {
  if (problem.limit === null || !isLimitedResource(problem.resource)) return null;
  if (!Object.hasOwn(PLANS, problem.plan)) return null;
  const candidate = cheapestPlanWithLimit(problem.resource, problem.limit + 1);
  if (candidate === null) return null;
  return PLAN_RANK[candidate] > PLAN_RANK[problem.plan as PlanId] ? candidate : null;
}

const LIMITED_RESOURCES: ReadonlySet<string> = new Set<LimitedResource>([
  'projects',
  'environmentsPerProject',
  'serviceTokens',
  'seats',
  'cliDevicesPerUser',
  'webhooks',
  'secretsPerEnvironment',
]);

function isLimitedResource(resource: string): resource is LimitedResource {
  return LIMITED_RESOURCES.has(resource);
}

/* ── What a lock says to whom ──────────────────────────────────────────────── */

export interface LockViewer {
  /** An owner, who may buy the plan (`billing.manage`). */
  owner: boolean;
  /** Whether this deployment takes a checkout at all. */
  upgrades: boolean;
}

export interface LockCopy {
  /** What the plan allows. */
  reason: string;
  /** What to do about it, when there is something to do: "Upgrade to Pro to add more." */
  next: string | null;
  /** Whether to offer the owner the link to the plans page. */
  link: boolean;
}

/**
 * The words of a lock for the person looking at it.
 *
 * An owner is told which plan lifts it and offered the plans page; anybody else
 * is told to ask an owner, because only an owner can buy one. Where this
 * deployment sells nothing, or no plan lifts it, only the fact is said: an
 * offer of something nobody can buy is worse than none.
 */
export function lockCopy(block: PlanBlock, viewer: LockViewer): LockCopy {
  const purchasable = viewer.upgrades && block.upgradeTo !== null && block.kind !== 'notice';
  if (!purchasable) return { reason: block.reason, next: null, link: false };
  if (!viewer.owner) {
    return {
      reason: block.reason,
      next: block.kind === 'awaiting' ? 'Ask an owner to choose one.' : 'Ask an owner to upgrade.',
      link: false,
    };
  }
  // A feature's reason already names the plan, and an organisation waiting for
  // one is told to choose it: the link says the rest.
  const plan = nameOf(block.upgradeTo ?? '');
  const next =
    block.kind !== 'limit'
      ? null
      : block.limit === 0
        ? `Upgrade to ${plan} to add one.`
        : `Upgrade to ${plan} to add more.`;
  return { reason: block.reason, next, link: true };
}
