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

const { FOCUS_RECHECK_MS, PlanEntitlementsProvider, rechecksOnFocus, usePlanLimit } =
  await import('./plan-entitlements');

function Probe() {
  // With nothing read yet, nothing is locked.
  const lock = usePlanLimit('projects', 1_000);
  return <span>{lock === null ? 'open' : 'locked'}</span>;
}

describe('PlanEntitlementsProvider', () => {
  it('reads the organisation’s entitlements once, at the one endpoint', () => {
    resource.paths = [];
    const html = renderToStaticMarkup(
      <PlanEntitlementsProvider orgId="acme" owner>
        <Probe />
      </PlanEntitlementsProvider>,
    );
    expect(resource.paths).toEqual(['/api/orgs/acme/entitlements']);
    expect(html).toBe('<span>open</span>');
  });

  it('reads nothing where the shell describes no organisation', () => {
    resource.paths = [];
    renderToStaticMarkup(
      <PlanEntitlementsProvider orgId={null} owner={false}>
        <Probe />
      </PlanEntitlementsProvider>,
    );
    expect(resource.paths).toEqual([null]);
  });
});

describe('the window coming back into focus', () => {
  const read = 5_000_000;

  it('re-reads the plan at most once a minute, never on a timer', () => {
    expect(FOCUS_RECHECK_MS).toBe(60_000);
    expect(rechecksOnFocus(read, read + 59_999, false)).toBe(false);
    expect(rechecksOnFocus(read, read + 60_000, false)).toBe(true);
  });

  it('never re-reads for a tab that is hidden', () => {
    expect(rechecksOnFocus(read, read + 600_000, true)).toBe(false);
  });
});
