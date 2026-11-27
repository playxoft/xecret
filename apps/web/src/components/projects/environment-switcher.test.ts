import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Environment } from './types';

/**
 * The environment switcher, rendered to static markup.
 *
 * What is pinned: which environment the page is about, which are compared
 * beside it and which are neither are three different looks, three different
 * icons and three different things a screen reader is told; the strip is only
 * as wide as its contents, with no line under the capsules until there is a
 * comparison to name; the Compare button and the legend name it in words, with
 * a way out of it; and a screen with nowhere to show a comparison draws
 * neither. The open menus render into a portal, which static markup never
 * draws, so what they list is left to the pure helpers below them.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

const { capsuleState, comparedInOrder, EnvironmentSwitcher } =
  await import('./environment-switcher');

function environment(
  name: string,
  slug: string,
  sortOrder: number,
  isProduction = false,
): Environment {
  return {
    name,
    slug,
    isProduction,
    sortOrder,
    encryptionMode: 'e2ee',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const DEVELOPMENT = environment('Development', 'development', 0);
const STAGING = environment('Staging', 'staging', 1);
const PRODUCTION = environment('Production', 'production', 2, true);
const DEFAULTS = [DEVELOPMENT, STAGING, PRODUCTION];

function render({
  currentSlug = 'development',
  comparing = [] as string[],
  compare = true,
  environments = DEFAULTS as readonly Environment[],
} = {}): string {
  return renderToStaticMarkup(
    createElement(EnvironmentSwitcher, {
      environments,
      currentSlug,
      href: (slug: string) => `/app/acme/api/${slug}`,
      ...(compare
        ? {
            onCompare: () => {},
            comparing: new Set(comparing),
            onStopComparing: () => {},
          }
        : {}),
    }),
  );
}

/** The opening tag of the capsule linking to `slug`. */
function capsule(html: string, slug: string): string {
  const match = new RegExp(`<a[^>]*href="/app/acme/api/${slug}"[^>]*>`).exec(html);
  expect(match, `a capsule for ${slug}`).not.toBeNull();
  return match![0];
}

/** Everything inside the capsule linking to `slug`. */
function capsuleBody(html: string, slug: string): string {
  const match = new RegExp(`<a[^>]*href="/app/acme/api/${slug}"[^>]*>([\\s\\S]*?)</a>`).exec(html);
  expect(match, `a capsule for ${slug}`).not.toBeNull();
  return match![1]!;
}

describe('which state a capsule is in', () => {
  it('is current for the page’s own environment, even if a stale set names it', () => {
    expect(capsuleState('development', 'development', new Set(['development']))).toBe('current');
    expect(capsuleState('development', 'development', undefined)).toBe('current');
  });

  it('is compared only for an environment being shown beside it', () => {
    expect(capsuleState('staging', 'development', new Set(['staging']))).toBe('compared');
    expect(capsuleState('production', 'development', new Set(['staging']))).toBe('plain');
    expect(capsuleState('staging', 'development', undefined)).toBe('plain');
  });

  it('lists the compared ones in the project’s order, not the order they were added', () => {
    expect(
      comparedInOrder(DEFAULTS, 'development', new Set(['production', 'staging'])).map(
        (entry) => entry.slug,
      ),
    ).toEqual(['staging', 'production']);
    // The page's own environment is never one of them.
    expect(
      comparedInOrder(DEFAULTS, 'staging', new Set(['staging', 'production'])).map(
        (entry) => entry.slug,
      ),
    ).toEqual(['production']);
  });
});

describe('the capsules', () => {
  it('mark the environment on screen as the page, filled and ticked', () => {
    const html = render({ comparing: ['staging'] });
    const current = capsule(html, 'development');

    expect(current).toContain('aria-current="page"');
    expect(current).toContain('data-state="current"');
    expect(current).toContain('bg-accent');
    expect(current).toContain('text-accent-fg');
    expect(capsuleBody(html, 'development')).toContain('<svg');
    // Only one capsule is the page.
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it('fill production in production’s own colour when it is the page', () => {
    const html = render({ currentSlug: 'production' });
    const current = capsule(html, 'production');

    expect(current).toContain('aria-current="page"');
    expect(current).toContain('bg-production');
    expect(current).toContain('text-production-fg');
    expect(current).not.toContain('bg-accent');
  });

  it('mark a compared environment differently, and say so to a screen reader', () => {
    const html = render({ comparing: ['staging'] });
    const compared = capsule(html, 'staging');

    expect(compared).toContain('data-state="compared"');
    expect(compared).not.toContain('aria-current');
    expect(compared).toContain('border-dashed');
    expect(compared).not.toContain('bg-accent');
    expect(compared).toContain('aria-description="Its values are shown beside Development’s.');
    expect(capsuleBody(html, 'staging')).toContain('<span class="sr-only"> (comparing)</span>');
    // Still a link: a plain click opens it on its own.
    expect(compared).toContain('href="/app/acme/api/staging"');
  });

  it('leave everything else plain', () => {
    const html = render({ comparing: ['staging'] });
    const plain = capsule(html, 'production');

    expect(plain).toContain('data-state="plain"');
    expect(plain).not.toContain('aria-current');
    expect(plain).not.toContain('aria-description');
    expect(plain).not.toContain('border-dashed');
    expect(capsuleBody(html, 'production')).not.toContain('(comparing)');
  });

  it('keep production’s mark when it is not the page', () => {
    const body = capsuleBody(render(), 'production');
    expect(body).toContain('bg-production');
  });

  it('advertise the navigation chord on the capsules you are not on', () => {
    const html = render();
    expect(capsule(html, 'staging')).toContain('aria-keyshortcuts="Shift+2"');
    expect(capsule(html, 'development')).toContain('aria-keyshortcuts="Shift+1"');
    expect(capsuleBody(html, 'development')).not.toContain('<kbd');
    expect(capsuleBody(html, 'staging')).toContain('<kbd');
  });

  it('sit in a labelled group', () => {
    expect(render()).toContain('role="group" aria-label="Environment"');
  });
});

describe('the Compare button', () => {
  it('names what it does before anything is compared', () => {
    const html = render();
    expect(html).toContain('aria-label="Compare Development with another environment"');
    expect(html).toMatch(/aria-haspopup="menu"/);
  });

  it('counts what is compared, in its name as well as its badge', () => {
    const html = render({ comparing: ['staging', 'production'] });
    expect(html).toContain('aria-label="Compare — 2 shown beside Development"');
    expect(html).toMatch(/<span aria-hidden="true" class="[^"]*bg-accent[^"]*">2<\/span>/);
  });
});

describe('the strip', () => {
  /** The classes of the switcher's outermost element. */
  function outer(html: string): string[] {
    return (/^<div class="([^"]*)"/.exec(html)?.[1] ?? '').split(' ');
  }

  it('is as wide as what is in it, never the whole page, and never wider than its column', () => {
    for (const html of [render(), render({ comparing: ['staging'] })]) {
      expect(outer(html)).toEqual(expect.arrayContaining(['w-fit', 'max-w-full']));
      expect(outer(html)).not.toContain('w-full');
    }
  });

  it('keeps the Compare button beside the capsules, not pushed to the far edge', () => {
    expect(render()).not.toContain('flex-1');
  });
});

describe('the legend', () => {
  it('is not drawn while nothing is compared — the ticked capsule says where you are', () => {
    const html = render();
    expect(html).not.toContain('Viewing');
    expect(html).not.toContain('Choose Compare');
    expect(html).not.toContain('Comparing with');
    expect(html).not.toContain('Stop comparing');
    // Which environment is on screen is still marked, for sight and for a
    // screen reader alike.
    expect(capsule(html, 'development')).toContain('aria-current="page"');
    expect(capsule(html, 'development')).toContain('title="You are viewing Development"');
  });

  it('says which environment is on screen and which are beside it, once one is', () => {
    const html = render({ comparing: ['staging'] });
    expect(html).toMatch(/>Viewing<\/span>/);
    // Ticked, as its capsule is.
    expect(html).toMatch(/<\/svg>Development<\/span>/);
    expect(html).toContain('Comparing with');
    expect(html).not.toContain('Choose Compare');
  });

  it('names each compared environment, each with its own way out', () => {
    const html = render({ comparing: ['production', 'staging'] });

    expect(html).toContain('Comparing with');
    // In the project's order.
    expect(html.indexOf('aria-label="Stop comparing with Staging"')).toBeLessThan(
      html.indexOf('aria-label="Stop comparing with Production"'),
    );
    expect(html).toMatch(/<button[^>]*><span[^>]*>Stop comparing<\/span><\/button>/);
    expect(html).not.toContain('Choose Compare');
  });

  it('labels the compared list by its heading', () => {
    const html = render({ comparing: ['staging'] });
    const heading = /<span id="([^"]+)" class="text-fg-subtle">Comparing with<\/span>/.exec(html);
    expect(heading).not.toBeNull();
    expect(html).toContain(`<ul aria-labelledby="${heading![1]}"`);
  });
});

describe('a screen with nowhere to show a comparison', () => {
  it('draws the capsules and neither the Compare button nor the legend', () => {
    const html = render({ compare: false });
    expect(capsule(html, 'development')).toContain('aria-current="page"');
    expect(html).not.toContain('Compare');
    expect(html).not.toContain('Viewing');
  });
});

describe('the overflow menu', () => {
  it('is not drawn over three environments that all fit', () => {
    expect(render()).not.toContain('more environments');
    expect(render()).not.toContain('More environment options');
  });

  it('is drawn for the environments past the fourth', () => {
    const many = [
      ...DEFAULTS,
      environment('QA', 'qa', 3),
      environment('Preview', 'preview', 4),
      environment('Sandbox', 'sandbox', 5),
    ];
    const html = render({ environments: many });
    expect(html).toContain('aria-label="2 more environments"');
  });
});
