import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authoritySummary } from '@xecret/core/authz';
import { MINIMUM_SEATS } from '@xecret/core/entitlements';
import type { BillingStatusPayload } from '@/server/schemas/billing';
import type { SessionOrganization } from './session';

/**
 * The billing screen's change form, rendered to static markup for an owner
 * with a subscription — the form the plans page's "Switch to …" lands on —
 * and for an owner on Free, for whom it is the checkout.
 *
 * Pinned: it opens on the plan and period it was sent, so the choice made on
 * the plans page survives the trip. It sells nothing the server does not gate:
 * the sentence under the plans is the seat floor and no more, because custom
 * roles are Enterprise's and no plan gates per-environment access (see the
 * note at the top of `upgrade-plans.ts`). And it puts the plans to the owner
 * as the plans page does: a heading about the team, the two plans side by side
 * as radio cards with their figures, one button that says what it does, and
 * the facts about paying beside it.
 */

const viewer = vi.hoisted(() => ({ organization: null as SessionOrganization | null }));

vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  useOrganization: () => viewer.organization,
}));

const resource = vi.hoisted(() => ({ billing: null as BillingStatusPayload | null }));

vi.mock('../_lib/use-api-resource', () => ({
  useApiResource: (path: string | null) => ({
    data: path === null || resource.billing === null ? null : { billing: resource.billing },
    error: null,
    loading: false,
    reload: async () => {},
  }),
}));

const { Toaster } = await import('@/components/ui');
const { BillingScreen } = await import('./billing-screen');
const {
  CHANGE_PITCH,
  CHANGE_REASSURANCE,
  CHECKOUT_REASSURANCE,
  PLAN_PITCH,
  RECOMMENDED_LABEL,
  trialNote,
  TRIALING_CHANGE_NOTE,
} = await import('./upgrade-plans');

const OWNER: SessionOrganization = {
  id: 'org-1',
  name: 'Acme',
  slug: 'acme',
  role: 'owner',
  authority: { role: 'owner', customRole: null, ...authoritySummary({ role: 'owner' }) },
};

/** A Pro subscription on `interval`, changeable from here — yearly unless said otherwise. */
function subscribed(interval: 'monthly' | 'yearly' = 'yearly'): BillingStatusPayload {
  return {
    enabled: true,
    mode: 'live_mode',
    plan: 'pro',
    status: 'active',
    interval,
    managedBy: 'checkout',
    grant: null,
    seats: { billed: 4, seated: 4, pendingInvitations: 0, minimum: 1 },
    currency: 'USD',
    renewsAt: '2027-11-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    hold: null,
    renewalAmount: '$240.00',
    regionLock: null,
    usage: {
      periodStart: '2026-11-01T00:00:00.000Z',
      secretFetches: 1_000,
      includedFetches: 200_000,
      unitsReported: 0,
      overageRate: '$0.01 per 1,000 secret fetches past the allowance ($1 per 100,000)',
    },
    warnings: [],
    addons: { saml: false },
    actions: { checkout: false, changePlan: true, portal: true, promoCode: false },
  };
}

function render(initialChoice?: { plan?: 'pro' | 'team'; interval?: 'monthly' | 'yearly' }) {
  return renderToStaticMarkup(
    createElement(
      Toaster,
      null,
      createElement(BillingScreen, {
        orgSlug: 'acme',
        returnedFromCheckout: false,
        ...(initialChoice === undefined ? {} : { initialChoice }),
      }),
    ),
  );
}

/** Whether the period pill's option labelled `label` is the checked one. */
function checked(html: string, label: string): boolean {
  return new RegExp(`aria-checked="true"[^>]*>${label}<`).test(html);
}

/** The plans offered as radio cards, and which of them is chosen. */
function planRadios(html: string): { offered: string[]; chosen: string[] } {
  const inputs = html.match(/<input type="radio"[^>]*>/g) ?? [];
  const value = (input: string) => /value="([^"]+)"/.exec(input)?.[1] ?? '';
  return {
    offered: inputs.map(value),
    chosen: inputs.filter((input) => input.includes('checked=""')).map(value),
  };
}

/** The markup from the button on: where the facts beside it are drawn. */
function fromButton(html: string, label: string): string {
  const at = html.indexOf(label);
  if (at < 0) throw new Error(`no "${label}" rendered`);
  return html.slice(at);
}

beforeEach(() => {
  viewer.organization = OWNER;
  resource.billing = subscribed();
});

describe('BillingScreen’s change form', () => {
  it('opens on the plan and period the plans page sent', () => {
    const html = render({ plan: 'team', interval: 'monthly' });

    expect(planRadios(html).chosen).toEqual(['team']);
    expect(checked(html, 'Monthly')).toBe(true);
    expect(checked(html, 'Yearly')).toBe(false);
  });

  it('opens as it always did when sent nothing', () => {
    // Monthly, because yearly is also the form's fallback: only a monthly
    // subscriber can show the default follows the subscription's own period.
    resource.billing = subscribed('monthly');
    const html = render();

    // The next rung up from Pro, on the subscription's own period.
    expect(planRadios(html).chosen).toEqual(['team']);
    expect(checked(html, 'Monthly')).toBe(true);
    expect(checked(html, 'Yearly')).toBe(false);
  });

  it('leads a subscriber with when a move lands, not "Change plan"', () => {
    const html = render();

    expect(html).toContain(CHANGE_PITCH.heading);
    expect(html).toContain(CHANGE_PITCH.subhead);
    expect(html).not.toContain('>Change plan<');
    expect(html).not.toContain(PLAN_PITCH.heading);
  });

  it('shows Pro and Team side by side as radio cards, the current one marked', () => {
    const html = render();

    // Real radios in a fieldset: one tab stop, arrow keys, no script.
    expect(html).toContain('<fieldset');
    expect(html).toContain('<legend class="sr-only">Plan</legend>');
    expect(planRadios(html).offered).toEqual(['pro', 'team']);
    // Each card's figure, for the period showing.
    expect(html).toContain('$5');
    expect(html).toContain('$12');
    expect(html).toContain('$144 per member, billed yearly');
    // Pro is this subscription's, and its card says so in a chip (the
    // "Current plan" card above is a heading); Team keeps its recommendation.
    const pro = html.slice(html.indexOf('value="pro"'), html.indexOf('value="team"'));
    expect(pro).toContain('Current plan</span>');
    expect(pro).not.toContain(RECOMMENDED_LABEL);
    expect(html.slice(html.indexOf('value="team"'))).toContain(RECOMMENDED_LABEL);
  });

  it('names the change on the button: the plan and its period, or the period alone', () => {
    expect(render()).toContain('Review the switch to Team, billed yearly');
    expect(render({ plan: 'pro', interval: 'monthly' })).toContain(
      'Review the switch to monthly billing',
    );
    const same = render({ plan: 'pro', interval: 'yearly' });
    expect(same).toContain('This is your current plan');
    expect(same).not.toContain('Review the switch');
  });

  it('says beside the button that nothing changes before the confirm, and nothing is deleted', () => {
    const after = fromButton(render(), 'Review the switch to');

    expect(after).toContain('aria-label="About changing plan"');
    for (const item of CHANGE_REASSURANCE) expect(after, item.id).toContain(item.text);
    // A subscriber is not sold a checkout, so neither is told about one.
    for (const item of CHECKOUT_REASSURANCE) expect(after, item.id).not.toContain(item.text);
  });

  it('offers a subscriber no trial, and tells one in a trial what moving up does to it', () => {
    expect(render()).not.toMatch(/free trial/i);

    resource.billing = {
      ...subscribed('monthly'),
      status: 'trialing',
      trialEndsAt: '2026-12-05T00:00:00.000Z',
    };
    const trialing = render();
    expect(trialing).toContain(TRIALING_CHANGE_NOTE);
    expect(trialing).not.toContain(trialNote('team') ?? 'no trial note');
  });

  it('says what the subscription is billed in where it is not the figures’ currency', () => {
    resource.billing = { ...subscribed(), currency: 'EUR' };
    expect(render()).toContain('This subscription is billed in EUR.');

    resource.billing = subscribed();
    expect(render()).not.toContain('This subscription is billed in');
  });

  it('says only the seat floor under Team — no roles, no per-environment access', () => {
    const html = render({ plan: 'team' });

    // Read from the engine, so a floor raised in `plans.ts` is checked at its
    // new value rather than leaving a stale "3" passing here.
    expect(html).toContain(`Team is billed from ${MINIMUM_SEATS.team} members up.`);
    expect(html).not.toMatch(/per-environment/i);
    expect(html).not.toMatch(/\broles\b/i);
  });

  it('does not describe Pro by a gate nothing enforces', () => {
    const html = render({ plan: 'pro' });

    expect(html).toContain('Pro has no seat minimum.');
    expect(html).not.toMatch(/every environment/i);
  });

  it('says machines never take a seat, not that they never cost anything', () => {
    const html = render();

    expect(html).toContain('Service tokens and CI never take a seat.');
    expect(html).not.toContain('never cost anything');
  });
});

describe('BillingScreen’s hold banner', () => {
  it('names the date a trial that ended unpaid moves to Free — never the fourteen days of a paying hold', () => {
    resource.billing = {
      ...subscribed('monthly'),
      status: 'on_hold',
      hold: { endsAt: '2026-11-27T10:00:00.000Z', afterTrial: true },
    };
    const trial = render();
    expect(trial).toContain('The trial has ended and its first payment did not go through');
    expect(trial).not.toContain('14 days');

    resource.billing = {
      ...subscribed('monthly'),
      status: 'on_hold',
      hold: { endsAt: '2026-12-09T10:00:00.000Z', afterTrial: false },
    };
    const renewal = render();
    expect(renewal).toContain('Your card was declined.');
    expect(renewal).toContain('14 days on hold');
  });
});

/** A Team plan an admin gave, or a free-plan code redeemed: nothing at Dodo behind it. */
function complimentary(endsAt: string | null): BillingStatusPayload {
  return {
    ...subscribed(),
    plan: 'team',
    // The schema keeps an interval on every paid plan, a grant's included.
    interval: 'yearly',
    managedBy: 'support',
    grant: { endsAt, note: 'Launch partner' },
    currency: null,
    renewsAt: null,
    renewalAmount: null,
    actions: { checkout: false, changePlan: false, portal: false, promoCode: false },
  };
}

describe('BillingScreen, on a complimentary plan', () => {
  it('says it is complimentary, until when, and where it came from', () => {
    resource.billing = complimentary('2027-03-01T00:00:00.000Z');
    const html = render();

    expect(html).toContain('Complimentary Team plan');
    expect(html).toContain('until ');
    expect(html).toContain('Launch partner');
    expect(html).toContain('When it ends the organisation moves to Free, and nothing is deleted.');
    // It replaces the support notice, rather than sitting under it.
    expect(html).not.toContain('Managed by xecret support');
  });

  it('says so when it has no end', () => {
    resource.billing = complimentary(null);
    const html = render();

    expect(html).toContain('with no end date');
    expect(html).toContain('No end date');
    expect(html).not.toContain('When it ends');
  });

  it('invents no invoice: no billing period, no billed seats, no overage charge', () => {
    resource.billing = complimentary(null);
    const html = render();

    expect(html).toContain('· complimentary');
    expect(html).not.toContain('billed yearly');
    expect(html).not.toMatch(/\d+ billed/);
    expect(html).not.toContain('on the next invoice');
  });

  it('keeps the support notice for a plan arranged without a grant', () => {
    resource.billing = { ...complimentary(null), plan: 'enterprise', grant: null };
    const html = render();

    expect(html).toContain('Managed by xecret support');
    expect(html).not.toContain('Complimentary');
  });
});

/** An owner's Free organisation, which may check out — and, where the server says so, use a code. */
function free(promoCode: boolean): BillingStatusPayload {
  return {
    ...subscribed(),
    plan: 'free',
    interval: null,
    managedBy: 'none',
    seats: { billed: 1, seated: 2, pendingInvitations: 0, minimum: 1 },
    currency: null,
    renewsAt: null,
    renewalAmount: null,
    actions: { checkout: true, changePlan: false, portal: false, promoCode },
  };
}

describe('BillingScreen’s "Have a code?"', () => {
  it('is offered beside the checkout when the server allows a code', () => {
    resource.billing = free(true);
    const html = render();

    expect(html).toContain('Have a code?');
    // In the plan card, above the button it feeds.
    expect(html.indexOf('Have a code?')).toBeGreaterThan(-1);
    expect(html.indexOf('Have a code?')).toBeLessThan(html.indexOf('Upgrade to Team'));
  });

  it('is not offered when it does not', () => {
    resource.billing = free(false);
    expect(render()).not.toContain('Have a code?');

    resource.billing = subscribed();
    expect(render()).not.toContain('Have a code?');
  });

  it('is offered on its own where nothing is sold, for a free-plan code', () => {
    resource.billing = {
      ...free(true),
      enabled: false,
      mode: null,
      actions: { checkout: false, changePlan: false, portal: false, promoCode: true },
    };
    const html = render();

    expect(html).toContain('Have a code?');
    expect(html).not.toContain('Upgrade to');
    expect(html).not.toContain('aria-label="About paying"');
  });
});

describe('BillingScreen’s checkout, for an owner on Free', () => {
  beforeEach(() => {
    resource.billing = free(false);
  });

  it('leads with what the team gets, not "Choose a plan"', () => {
    const html = render();

    expect(html).toContain(PLAN_PITCH.heading);
    expect(html).toContain(PLAN_PITCH.subhead);
    expect(html).not.toContain('Choose a plan');
  });

  it('opens on Team, yearly, recommended, with the saving each plan really makes', () => {
    const html = render();

    expect(planRadios(html)).toEqual({ offered: ['pro', 'team'], chosen: ['team'] });
    expect(checked(html, 'Yearly')).toBe(true);
    // Nothing is this organisation's yet, so no card is marked current.
    expect(html).not.toContain('Current plan</span>');
    expect(html).toContain(RECOMMENDED_LABEL);
    expect(html).toContain('Save up to 37%');
    expect(html).toContain('Save 37% on monthly');
    expect(html).toContain('Save 36% on monthly');
  });

  it('says on monthly what yearly billing would save', () => {
    const html = render({ interval: 'monthly' });

    expect(html).toContain('$8');
    expect(html).toContain('$19');
    expect(html).toContain('Save 37% with yearly billing');
    expect(html).toContain('Save 36% with yearly billing');
    expect(html).not.toContain('on monthly');
  });

  it('names the plan on the one button, and says beside it how paying works', () => {
    const html = render();
    const after = fromButton(html, 'Upgrade to Team');

    expect(html).not.toContain('Continue to checkout');
    expect(after).toContain('aria-label="About paying"');
    for (const item of CHECKOUT_REASSURANCE) expect(after, item.id).toContain(item.text);

    expect(render({ plan: 'pro' })).toContain('Upgrade to Pro');
  });

  it('says Team may start with a free trial, as a condition, and Pro never', () => {
    const note = trialNote('team');
    expect(note).not.toBeNull();
    expect(render()).toContain(note ?? '');

    const pro = render({ plan: 'pro' });
    expect(pro).not.toMatch(/free trial/i);
  });
});
