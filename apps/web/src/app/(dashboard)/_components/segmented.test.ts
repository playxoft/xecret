import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { nextOptionIndex, Segmented } from './segmented';

/**
 * The pill's keyboard, as the ARIA radio group pattern has it: one tab stop,
 * on the chosen option, and the arrow keys (with Home and End) moving the
 * choice. The suite has no DOM, so the markup is read for the tab stops and
 * the key handling is pinned through the function that decides it.
 */

function render(value: 'monthly' | 'yearly' | 'weekly') {
  return renderToStaticMarkup(
    createElement(Segmented<'monthly' | 'yearly' | 'weekly'>, {
      label: 'Billing period',
      options: [
        { value: 'monthly', label: 'Monthly' },
        { value: 'yearly', label: 'Yearly' },
      ],
      value,
      onChange: () => {},
    }),
  );
}

describe('Segmented', () => {
  it('is a named radio group with one tab stop, on the chosen option', () => {
    const html = render('yearly');

    expect(html).toContain('role="radiogroup" aria-label="Billing period"');
    expect(html).toMatch(/aria-checked="false" tabindex="-1"[^>]*>Monthly</);
    expect(html).toMatch(/aria-checked="true" tabindex="0"[^>]*>Yearly</);
  });

  it('keeps the group in the tab order when nothing in it is chosen', () => {
    const html = render('weekly');

    expect(html).toMatch(/tabindex="0"[^>]*>Monthly</);
    expect(html).toMatch(/tabindex="-1"[^>]*>Yearly</);
  });
});

describe('nextOptionIndex', () => {
  it('moves forward and back with the arrow keys, wrapping round', () => {
    expect(nextOptionIndex('ArrowRight', 0, 2)).toBe(1);
    expect(nextOptionIndex('ArrowDown', 1, 2)).toBe(0);
    expect(nextOptionIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextOptionIndex('ArrowUp', 2, 3)).toBe(1);
  });

  it('goes to either end with Home and End', () => {
    expect(nextOptionIndex('Home', 2, 3)).toBe(0);
    expect(nextOptionIndex('End', 0, 3)).toBe(2);
  });

  it('leaves every other key, and an empty group, alone', () => {
    expect(nextOptionIndex('Enter', 0, 2)).toBeNull();
    expect(nextOptionIndex(' ', 0, 2)).toBeNull();
    expect(nextOptionIndex('Tab', 0, 2)).toBeNull();
    expect(nextOptionIndex('ArrowRight', 0, 0)).toBeNull();
  });
});
