import { UNCAPPED_SEAT_LIMIT } from '@xecret/core/entitlements';
import type {
  Entitlements,
  OrgAddons,
  PlanFeatures,
  PlanId,
  PlanLimits,
  SubscriptionStatus,
} from '@xecret/core/entitlements';

/**
 * `GET /api/orgs/{orgSlug}/entitlements`: what the organisation's plan allows,
 * and how much of each organisation-wide ceiling it has used, for the
 * dashboard's locks.
 *
 * ── What it is for ──
 * The dashboard draws a control the plan does not allow (a limit reached, or a
 * feature the plan lacks) locked, with a sentence saying what the plan allows,
 * *before* anybody presses it. To decide that the way the server does, the
 * browser asks `checkLimit` and `hasFeature` of `@xecret/core` about these
 * resolved entitlements: support overrides and the seat column already
 * applied, so a raised ceiling is never shown as reached. The server still
 * refuses every write past a ceiling on its own; this decides what is drawn,
 * never what is allowed.
 *
 * ── What it carries, and what it never does ──
 * Numbers, flags and a plan id. No name, no slug, no email, no secret, no
 * provider identifier: the counts are of rows, not lists of them. Every member
 * may read it (`member.read`), because every member sees the controls it locks.
 *
 * The per-project and per-environment counts (environments in a project,
 * secrets in an environment) are not here: the screens that would lock on them
 * already list what they hold.
 */
export interface EntitlementsPayload {
  plan: PlanId;
  status: SubscriptionStatus;
  /** False while the organisation awaits a paid plan or its subscription has lapsed. */
  controlPlaneActive: boolean;
  /** Past its creator's two free organisations, and waiting for a plan to be bought. */
  awaitingPaidPlan: boolean;
  /**
   * The plan's limits after overrides, with `seats` replaced by the ceiling
   * invitations are actually refused at (`organizations.seat_limit`), and
   * `null` where that ceiling is uncapped (a per-seat plan).
   */
  limits: PlanLimits;
  features: PlanFeatures;
  addons: OrgAddons;
  /** What the organisation holds now, counted the way each ceiling refuses. */
  usage: {
    projects: number;
    serviceTokens: number;
    webhooks: number;
    /** Members holding a seat, and open invitations each promised one. */
    seats: number;
  };
  /**
   * The asking account's free allowance (`freeOrganizationAllowance`): its own,
   * never the organisation's, because organisations are counted per account.
   */
  account: {
    /** Free organisations the account created and is still in, counted up to three. */
    freeOrganizations: number;
    /** How many of those are waiting for a paid plan. One at most may be. */
    awaitingOrganizations: number;
  };
  /**
   * Whether this deployment can take a checkout at all. Where it cannot (a
   * self-hoster, or a deployment before payments), a lock says what the plan
   * allows and offers no upgrade, because there is nothing to buy.
   */
  upgrades: boolean;
}

export interface EntitlementsInput {
  entitlements: Entitlements;
  seatLimit: number;
  counts: {
    seatedMembers: number;
    pendingInvitations: number;
    projects: number;
    serviceTokens: number;
  };
  webhooks: number;
  allowance: { free: number; awaiting: number };
  upgrades: boolean;
}

export function toEntitlementsPayload(input: EntitlementsInput): EntitlementsPayload {
  const { entitlements, counts } = input;
  return {
    plan: entitlements.plan,
    status: entitlements.status,
    controlPlaneActive: entitlements.controlPlaneActive,
    awaitingPaidPlan: entitlements.awaitingPaidPlan,
    limits: {
      ...entitlements.limits,
      seats: input.seatLimit >= UNCAPPED_SEAT_LIMIT ? null : input.seatLimit,
    },
    features: entitlements.features,
    addons: entitlements.addons,
    usage: {
      projects: counts.projects,
      serviceTokens: counts.serviceTokens,
      webhooks: input.webhooks,
      seats: counts.seatedMembers + counts.pendingInvitations,
    },
    account: {
      freeOrganizations: input.allowance.free,
      awaitingOrganizations: input.allowance.awaiting,
    },
    upgrades: input.upgrades,
  };
}
