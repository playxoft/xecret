import { describe, expect, it } from 'vitest';
import { PLANS } from '@xecret/core/entitlements';
import type { PlanFeatures } from '@xecret/core/entitlements';

import {
  AWAITING_REASON,
  blockFromRefusal,
  controlPlaneBlock,
  featureBlock,
  featureLockFrom,
  featureReason,
  freeAllowanceNotice,
  limitBlock,
  lockCopy,
  organizationCreateBlock,
} from './plan-gate';
import type { PlanBlock } from './plan-gate';
import { entitlementsFor } from './plan-test-view';

/**
 * The browser's half of every plan lock: the same `checkLimit` and
 * `hasFeature` the server refuses on, asked of the entitlements it resolved,
 * and the words a lock says to an owner and to everybody else.
 */

const OWNER = { owner: true, upgrades: true } as const;
const MEMBER = { owner: false, upgrades: true } as const;
const NOTHING_TO_BUY = { owner: true, upgrades: false } as const;

describe('limitBlock', () => {
  const free = entitlementsFor('free');

  it('locks at the ceiling, because the count is the one before the addition', () => {
    expect(limitBlock(free, 'projects', 5)).toEqual({
      kind: 'limit',
      reason: 'Your Free plan allows 5 projects.',
      upgradeTo: 'pro',
      limit: 5,
    });
  });

  it('stays open below it, the 80% warning included: a warning never locks', () => {
    expect(limitBlock(free, 'projects', 4)).toBeNull();
    expect(limitBlock(free, 'projects', 0)).toBeNull();
  });

  it('weighs a batch whole', () => {
    // Ten service tokens on Free: eight held, three asked for, is one too many.
    expect(limitBlock(free, 'serviceTokens', 8, 3)?.reason).toBe(
      'Your Free plan allows 10 service tokens.',
    );
    expect(limitBlock(free, 'serviceTokens', 8, 2)).toBeNull();
  });

  it('never locks a batch that adds nothing', () => {
    expect(limitBlock(free, 'secretsPerEnvironment', 9_999, 0)).toBeNull();
  });

  it('says whose number a raised ceiling is, and never that Free allows it', () => {
    const raised = entitlementsFor('free', { limits: { ...PLANS.free.limits, projects: 10 } });
    expect(limitBlock(raised, 'projects', 9)).toBeNull();
    expect(limitBlock(raised, 'projects', 10)?.reason).toBe(
      'This organisation’s limit is 10 projects.',
    );
  });

  it('says a ceiling of none as none', () => {
    expect(limitBlock(free, 'webhooks', 0)?.reason).toBe('Your Free plan includes no webhooks.');
  });

  it('names the plan per resource, as the server does', () => {
    expect(limitBlock(free, 'environmentsPerProject', 3)?.reason).toBe(
      'Your Free plan allows 3 environments per project.',
    );
    expect(limitBlock(free, 'secretsPerEnvironment', 250)?.reason).toBe(
      'Your Free plan allows 250 secrets per environment.',
    );
    expect(limitBlock(free, 'seats', 3)?.reason).toBe('Your Free plan allows 3 members.');
    expect(limitBlock(entitlementsFor('team'), 'projects', 60)).toMatchObject({
      reason: 'Your Team plan allows 60 projects.',
      upgradeTo: 'enterprise',
    });
  });

  it('never locks Enterprise, which has no ceiling to reach', () => {
    expect(limitBlock(entitlementsFor('enterprise'), 'projects', 1_000_000)).toBeNull();
  });

  it('locks every count while the organisation waits for a paid plan', () => {
    const awaiting = entitlementsFor('free', { awaitingPaidPlan: true, controlPlaneActive: false });
    expect(limitBlock(awaiting, 'projects', 0)).toEqual({
      kind: 'awaiting',
      reason: AWAITING_REASON,
      upgradeTo: 'pro',
    });
  });
});

describe('featureBlock', () => {
  it('names the cheapest plan that includes it', () => {
    expect(featureBlock(entitlementsFor('free'), 'secretReferencing')).toEqual({
      kind: 'feature',
      reason: 'Secret referencing is on Pro and above.',
      upgradeTo: 'pro',
    });
    expect(featureBlock(entitlementsFor('pro'), 'disableEnvExport')?.reason).toBe(
      'Turning off plaintext export is on Team and above.',
    );
    // Enterprise is the top: there is no "and above".
    expect(featureBlock(entitlementsFor('team'), 'customRoles')?.reason).toBe(
      'Custom roles are on Enterprise.',
    );
  });

  it('stays open where the plan includes it', () => {
    expect(featureBlock(entitlementsFor('pro'), 'secretReferencing')).toBeNull();
    expect(featureBlock(entitlementsFor('enterprise'), 'customRoles')).toBeNull();
  });

  it('locks even an included feature while the organisation waits for a plan', () => {
    const awaiting = entitlementsFor('free', { awaitingPaidPlan: true, controlPlaneActive: false });
    expect(featureBlock(awaiting, 'secretReferencing')?.kind).toBe('awaiting');
  });

  it('words every gated capability, in plain sentences', () => {
    for (const feature of Object.keys(PLANS.free.features) as (keyof PlanFeatures)[]) {
      const sentence = featureReason(feature, 'team');
      expect(sentence, feature).toMatch(/^[A-Z].+ (is|are) on Team and above\.$/);
    }
  });
});

describe('featureLockFrom, for a listing that carries its own answer', () => {
  it('is the same lock, from `{ enabled, upgradeTo }`', () => {
    expect(featureLockFrom('personalOverrides', { enabled: false, upgradeTo: 'pro' })).toEqual({
      kind: 'feature',
      reason: 'Personal overrides are on Pro and above.',
      upgradeTo: 'pro',
    });
    expect(featureLockFrom('personalOverrides', { enabled: true, upgradeTo: null })).toBeNull();
  });
});

describe('controlPlaneBlock', () => {
  it('is open while the control plane is', () => {
    expect(controlPlaneBlock(entitlementsFor('free'))).toBeNull();
  });

  it('says a lapsed subscription offers no upgrade, only renewal', () => {
    const lapsed = entitlementsFor('pro', { status: 'expired', controlPlaneActive: false });
    expect(controlPlaneBlock(lapsed)?.kind).toBe('notice');
  });
});

describe('lockCopy: what a lock says to whom', () => {
  const projects = limitBlock(entitlementsFor('free'), 'projects', 5) as PlanBlock;
  const referencing = featureBlock(entitlementsFor('free'), 'secretReferencing') as PlanBlock;

  it('offers an owner the plan that lifts a limit, and the plans page', () => {
    expect(lockCopy(projects, OWNER)).toEqual({
      reason: 'Your Free plan allows 5 projects.',
      next: 'Upgrade to Pro to add more.',
      link: true,
    });
  });

  it('tells anybody else to ask an owner, with no link', () => {
    expect(lockCopy(projects, MEMBER)).toEqual({
      reason: 'Your Free plan allows 5 projects.',
      next: 'Ask an owner to upgrade.',
      link: false,
    });
  });

  it('lets a feature’s own sentence name the plan', () => {
    expect(lockCopy(referencing, OWNER)).toEqual({
      reason: 'Secret referencing is on Pro and above.',
      next: null,
      link: true,
    });
    expect(lockCopy(referencing, MEMBER).next).toBe('Ask an owner to upgrade.');
  });

  it('says a ceiling of none is lifted to one', () => {
    const webhooks = limitBlock(entitlementsFor('free'), 'webhooks', 0) as PlanBlock;
    expect(lockCopy(webhooks, OWNER).next).toBe('Upgrade to Pro to add one.');
  });

  it('offers nothing where this deployment sells nothing', () => {
    expect(lockCopy(projects, NOTHING_TO_BUY)).toEqual({
      reason: 'Your Free plan allows 5 projects.',
      next: null,
      link: false,
    });
  });

  it('asks a member of an organisation awaiting a plan to have one chosen', () => {
    const awaiting = controlPlaneBlock(
      entitlementsFor('free', { awaitingPaidPlan: true, controlPlaneActive: false }),
    ) as PlanBlock;
    expect(lockCopy(awaiting, MEMBER).next).toBe('Ask an owner to choose one.');
    expect(lockCopy(awaiting, OWNER)).toEqual({ reason: AWAITING_REASON, next: null, link: true });
  });
});

describe('a refusal that arrived anyway', () => {
  it('says a project ceiling the way the lock would have, never the server’s long sentence', () => {
    const block = blockFromRefusal(
      { resource: 'projects', limit: 5, current: 5, plan: 'free', upgradeTo: 'pro' },
      'This organisation is on the Free plan, which allows 5 projects. The Pro plan allows more.',
    );
    expect(block.reason).toBe('Your Free plan allows 5 projects.');
    expect(lockCopy(block, OWNER).next).toBe('Upgrade to Pro to add more.');
  });

  it('reads the closed control plane, and a feature, by their resource', () => {
    expect(
      blockFromRefusal({
        resource: 'awaitingPaidPlan',
        limit: null,
        current: null,
        plan: 'free',
        upgradeTo: 'pro',
      }).reason,
    ).toBe(AWAITING_REASON);
    expect(
      blockFromRefusal({
        resource: 'environmentPromotion',
        limit: null,
        current: null,
        plan: 'free',
        upgradeTo: 'pro',
      }).reason,
    ).toBe('Environment promotion is on Pro and above.');
  });

  it('finds the plan above when the refusal named none it could read', () => {
    expect(
      blockFromRefusal({
        resource: 'projects',
        limit: 5,
        current: 5,
        plan: 'free',
        upgradeTo: null,
      }).upgradeTo,
    ).toBe('pro');
  });

  it('keeps the server’s words for anything it cannot name', () => {
    expect(
      blockFromRefusal(
        { resource: 'subscription', limit: null, current: null, plan: 'pro', upgradeTo: null },
        'This organisation’s subscription has ended.',
      ),
    ).toEqual({
      kind: 'notice',
      reason: 'This organisation’s subscription has ended.',
      upgradeTo: null,
    });
  });
});

describe('organisations per account', () => {
  const account = (freeOrganizations: number, awaitingOrganizations: number, upgrades = true) =>
    entitlementsFor('free', { account: { freeOrganizations, awaitingOrganizations }, upgrades });

  it('creates freely while the free allowance has room', () => {
    expect(organizationCreateBlock(account(1, 0))).toBeNull();
    expect(freeAllowanceNotice(account(1, 0))).toBeNull();
  });

  it('says, before creating, that a third Free organisation needs a paid plan', () => {
    expect(organizationCreateBlock(account(2, 0))).toBeNull();
    expect(freeAllowanceNotice(account(2, 0))).toBe(
      'You already have 2 free organisations. This one needs a paid plan before you can use it.',
    );
  });

  it('locks creating while one already waits for a plan, offering no upgrade', () => {
    const block = organizationCreateBlock(account(2, 1));
    expect(block?.kind).toBe('notice');
    expect(block?.reason).toBe(
      'You already have an organisation waiting for a paid plan. Choose a plan for it or delete it, then create another.',
    );
    expect(lockCopy(block as PlanBlock, OWNER).link).toBe(false);
  });

  it('creates freely, and new, while one waits but the account has fewer than two open', () => {
    // A lapsed organisation waits; the account has room for an open one again.
    expect(organizationCreateBlock(account(1, 1))).toBeNull();
    expect(freeAllowanceNotice(account(1, 1))).toBeNull();
  });

  it('applies none of it where the deployment takes no payments', () => {
    expect(organizationCreateBlock(account(2, 1, false))).toBeNull();
    expect(freeAllowanceNotice(account(2, 0, false))).toBeNull();
  });
});
