import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrgEntitlements } from '@/components/plans/plan-gate';
import type { SecretSummary } from './types';

/**
 * The secret table against the plan's ceiling on secrets in an environment:
 * "Add secret" is drawn locked once the environment holds as many as the plan
 * allows, and is the plain button below it. Import is locked only while the
 * organisation waits for a paid plan, because an import may overwrite as well
 * as add, and its preview (the server's own dry run) says whether its
 * additions fit.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => '/app/acme/api/development',
}));

const { Toaster, TooltipProvider } = await import('@/components/ui');
const { SecretTable } = await import('./secret-table');
const { entitlementsFor, planView, withPlan } = await import('@/components/plans/plan-test-view');

function secret(index: number): SecretSummary {
  return {
    id: `018f3f6a-0000-7000-8000-${String(index).padStart(12, '0')}`,
    name: `KEY_${index}`,
    note: null,
    valueType: 'string',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: null,
    updatedByServiceTokenId: null,
  } as unknown as SecretSummary;
}

function render(held: number, entitlements: OrgEntitlements): string {
  return renderToStaticMarkup(
    withPlan(
      planView({ entitlements }),
      createElement(
        TooltipProvider,
        null,
        createElement(
          Toaster,
          null,
          createElement(SecretTable, {
            orgId: 'org-1',
            projectId: 'api',
            envSlug: 'development',
            isProduction: false,
            io: null,
            environments: [],
            comparedEnvironments: [],
            onStopComparing: () => {},
            externalWrites: 0,
            secrets: Array.from({ length: held }, (_, index) => secret(index)),
            onLoadMore: null,
            loadingMore: false,
            loadMoreError: null,
            onChanged: () => {},
            onImport: () => {},
            onExport: () => {},
          }),
        ),
      ),
    ),
  );
}

function locked(html: string, label: string): boolean {
  return new RegExp(
    `<button[^>]*aria-disabled="true"[^>]*data-plan-locked=""[^>]*>(?:(?!</button>)[\\s\\S])*${label}`,
  ).test(html);
}

describe('the secret table and the plan', () => {
  it('locks Add secret once the environment holds as many as the plan allows', () => {
    const html = render(250, entitlementsFor('free'));
    expect(locked(html, 'Add secret')).toBe(true);
    expect(html).toContain('Your Free plan allows 250 secrets per environment.');
    // Importing may only overwrite, so it stays open at the ceiling.
    expect(locked(html, 'Import')).toBe(false);
  });

  it('leaves Add secret a plain button below the ceiling', () => {
    const html = render(249, entitlementsFor('free'));
    expect(html).toContain('Add secret');
    expect(locked(html, 'Add secret')).toBe(false);
  });

  it('never locks a plan with no ceiling', () => {
    const html = render(300, entitlementsFor('enterprise'));
    expect(locked(html, 'Add secret')).toBe(false);
  });

  it('locks Import too while the organisation waits for a paid plan', () => {
    const html = render(
      3,
      entitlementsFor('free', { awaitingPaidPlan: true, controlPlaneActive: false }),
    );
    expect(locked(html, 'Add secret')).toBe(true);
    expect(locked(html, 'Import')).toBe(true);
    expect(html).toContain('Choose a plan to start using this organisation.');
  });
});
