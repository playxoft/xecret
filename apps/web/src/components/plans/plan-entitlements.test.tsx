import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * How the dashboard learns the plan: one read per organisation, held by the
 * shell, re-read only when a screen says it changed something the read counts,
 * and never on a timer. The database the API reads is on a plan where a poll
 * from every open tab would be the largest load the product put on it.
 */

const resource = vi.hoisted(() => ({ paths: [] as (string | null)[] }));

vi.mock('@/app/(dashboard)/_lib/use-api-resource', () => ({
  useApiResource: (path: string | null) => {
    resource.paths.push(path);
    return { data: null, error: null, loading: false, reload: async () => {} };
  },
}));

const { PlanEntitlementsProvider, usePlanLimit } = await import('./plan-entitlements');

function Probe() {
  // With nothing read yet, nothing is locked.
  const lock = usePlanLimit('projects', 1_000);
  return <span>{lock === null ? 'open' : 'locked'}</span>;
}

describe('PlanEntitlementsProvider', () => {
  it('reads the organisation’s entitlements once, at the one endpoint', () => {
    resource.paths = [];
    const html = renderToStaticMarkup(
      <PlanEntitlementsProvider orgSlug="acme" owner>
        <Probe />
      </PlanEntitlementsProvider>,
    );
    expect(resource.paths).toEqual(['/api/orgs/acme/entitlements']);
    expect(html).toBe('<span>open</span>');
  });

  it('reads nothing where the shell describes no organisation', () => {
    resource.paths = [];
    renderToStaticMarkup(
      <PlanEntitlementsProvider orgSlug={null} owner={false}>
        <Probe />
      </PlanEntitlementsProvider>,
    );
    expect(resource.paths).toEqual([null]);
  });
});
