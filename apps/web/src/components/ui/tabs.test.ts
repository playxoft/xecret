import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Tabs, TabsList, TabsTrigger } from './tabs';

/**
 * The tab bar, rendered to static markup — what decides whether it scrolls,
 * and which way. It scrolls sideways when the tabs outrun the screen, and
 * never up and down: the vertical scrollbar the admin screen's bar used to
 * show came from each tab reaching a pixel past the bottom of a box that
 * scrolls, so what is pinned is that nothing in the bar reaches past it.
 */

function bar(): string {
  return renderToStaticMarkup(
    createElement(
      Tabs,
      { defaultValue: 'one' },
      createElement(
        TabsList,
        { 'aria-label': 'Example' },
        createElement(TabsTrigger, { value: 'one' }, 'One'),
        createElement(TabsTrigger, { value: 'two' }, 'Two'),
      ),
    ),
  );
}

function classesOf(html: string, pattern: RegExp): string[] {
  return (pattern.exec(html)?.[1] ?? '').split(' ');
}

describe('the tab bar', () => {
  const html = bar();
  const list = classesOf(html, /<div role="tablist"[^>]*class="([^"]*)"/);
  const triggers = [...html.matchAll(/<button [^>]*class="([^"]*)"/g)].map((match) =>
    (match[1] ?? '').split(' '),
  );

  it('scrolls sideways when the tabs do not fit, and never vertically', () => {
    expect(list).toEqual(expect.arrayContaining(['overflow-x-auto', 'overflow-y-hidden']));
  });

  it('draws its hairline inside the list rather than as a border the tabs hang over', () => {
    expect(list).toContain('shadow-[inset_0_-1px_0_var(--line-subtle)]');
    expect(list.some((name) => /^border-b/.test(name))).toBe(false);
  });

  it('keeps every tab inside the list, with no margin pulling it past the edge', () => {
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) {
      expect(trigger.some((name) => /^-m[by]?-/.test(name))).toBe(false);
      // Still underlined when selected, as well as coloured.
      expect(trigger).toEqual(
        expect.arrayContaining(['border-b-2', 'data-[state=active]:border-accent']),
      );
    }
  });
});
