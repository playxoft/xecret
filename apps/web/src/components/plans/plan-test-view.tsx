import type { ReactElement } from 'react';
import { PLANS } from '@xecret/core/entitlements';
import type { PlanId } from '@xecret/core/entitlements';

import { PlanViewProvider } from './plan-entitlements';
import type { PlanView } from './plan-entitlements';
import type { OrgEntitlements } from './plan-gate';

/**
 * Plan views for render tests: what `GET …/entitlements` would answer for an
 * organisation on `plan`, and the shell's view around it. Test support only;
 * nothing in the application imports this module.
 */

export function entitlementsFor(
  plan: PlanId,
  over: Partial<OrgEntitlements> = {},
): OrgEntitlements {
  return {
    plan,
    status: 'active',
    controlPlaneActive: true,
    awaitingPaidPlan: false,
    limits: PLANS[plan].limits,
    features: PLANS[plan].features,
    addons: { samlSso: false, directorySync: false },
    usage: { projects: 0, serviceTokens: 0, webhooks: 0, seats: 1 },
    account: { freeOrganizations: 1, awaitingOrganizations: 0 },
    upgrades: true,
    ...over,
  };
}

/** An owner's view of a Free organisation, unless told otherwise. */
export function planView(over: Partial<PlanView> = {}): PlanView {
  return {
    entitlements: entitlementsFor('free'),
    owner: true,
    plansHref: '/app/acme/settings/plans',
    refresh: () => {},
    ...over,
  };
}

/** `element`, below a plan view. */
export function withPlan(view: PlanView, element: ReactElement): ReactElement {
  return <PlanViewProvider value={view}>{element}</PlanViewProvider>;
}
