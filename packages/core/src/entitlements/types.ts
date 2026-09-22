/**
 * Entitlement types — the third gate.
 *
 * Every request passes three independent predicates, and all three must pass:
 *
 *   1. **Capability** — is this class of action available to this role at all?
 *      Org-wide, resource-independent. `authz/roles.ts`.
 *   2. **Access level** — does the actor hold a high enough level on *this*
 *      project or environment? `authz/grants.ts`.
 *   3. **Entitlement** — has this organisation paid for the capability, and is
 *      it within the limits of what it paid for? This module.
 *
 * The three are deliberately separate and never fold into one another. An
 * entitlement can never *grant* access: a Free-tier owner still cannot read an
 * environment they hold no grant on, and buying Scale does not make a viewer a
 * writer. Entitlements only ever subtract. Writing them as a third predicate
 * rather than as extra rows in the capability table is what makes that
 * structurally true instead of merely intended.
 *
 * See `.local/plans/v2/01-billing.md` §P11 and `.local/plans/pricing-plan.md` §3.
 */

/** The five rungs. Ordered weakest to strongest; `PLAN_RANK` depends on it. */
export type PlanId = 'free' | 'pro' | 'team' | 'scale' | 'enterprise';

/** How a paid plan is billed. `null` on Free, which is never billed. */
export type BillingInterval = 'monthly' | 'yearly';

/**
 * The billing lifecycle, mirroring Dodo's subscription statuses.
 *
 * Present in this package — which knows nothing about payments — because the
 * *entitlement* consequence of each status is a product decision, not a billing
 * one, and it belongs beside the plan it modifies. `isDataPlaneActive` is the
 * whole of that decision and it lives in `entitlements.ts`.
 */
export type SubscriptionStatus =
  'active' | 'trialing' | 'past_due' | 'on_hold' | 'cancelled' | 'expired';

/**
 * Countable resources, each with a ceiling that varies by plan.
 *
 * A string union rather than free-form keys so that `checkLimit` cannot be
 * called with a resource nobody defined a limit for — the failure mode being a
 * limit check that silently passes because `undefined` is not a number.
 */
export type LimitedResource =
  | 'organizations'
  | 'projects'
  | 'environmentsPerProject'
  | 'serviceTokens'
  | 'seats'
  | 'cliDevicesPerUser'
  | 'webhooks'
  | 'secretsPerEnvironment';

/**
 * Plan ceilings.
 *
 * `null` means **unlimited for billing purposes** — it does not mean infinite.
 * Every `null` is still subject to the fair-usage ceilings in `FAIR_USE`, which
 * warn rather than refuse. The two are different mechanisms with different
 * failure modes and are deliberately not merged: a plan limit is a wall we sell
 * against, a fair-use ceiling is a tripwire we monitor. Collapsing them would
 * turn every "unlimited" claim on the pricing page into a lie by omission.
 */
export interface PlanLimits {
  readonly organizations: number | null;
  readonly projects: number | null;
  readonly environmentsPerProject: number | null;
  readonly serviceTokens: number | null;
  readonly seats: number | null;
  readonly cliDevicesPerUser: number | null;
  readonly webhooks: number | null;
  readonly secretsPerEnvironment: number | null;
  /** Versions kept per secret before the oldest are pruned. Never `null`. */
  readonly secretVersionsRetained: number;
  /** Days of audit history readable. The clamp already applied by the audit API. */
  readonly auditRetentionDays: number;
  /** How far back point-in-time restore may target. `0` disables the feature. */
  readonly pitrDays: number;
  /** Secret fetches included per billing period before metered overage. */
  readonly includedFetchesPerMonth: number;
}

/**
 * Capability flags, one per gated feature.
 *
 * Exhaustive and boolean by design. A tri-state ("available but limited") would
 * push product decisions into call sites, where they drift; anything that needs
 * a number is a `PlanLimits` field instead.
 *
 * Add-ons are **not** here — see `OrgAddons`.
 */
export interface PlanFeatures {
  /* Pro and above — the "worth paying at all" bundle. */
  readonly secretReferencing: boolean;
  readonly personalOverrides: boolean;
  readonly environmentPromotion: boolean;
  readonly pointInTimeRestore: boolean;
  readonly tokenIpAllowlist: boolean;
  readonly newIpReadAlerts: boolean;

  /* Team and above — the access-control bundle. */
  /**
   * Per-environment grants: the Pro → Team gate, and the single most
   * commercially load-bearing flag in this file.
   *
   * On Pro every member can read every environment, production included. The
   * moment a team has a contractor, a junior or an auditor who must not see
   * prod, they need Team — and that is a real requirement rather than an
   * artificial cap, which is why Pro can offer unlimited seats without
   * cannibalising Team. See pricing-plan.md §3, "On unlimited seats at Pro".
   *
   * **Never weaken this gate.** The day Pro gains even read-only roles, Team
   * has no reason to exist.
   */
  readonly perEnvironmentGrants: boolean;
  readonly oidcSso: boolean;
  readonly changeApprovals: boolean;
  readonly secretPolicy: boolean;
  readonly disableEnvExport: boolean;
  readonly breakGlass: boolean;
  readonly bulkRotate: boolean;

  /* Scale and above. */
  readonly customRoles: boolean;
  readonly githubOidcFederation: boolean;
  readonly scheduledSecrets: boolean;
  readonly siemStreaming: boolean;
}

/**
 * Separately purchased capabilities.
 *
 * Kept out of `PlanFeatures` on purpose. SAML and Directory Sync each cost us a
 * real $125/month WorkOS connection per customer and are sold as add-ons at
 * $199 and $249 (pricing-plan.md §8). If they were plan features, someone would
 * eventually bundle one into a tier and we would be paying $125/month for every
 * customer on it. The type system says no.
 */
export interface OrgAddons {
  readonly samlSso: boolean;
  readonly directorySync: boolean;
}

/** A plan as published: identity, limits, features, and the prices it is sold at. */
export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  /** Minimum seats purchasable. Stops a solo dev buying one Scale seat. */
  readonly minimumSeats: number;
  readonly limits: PlanLimits;
  readonly features: PlanFeatures;
}

/**
 * What a specific organisation may do, right now.
 *
 * The resolved product of its plan, its add-ons, its status, and any support
 * overrides. This is the only shape enforcement code should ever see; nothing
 * outside this module should branch on `PlanId` directly, because doing so
 * silently ignores overrides and add-ons.
 */
export interface Entitlements {
  readonly plan: PlanId;
  readonly status: SubscriptionStatus;
  readonly limits: PlanLimits;
  readonly features: PlanFeatures;
  readonly addons: OrgAddons;
  /**
   * False when the subscription has lapsed past any grace.
   *
   * Control-plane writes are refused; **the data plane is untouched**. See
   * `isDataPlaneActive`.
   */
  readonly controlPlaneActive: boolean;
}

/** The input `resolveEntitlements` works from — one organisation's billing row. */
export interface SubscriptionState {
  readonly plan: PlanId;
  readonly status: SubscriptionStatus;
  readonly addonSaml: boolean;
  readonly addonDirectorySync: boolean;
  /**
   * Support-granted ceiling raises, keyed by `PlanLimits` field name.
   *
   * The mechanism behind the fair-usage promise that "a customer hitting a
   * ceiling in good faith gets it raised for free" (pricing-plan.md §5) without
   * a deploy. Only ever raises: a value lower than the plan's own is ignored,
   * so an override can never be used to quietly downgrade someone.
   */
  readonly limitOverrides?: Readonly<Record<string, number | null>> | undefined;
  /** When the paid period ends. Access survives to here after cancellation. */
  readonly currentPeriodEnd?: Date | null | undefined;
}

/** The outcome of a ceiling check. */
export type LimitVerdict =
  /** Under the ceiling, and not near it. */
  | { readonly kind: 'ok'; readonly limit: number | null; readonly current: number }
  /**
   * At or past a fair-use soft ceiling, or within `WARN_AT` of a plan ceiling.
   * **Never refuse on this.** Warn in the UI, email the owners, keep going.
   */
  | {
      readonly kind: 'warn';
      readonly limit: number | null;
      readonly current: number;
      readonly reason: 'approaching' | 'fairUse';
    }
  /** Past a hard plan ceiling. Control-plane writes are refused; reads are not. */
  | {
      readonly kind: 'exceeded';
      readonly limit: number;
      readonly current: number;
      readonly upgradeTo: PlanId | null;
    };
