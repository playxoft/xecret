import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authoritySummary } from '@xecret/core/authz';
import type { OrgRole } from '@xecret/core/authz';
import type { BillingStatusPayload } from '@/server/schemas/billing';
import type { SessionOrganization } from './session';

/**
 * The plans page, rendered to static markup for an owner in each billing state
 * and for the members who cannot see the plan at all. A server render runs no
 * effects, so the data hook answers with what the API would.
 *
 * What is pinned is who is offered what: an owner a checkout or a link to the
 * billing screen, everybody else the same plans and a sentence naming who can
 * change them — reached from the session's authority *or* from the server's
 * `forbidden`, and never from any other refusal that happens to be a 403.
 */

const viewer = vi.hoisted(() => ({ organization: null as SessionOrganization | null }));

vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  useOrganization: () => viewer.organization,
}));

const resource = vi.hoisted(() => ({
  current: { data: null as unknown, error: null as unknown, loading: false },
  paths: [] as (string | null)[],
}));

vi.mock('../_lib/use-api-resource', () => ({
  useApiResource: (path: string | null) => {
    resource.paths.push(path);
    return path === null
      ? { data: null, error: null, loading: false, reload: async () => {} }
      : { ...resource.current, reload: async () => {} };
  },
}));

const { ApiError } = await import('@/lib/api');
const { UpgradeScreen } = await import('./upgrade-screen');

function organization(role: OrgRole): SessionOrganization {
  return {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    role,
    authority: { role, customRole: null, ...authoritySummary({ role }) },
  };
}

function billing(over: Partial<BillingStatusPayload> = {}): BillingStatusPayload {
  return {
    enabled: true,
    mode: 'live_mode',
    plan: 'free',
    status: 'active',
    interval: null,
    managedBy: 'none',
    seats: { billed: 1, seated: 2, pendingInvitations: 0, minimum: 1 },
    currency: null,
    renewsAt: null,
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    renewalAmount: null,
    regionLock: null,
    usage: {
      periodStart: '2026-11-01T00:00:00.000Z',
      secretFetches: 1_200,
      includedFetches: 20_000,
      unitsReported: 0,
      overageRate: '$0.01 per 1,000 fetches',
    },
    warnings: [],
    addons: { saml: false },
    actions: { checkout: true, changePlan: false, portal: false },
    ...over,
  };
}

function answers(payload: BillingStatusPayload): void {
  resource.current = { data: { billing: payload }, error: null, loading: false };
}

function fails(error: unknown): void {
  resource.current = { data: null, error, loading: false };
}

/** `OVERAGE_RATE_TEXT`, as the server component hands it down. */
const RATE = '$0.01 per 1,000 secret fetches past the allowance ($1 per 100,000)';

function render(
  role: OrgRole,
  {
    returnedFromCheckout = false,
    taken = true,
  }: { returnedFromCheckout?: boolean; taken?: boolean } = {},
): string {
  viewer.organization = organization(role);
  return renderToStaticMarkup(
    createElement(UpgradeScreen, {
      orgSlug: 'acme',
      returnedFromCheckout,
      payments: { taken, overageRate: RATE },
    }),
  );
}

const ASK_AN_OWNER = 'Only an organisation owner can change the plan';

beforeEach(() => {
  resource.paths = [];
  answers(billing());
});

describe('UpgradeScreen, for an owner', () => {
  it('reads the plan and offers a checkout for each paid plan from Free', () => {
    const html = render('owner');

    expect(resource.paths).toContain('/api/orgs/acme/billing');
    expect(html).toContain('Upgrade to Team');
    expect(html).toContain('Upgrade to Pro');
    expect(html).toContain('On Free');
    expect(html).toContain('Your current plan');
    expect(html).not.toContain(ASK_AN_OWNER);
  });

  it('opens on the yearly rate, with the saving said', () => {
    const html = render('owner');

    expect(html).toContain('$12');
    expect(html).toContain('$144 per member, billed yearly');
    expect(html).toContain('Save up to 37%');
    expect(html).toContain('Billed from 3 members up');
  });

  it('says what a fetch past the allowance costs, beside the allowance', () => {
    const html = render('owner');

    expect(html).toContain('200,000 secret fetches a month included');
    expect(html).toContain(`Fetches past it keep working, and are billed at ${RATE}.`);
    expect(html).toContain('Fetches past it keep working, and are not billed.');
    // And the reassurance says the same, rather than that machines cost nothing.
    expect(html).toContain('Machines never take a seat');
    expect(html).toContain(`on a paid plan it is billed at ${RATE}`);
    expect(html).not.toContain('never add to the bill');
  });

  it('sends a subscriber to the billing screen to switch, with the period chosen here', () => {
    answers(
      billing({
        plan: 'pro',
        interval: 'yearly',
        managedBy: 'checkout',
        actions: { checkout: false, changePlan: true, portal: true },
      }),
    );
    const html = render('owner');

    expect(html).not.toContain('Upgrade to');
    expect(html).toContain('Switch to Team');
    // Yearly is what the page opens on, so yearly is what the link carries.
    expect(html).toContain('href="/app/acme/settings/billing?plan=team&amp;interval=yearly"');
    expect(html).toContain('On Pro');
    // Pro is the current card, and only it says so.
    expect(html.match(/Your current plan/g)).toHaveLength(1);
  });

  it('names what the plan above would allow when a ceiling is near', () => {
    answers(billing({ warnings: [{ resource: 'projects', limit: 5, current: 5, atLimit: true }] }));
    const html = render('owner');

    expect(html).toContain('Acme is close to a limit');
    expect(html).toContain('5 projects of 5. Pro allows 25.');
  });

  it('measures a raised ceiling against the plans that would actually lift it', () => {
    // Support allowed this Free organisation 40 projects; Pro's 25 is fewer.
    answers(
      billing({ warnings: [{ resource: 'projects', limit: 40, current: 40, atLimit: true }] }),
    );
    const html = render('owner');

    expect(html).toContain('40 projects of 40. Team allows 100.');
    expect(html).not.toContain('Pro allows 25');
  });

  it('offers nothing to buy on a plan support manages', () => {
    answers(
      billing({
        plan: 'enterprise',
        managedBy: 'support',
        actions: { checkout: false, changePlan: false, portal: false },
      }),
    );
    const html = render('owner');

    expect(html).toContain('Managed by xecret support');
    expect(html).not.toContain('Upgrade to');
    expect(html).not.toContain('Switch to');
  });

  it('offers nothing to buy where the installation takes no payments', () => {
    answers(
      billing({
        enabled: false,
        mode: null,
        actions: { checkout: false, changePlan: false, portal: false },
      }),
    );
    const html = render('owner');

    expect(html).toContain('This installation does not take payments');
    expect(html).not.toContain('Upgrade to');
  });

  it('points a return from checkout at the billing screen, which watches for the payment', () => {
    const html = render('owner', { returnedFromCheckout: true });

    expect(html).toContain('Finishing your upgrade');
    expect(html).toContain('href="/app/acme/settings/billing?checkout=returned"');
  });

  it('says the plan could not be read when the server fails for any other reason', () => {
    fails(
      new ApiError({ code: 'internal_error', message: 'Boom.', status: 500, requestId: 'req-1' }),
    );
    const html = render('owner');

    expect(html).toContain('Could not load this organisation’s plan');
    expect(html).not.toContain(ASK_AN_OWNER);
    expect(html).not.toContain('Upgrade to');
    // The plans are still there to read.
    expect(html).toContain('$12');
  });

  it('promises no trial, as the pricing page offers none', () => {
    expect(render('owner')).not.toMatch(/\btrial\b/i);
  });

  it('sells per-environment access nowhere, and custom roles only where they are gated', () => {
    const html = render('owner');

    // Nothing enforces the per-environment gate, so nothing here sells it.
    expect(html).not.toMatch(/per-environment (access|grants)/i);
    expect(html).not.toContain('everyone can read every environment');
    // Custom roles are refused below Enterprise, so they are named there.
    expect(html).toContain('Custom roles, no ceiling on projects');
  });
});

describe('UpgradeScreen, where the installation takes no payments', () => {
  it.each(['owner', 'developer'] as const)(
    'compares the plans for a %s with no price, button or owner to ask',
    (role) => {
      const html = render(role, { taken: false });

      // Nothing is sold, so nothing is asked about the plan.
      expect(resource.paths).toEqual([null]);
      expect(html).toContain('This installation does not take payments');
      expect(html).toContain('Plans for Acme');
      expect(html).toContain('What each plan unlocks');
      expect(html).toContain('200,000 secret fetches a month included');
      // No figure, saving, seat floor, button, or person to ask.
      expect(html).not.toMatch(/\$\d/);
      expect(html).not.toContain('Save up to');
      expect(html).not.toContain('Billed from');
      expect(html).not.toContain('billed at');
      expect(html).not.toContain('Upgrade to');
      expect(html).not.toContain('Talk to us');
      expect(html).not.toContain('Recommended');
      expect(html).not.toContain(ASK_AN_OWNER);
    },
  );
});

describe('UpgradeScreen, for everybody else', () => {
  it.each(['admin', 'developer', 'viewer'] as const)(
    'shows a %s the plans and who can change them, and asks nothing',
    (role) => {
      const html = render(role);

      expect(resource.paths).toEqual([null]);
      expect(html).toContain(ASK_AN_OWNER);
      expect(html).toContain('Ask an owner of Acme');
      // The whole page, not a dead end.
      expect(html).toContain('$12');
      expect(html).toContain('Recommended');
      expect(html).toContain('What each plan unlocks');
      // Nothing to press, and no plan marked as theirs — it is unknowable.
      expect(html).not.toContain('Upgrade to');
      expect(html).not.toContain('Switch to');
      expect(html).not.toContain('Your current plan');
      expect(html).not.toContain('href="/app/acme/settings/billing"');
    },
  );

  it('lands an owner the server refuses on the same calm sentence, not an error', () => {
    fails(
      new ApiError({
        code: 'forbidden',
        message: 'You do not have permission to do that.',
        status: 403,
        requestId: 'req-2',
      }),
    );
    const html = render('owner');

    expect(html).toContain(ASK_AN_OWNER);
    expect(html).not.toContain('Could not load');
    expect(html).not.toContain('You do not have access');
    expect(html).not.toContain('Upgrade to');
  });

  it('does not read every 403 as "not an owner"', () => {
    // `sso_required` is a 403 too, with an entirely different remedy.
    fails(
      new ApiError({
        code: 'sso_required',
        message: 'This organisation requires single sign-on.',
        status: 403,
        requestId: 'req-3',
      }),
    );
    const html = render('owner');

    expect(html).not.toContain(ASK_AN_OWNER);
  });
});
