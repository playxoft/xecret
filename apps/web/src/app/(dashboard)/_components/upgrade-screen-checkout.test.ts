import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, isValidElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authoritySummary } from '@xecret/core/authz';
import type { PromoCodeFieldProps } from '@/components/plans/promo-code-field';
import type { ButtonProps } from '@/components/ui';
import type { PromoCodePreviewPayload } from '@/server/schemas/admin';
import type { BillingStatusPayload } from '@/server/schemas/billing';
import type { SessionOrganization } from './session';

/**
 * The checkout buttons on the plans page, pressed.
 *
 * Every plan has two: one on its card and one at the head of its column in the
 * comparison table. They are one decision — the same plan, the same period —
 * so they must send the same checkout under the same idempotency key, and a
 * failure must be said beside whichever of the two was pressed.
 *
 * ── How a press is made without a DOM ──
 * The suite runs in Node with no DOM library, so nothing here clicks. Instead
 * the screen is rendered to static markup with `Button` wrapped to record its
 * props, and a recorded `onClick` is called directly — the same handler a click
 * would run, closing over the same ref and state setters. A server render
 * keeps no state between renders, so `useState` and `useRef` are replaced with
 * slots that persist across them: the screen is the only component in its
 * tree that calls either, so the slots are its own, in its own order. Pressing
 * then rendering again shows what the reader would see next.
 */

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0 }));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  function useState<T>(initial: T | (() => T)) {
    const slot = hooks.next++;
    if (!(slot in hooks.slots)) {
      hooks.slots[slot] = typeof initial === 'function' ? (initial as () => T)() : initial;
    }
    const set = (next: T | ((previous: T) => T)) => {
      hooks.slots[slot] =
        typeof next === 'function' ? (next as (previous: T) => T)(hooks.slots[slot] as T) : next;
    };
    return [hooks.slots[slot] as T, set] as const;
  }
  function useRef<T>(initial: T) {
    const slot = hooks.next++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = { current: initial };
    return hooks.slots[slot] as { current: T };
  }
  return { ...react, default: react, useState, useRef };
});

const pressed = vi.hoisted(() => ({ buttons: [] as ButtonProps[] }));

vi.mock('@/components/ui', async (importOriginal) => {
  const ui = await importOriginal<typeof import('@/components/ui')>();
  const react = await import('react');
  return {
    ...ui,
    Button: (props: ButtonProps) => {
      pressed.buttons.push(props);
      return react.createElement(ui.Button, props);
    },
  };
});

const server = vi.hoisted(() => ({
  posts: [] as { path: string; body: unknown; key: string | undefined }[],
  answer: 'fail' as 'fail' | 'hang',
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...real,
    api: {
      ...real.api,
      post: (path: string, body?: unknown, options?: { idempotencyKey?: string }) => {
        server.posts.push({ path, body, key: options?.idempotencyKey });
        if (server.answer === 'hang') return new Promise(() => {});
        return Promise.reject(
          new real.ApiError({
            code: 'internal_error',
            message: 'The payment provider did not answer.',
            status: 502,
            requestId: 'req-checkout-9',
          }),
        );
      },
    },
  };
});

const viewer = vi.hoisted(() => ({ organization: null as SessionOrganization | null }));

vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  useOrganization: () => viewer.organization,
}));

/** An owner's Free organisation, which may start a checkout. */
const FREE: BillingStatusPayload = {
  enabled: true,
  mode: 'live_mode',
  plan: 'free',
  status: 'active',
  interval: null,
  managedBy: 'none',
  grant: null,
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
  actions: { checkout: true, changePlan: false, portal: false, promoCode: false },
};

/** What the billing read answers: `FREE`, unless a case says otherwise. */
const served = vi.hoisted(() => ({ billing: null as BillingStatusPayload | null }));

vi.mock('../_lib/use-api-resource', () => ({
  useApiResource: (path: string | null) =>
    path === null
      ? { data: null, error: null, loading: false, reload: async () => {} }
      : {
          data: { billing: served.billing ?? FREE },
          error: null,
          loading: false,
          reload: async () => {},
        },
}));

/**
 * "Have a code?", replaced by a recorder of what the screen handed it. The
 * field's own checking is its own test's; what is pinned here is what the
 * screen does with a discount once the field hands one up — so the case calls
 * `onApplied` exactly as the field would after the server's answer.
 */
const field = vi.hoisted(() => ({ props: null as PromoCodeFieldProps | null }));

vi.mock('@/components/plans/promo-code-field', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/plans/promo-code-field')>();
  return {
    ...real,
    PromoCodeField: (props: PromoCodeFieldProps) => {
      field.props = props;
      return null;
    },
  };
});

const { UpgradeScreen } = await import('./upgrade-screen');

const FAILED = 'Nothing was changed.';

function render(): string {
  hooks.next = 0;
  pressed.buttons = [];
  return renderToStaticMarkup(
    createElement(UpgradeScreen, {
      orgSlug: 'acme',
      returnedFromCheckout: false,
      payments: { taken: true, overageRate: '$0.01 per 1,000 secret fetches' },
    }),
  );
}

/** A button's words, without its icon. */
function words(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(words).join('');
  if (isValidElement(children)) return '';
  return '';
}

/** Press a checkout button — on a card, or at the head of a table column — and let it settle. */
async function press(label: string, where: 'card' | 'table'): Promise<void> {
  const button = pressed.buttons.find(
    (candidate) =>
      words(candidate.children).trim() === label &&
      (candidate.size === 'sm') === (where === 'table'),
  );
  if (button?.onClick === undefined) throw new Error(`no ${where} button "${label}" to press`);
  button.onClick({} as never);
  await new Promise((settle) => setTimeout(settle, 0));
}

/** The page above the comparison table: the cards. */
function cards(html: string): string {
  return html.slice(0, html.indexOf('aria-label="Plan comparison"'));
}

/** The comparison table's header row. */
function tableHead(html: string): string {
  const table = html.slice(html.indexOf('aria-label="Plan comparison"'));
  return table.slice(0, table.indexOf('</thead>'));
}

beforeEach(() => {
  hooks.slots = [];
  server.posts = [];
  server.answer = 'fail';
  served.billing = null;
  field.props = null;
  viewer.organization = {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    role: 'owner',
    authority: { role: 'owner', customRole: null, ...authoritySummary({ role: 'owner' }) },
  };
});

describe('the plans page’s two checkout buttons for one plan', () => {
  it('start the same checkout under the same idempotency key', async () => {
    render();
    await press('Upgrade to Team', 'card');
    render();
    await press('Upgrade to Team', 'table');

    expect(server.posts).toHaveLength(2);
    const [fromCard, fromTable] = server.posts;
    expect(fromCard).toEqual({
      path: '/api/orgs/acme/billing/checkout',
      body: { plan: 'team', interval: 'yearly' },
      key: expect.any(String),
    });
    // One decision, wherever it was pressed: a retry, not a second checkout.
    expect(fromTable?.body).toEqual(fromCard?.body);
    expect(fromTable?.key).toBe(fromCard?.key);

    // Another plan is another decision, with a key of its own.
    render();
    await press('Upgrade to Pro', 'table');
    expect(server.posts[2]?.body).toEqual({ plan: 'pro', interval: 'yearly' });
    expect(server.posts[2]?.key).not.toBe(fromCard?.key);
  });

  it('say why a checkout failed beside the button that was pressed', async () => {
    render();
    await press('Upgrade to Team', 'table');
    let html = render();

    expect(tableHead(html)).toContain(FAILED);
    expect(tableHead(html)).toContain('req-checkout-9');
    expect(cards(html)).not.toContain(FAILED);

    // The same failure from the card moves the sentence to the card.
    await press('Upgrade to Team', 'card');
    html = render();
    expect(cards(html)).toContain(FAILED);
    expect(tableHead(html)).not.toContain(FAILED);
  });

  it('hold every other checkout while one is on its way', async () => {
    server.answer = 'hang';
    render();
    await press('Upgrade to Team', 'table');
    render();

    const team = pressed.buttons.filter((b) => words(b.children).trim() === 'Upgrade to Team');
    const pro = pressed.buttons.filter((b) => words(b.children).trim() === 'Upgrade to Pro');
    // Both of Team's buttons show the one request in flight; Pro's wait.
    expect(team.map((b) => b.loading)).toEqual([true, true]);
    expect(pro.map((b) => b.disabled)).toEqual([true, true]);
    expect(server.posts).toHaveLength(1);
  });
});

/** 50% off Team, as the server answers a checked discount code. */
const TEAM_HALF_OFF: PromoCodePreviewPayload = {
  code: 'TEAMHALF',
  kind: 'discount',
  summary: '50% off Team for 3 months',
  plan: null,
  plans: ['team'],
};

describe('a discount code on the plans page', () => {
  beforeEach(() => {
    served.billing = { ...FREE, actions: { ...FREE.actions, promoCode: true } };
  });

  it('is offered only where the billing read allows a code', () => {
    served.billing = FREE;
    render();
    expect(field.props).toBeNull();

    served.billing = { ...FREE, actions: { ...FREE.actions, promoCode: true } };
    render();
    expect(field.props?.orgSlug).toBe('acme');
  });

  it('goes with a checkout for a plan it covers, and not with one for another', async () => {
    render();
    field.props?.onApplied(TEAM_HALF_OFF);
    const html = render();

    expect(cards(html)).toContain('TEAMHALF comes off at checkout.');
    expect(cards(html)).toContain('TEAMHALF does not apply to Pro.');

    await press('Upgrade to Team', 'card');
    render();
    await press('Upgrade to Pro', 'card');

    expect(server.posts.map((post) => post.body)).toEqual([
      { plan: 'team', interval: 'yearly', promoCode: 'TEAMHALF' },
      { plan: 'pro', interval: 'yearly' },
    ]);
  });

  it('is part of the decision: with and without it are two keys', async () => {
    render();
    await press('Upgrade to Team', 'card');

    render();
    field.props?.onApplied(TEAM_HALF_OFF);
    render();
    await press('Upgrade to Team', 'card');

    // And the same choice with the same code again is a retry, under its key.
    render();
    await press('Upgrade to Team', 'table');

    const [plain, withCode, retry] = server.posts;
    expect(plain?.body).toEqual({ plan: 'team', interval: 'yearly' });
    expect(withCode?.body).toEqual({ plan: 'team', interval: 'yearly', promoCode: 'TEAMHALF' });
    expect(withCode?.key).not.toBe(plain?.key);
    expect(retry?.key).toBe(withCode?.key);

    // Removed, it is a third decision rather than the first one again.
    render();
    field.props?.onApplied(null);
    render();
    await press('Upgrade to Team', 'card');
    expect(server.posts[3]?.body).toEqual({ plan: 'team', interval: 'yearly' });
    expect(server.posts[3]?.key).not.toBe(withCode?.key);
  });
});
