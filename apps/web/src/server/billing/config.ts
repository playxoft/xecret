import type { BillingInterval, PlanId } from '@xecret/core/entitlements';
import { MissingBindingError } from '../bindings';
import type { Bindings } from '../bindings';

/**
 * Whether this deployment takes payments, and the Dodo catalogue it sells from.
 *
 * ── All or nothing ──
 * A deployment with **none** of the Dodo variables has billing switched off:
 * a self-hoster, or this one before Dodo is set up. Every organisation's plan
 * is then whatever the operator tool (`npm run plan:set`) wrote, the billing
 * screen says payments are not set up, and nothing else changes.
 *
 * A deployment with **some** of them is misconfigured, and that must be loud
 * rather than discovered at somebody's checkout: `billingSetup` throws
 * {@link BillingMisconfiguredError} naming every missing variable, which the
 * route wrapper answers with a 503 and an error log line naming them — the
 * webhook included, so Dodo keeps retrying until it is fixed rather than having
 * its events accepted and dropped. `check:env` and `check:deploy` fail on the
 * same half-configuration before a deploy gets that far.
 *
 * ── What is sold ──
 * Pro and Team, monthly and yearly: four products. Enterprise is a contract
 * and a manual invoice, and is never sold through checkout (overview §6).
 * Scale was withdrawn (`RETIRED_PLANS`), so the setup guide's two Scale
 * products are not read — a conflict with `.local/dodo/dodo-setup.md` Part 3
 * that this file resolves in the codebase's favour. Prices are not here at
 * all: they live in the Dodo products, per currency, and the pricing page.
 */

export type DodoMode = 'test_mode' | 'live_mode';

/** Dodo's two API hosts. Test and live share nothing — keys, products, webhooks. */
export const DODO_BASE_URL: Readonly<Record<DodoMode, string>> = Object.freeze({
  test_mode: 'https://test.dodopayments.com',
  live_mode: 'https://live.dodopayments.com',
});

/** The plans checkout sells. Free is never bought; Enterprise is a contract. */
export const PURCHASABLE_PLANS = ['pro', 'team'] as const satisfies readonly PlanId[];
export type PurchasablePlan = (typeof PURCHASABLE_PLANS)[number];

export const BILLING_INTERVALS = [
  'monthly',
  'yearly',
] as const satisfies readonly BillingInterval[];

export function isPurchasablePlan(value: string): value is PurchasablePlan {
  return (PURCHASABLE_PLANS as readonly string[]).includes(value);
}

/** One product: the plan and interval it sells. */
export interface CatalogEntry {
  readonly plan: PurchasablePlan;
  readonly interval: BillingInterval;
  readonly productId: string;
}

export interface BillingConfig {
  readonly mode: DodoMode;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly webhookSecret: string;
  /** The usage meter's event name — one event per thousand fetches past the allowance. */
  readonly meterEventName: string;
  readonly catalog: readonly CatalogEntry[];
  /** The SAML add-on's id, when this deployment sells it through Dodo. */
  readonly samlAddonId: string | null;
}

export type BillingSetup =
  { readonly state: 'disabled' } | { readonly state: 'enabled'; readonly config: BillingConfig };

/** The variable that names each product. */
const PRODUCT_VARIABLES = {
  pro: { monthly: 'DODO_PRODUCT_PRO_MONTHLY', yearly: 'DODO_PRODUCT_PRO_YEARLY' },
  team: { monthly: 'DODO_PRODUCT_TEAM_MONTHLY', yearly: 'DODO_PRODUCT_TEAM_YEARLY' },
} as const satisfies Record<PurchasablePlan, Record<BillingInterval, keyof Bindings>>;

/** Every variable billing needs. Exported for `check:env` and `check:deploy`. */
export const REQUIRED_BILLING_VARIABLES = [
  'DODO_API_KEY',
  'DODO_WEBHOOK_SECRET',
  'DODO_ENVIRONMENT',
  'DODO_PRODUCT_PRO_MONTHLY',
  'DODO_PRODUCT_PRO_YEARLY',
  'DODO_PRODUCT_TEAM_MONTHLY',
  'DODO_PRODUCT_TEAM_YEARLY',
  'DODO_METER_SECRET_FETCH',
] as const satisfies readonly (keyof Bindings)[];

/** Read only when billing is on, and never required. */
export const OPTIONAL_BILLING_VARIABLES = [
  'DODO_ADDON_SAML',
] as const satisfies readonly (keyof Bindings)[];

/**
 * Billing is half-configured. A `MissingBindingError`, so the route wrapper
 * answers it the way it answers every operator fault: 503, no detail to the
 * caller, and an error line naming what is missing.
 */
export class BillingMisconfiguredError extends MissingBindingError {
  constructor(readonly problems: readonly string[]) {
    super(problems.join(', '));
    this.name = 'BillingMisconfiguredError';
  }
}

function present(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Whether this deployment takes payments, and with what. Throws
 * {@link BillingMisconfiguredError} on a half-configuration.
 *
 * Cheap and pure: read per request rather than cached, so a variable fixed
 * with `wrangler secret put` takes effect on the next request.
 */
export function billingSetup(env: Bindings): BillingSetup {
  const all = [...REQUIRED_BILLING_VARIABLES, ...OPTIONAL_BILLING_VARIABLES];
  if (!all.some((name) => present(env[name]))) return { state: 'disabled' };

  const missing = REQUIRED_BILLING_VARIABLES.filter((name) => !present(env[name]));
  if (missing.length > 0) {
    throw new BillingMisconfiguredError(missing.map((name) => `${name} (unset)`));
  }

  const problems: string[] = [];
  const mode = env.DODO_ENVIRONMENT?.trim();
  if (mode !== 'test_mode' && mode !== 'live_mode') {
    problems.push('DODO_ENVIRONMENT (not test_mode or live_mode)');
  }

  const meterEventName = env.DODO_METER_SECRET_FETCH?.trim() ?? '';
  // The meter's id is the obvious thing to paste and the wrong one: usage is
  // reported by event name, and an id would be accepted by Dodo and counted
  // against a meter that does not exist.
  if (meterEventName.startsWith('mtr_') || !/^[A-Za-z0-9_.-]{1,100}$/.test(meterEventName)) {
    problems.push('DODO_METER_SECRET_FETCH (not a meter event name)');
  }

  const catalog: CatalogEntry[] = [];
  for (const plan of PURCHASABLE_PLANS) {
    for (const interval of BILLING_INTERVALS) {
      const name = PRODUCT_VARIABLES[plan][interval];
      catalog.push({ plan, interval, productId: (env[name] as string).trim() });
    }
  }
  // Each product must sell exactly one plan and interval, or a webhook naming
  // it could not say which one the customer bought.
  const ids = new Set(catalog.map((entry) => entry.productId));
  if (ids.size !== catalog.length) problems.push('DODO_PRODUCT_* (two variables name one product)');

  if (problems.length > 0) throw new BillingMisconfiguredError(problems);

  const samlAddonId = present(env.DODO_ADDON_SAML) ? env.DODO_ADDON_SAML.trim() : null;
  const resolvedMode = mode as DodoMode;

  return {
    state: 'enabled',
    config: Object.freeze({
      mode: resolvedMode,
      baseUrl: DODO_BASE_URL[resolvedMode],
      apiKey: (env.DODO_API_KEY as string).trim(),
      webhookSecret: (env.DODO_WEBHOOK_SECRET as string).trim(),
      meterEventName,
      catalog: Object.freeze(catalog),
      samlAddonId,
    }),
  };
}

/** The product that sells `plan` at `interval`. Every pair has one when billing is on. */
export function productFor(
  config: BillingConfig,
  plan: PurchasablePlan,
  interval: BillingInterval,
): string {
  const entry = config.catalog.find((item) => item.plan === plan && item.interval === interval);
  if (!entry) throw new Error(`no product for ${plan} ${interval}`);
  return entry.productId;
}

/** What a product sells, or `null` for a product this catalogue does not know. */
export function catalogEntryFor(config: BillingConfig, productId: string): CatalogEntry | null {
  return config.catalog.find((item) => item.productId === productId) ?? null;
}
