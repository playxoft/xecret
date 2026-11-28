import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  CurrentPlanMarker,
  PeriodToggle,
  PlanOption,
  PlanPrice,
  Reassurance,
} from './plan-chooser';
import {
  CHECKOUT_REASSURANCE,
  PAID_OFFERS,
  RECOMMENDED_LABEL,
  USD_PRICES,
  YEARLY_SAVING_UP_TO,
} from './upgrade-plans';

/**
 * The plan chooser's pieces, rendered alone: what the plans page and the
 * billing screen both draw. The screens' own tests pin who is shown what;
 * these pin what each piece says for each period, and that the radio card
 * is a real radio.
 */

const PAYMENTS = { taken: true, overageRate: '$0.01 per 1,000 secret fetches' };

function team() {
  const offer = PAID_OFFERS.find((candidate) => candidate.id === 'team');
  if (offer === undefined) throw new Error('no Team offer');
  return offer;
}

describe('PlanPrice', () => {
  it('shows the yearly rate, its saving and the yearly total', () => {
    const html = renderToStaticMarkup(createElement(PlanPrice, { plan: 'team', period: 'yearly' }));

    expect(html).toContain(USD_PRICES.team.yearly.price);
    expect(html).toContain('Save 36% on monthly');
    expect(html).toContain(USD_PRICES.team.yearly.note ?? 'a yearly total');
  });

  it('shows the monthly rate, and what yearly billing would save, in the same place', () => {
    const html = renderToStaticMarkup(createElement(PlanPrice, { plan: 'pro', period: 'monthly' }));

    expect(html).toContain(USD_PRICES.pro.monthly.price);
    expect(html).toContain('Save 37% with yearly billing');
    expect(html).not.toContain('billed yearly');
  });

  it('keeps the line’s height on Free, with nothing to save on', () => {
    const html = renderToStaticMarkup(createElement(PlanPrice, { plan: 'free', period: 'yearly' }));

    expect(html).toContain('$0');
    expect(html).not.toContain('Save');
    expect(html).toContain('aria-hidden="true" class="invisible');
  });
});

describe('PeriodToggle', () => {
  it('asks monthly or yearly, with the saving yearly really makes', () => {
    const html = renderToStaticMarkup(
      createElement(PeriodToggle, { value: 'yearly', onChange: () => {} }),
    );

    expect(html).toContain('aria-label="Billing period"');
    expect(html).toContain(`Save up to ${YEARLY_SAVING_UP_TO}%`);
    expect(html).toMatch(/aria-checked="true" tabindex="0"[^>]*>Yearly</);
  });
});

describe('PlanOption', () => {
  function render(over: { selected?: boolean; current?: boolean } = {}) {
    return renderToStaticMarkup(
      createElement(PlanOption, {
        offer: team(),
        group: 'plan',
        period: 'yearly',
        selected: over.selected ?? true,
        current: over.current ?? false,
        payments: PAYMENTS,
        onSelect: () => {},
      }),
    );
  }

  it('is a real radio, named by its label and described by its figure and list', () => {
    const html = render();

    expect(html).toMatch(/<input type="radio" id="plan-team"[^>]*name="plan"[^>]*value="team"/);
    expect(html).toContain('checked=""');
    expect(html).toContain('aria-describedby="plan-team-detail"');
    expect(html).toContain('<label for="plan-team"');
    expect(html).toContain('id="plan-team-detail"');
    expect(html).toContain('$12');
    expect(html).toContain('Everything in Pro, plus');
  });

  it('carries the recommendation in its name, or "Current plan" when it is the plan now', () => {
    const label = (html: string) => html.slice(html.indexOf('<label'), html.indexOf('</label>'));

    expect(label(render())).toContain(RECOMMENDED_LABEL);
    const current = label(render({ current: true }));
    expect(current).toContain('Current plan');
    expect(current).not.toContain(RECOMMENDED_LABEL);
  });

  it('is unchecked when another plan is chosen', () => {
    expect(render({ selected: false })).not.toContain('checked=""');
  });
});

describe('Reassurance', () => {
  it('lists every fact it is given, under the name it is given', () => {
    const html = renderToStaticMarkup(
      createElement(Reassurance, { items: CHECKOUT_REASSURANCE, label: 'About paying' }),
    );

    expect(html).toContain('<ul aria-label="About paying"');
    expect(html.match(/<li/g)).toHaveLength(CHECKOUT_REASSURANCE.length);
    for (const item of CHECKOUT_REASSURANCE) expect(html, item.id).toContain(item.text);
  });
});

describe('CurrentPlanMarker', () => {
  it('says the plan is current without drawing a control', () => {
    const html = renderToStaticMarkup(createElement(CurrentPlanMarker));

    expect(html).toContain('Your current plan');
    expect(html).not.toContain('<button');
  });
});
