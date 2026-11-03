import { describe, expect, it, vi } from 'vitest';
import { resolveEntitlements } from '@xecret/core/entitlements';
import type { PlanId } from '@xecret/core/entitlements';
import type { Executor } from '@xecret/db/repositories';
import { secretCapacity, withinCapacity } from './plan-capacity';
import type { EnvironmentScope } from './tenancy';

/**
 * When a capacity check takes its lock and counts — and when it does not.
 *
 * A ceiling of `null` is unlimited for billing: no refusal is possible, so the
 * creation is neither counted nor serialised behind the capacity lock. The
 * refusals themselves, and the counts behind them, are
 * `plan-limits-routes.test.ts`'s, against a real database.
 */

const entitlementsOf = (plan: PlanId) =>
  resolveEntitlements({ plan, status: 'active', addonSaml: false, addonDirectorySync: false });

/** An executor that records the lock and fails on anything else it is asked. */
function recordingExecutor() {
  const execute = vi.fn(async () => ({ rows: [] }));
  const select = vi.fn(() => {
    throw new Error('counted');
  });
  return { exec: { execute, select } as unknown as Executor, execute, select };
}

describe('withinCapacity', () => {
  it('neither locks nor counts where the plan has no ceiling', async () => {
    const { exec, execute } = recordingExecutor();
    const count = vi.fn(async () => 1_000_000);

    await withinCapacity(exec, entitlementsOf('enterprise'), 'projects', 'org-1', count);

    expect(execute).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('locks, then counts, where it has one', async () => {
    const { exec, execute } = recordingExecutor();
    const order: string[] = [];
    execute.mockImplementation(async () => {
      order.push('lock');
      return { rows: [] };
    });
    const count = vi.fn(async () => {
      order.push('count');
      return 0;
    });

    await withinCapacity(exec, entitlementsOf('free'), 'projects', 'org-1', count);

    expect(order).toEqual(['lock', 'count']);
  });

  it('honours a ceiling support lifted to unlimited', async () => {
    const { exec, execute } = recordingExecutor();
    const lifted = resolveEntitlements({
      plan: 'free',
      status: 'active',
      addonSaml: false,
      addonDirectorySync: false,
      limitOverrides: { projects: null },
    });
    const count = vi.fn(async () => 0);

    await withinCapacity(exec, lifted, 'projects', 'org-1', count);

    expect(execute).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });
});

describe('secretCapacity', () => {
  const scopeOn = (plan: PlanId) =>
    ({
      entitlements: entitlementsOf(plan),
      organization: { id: 'org-1' },
      environment: { id: 'env-1' },
    }) as unknown as EnvironmentScope;

  it('neither locks nor counts an environment with no ceiling', async () => {
    const { exec, execute, select } = recordingExecutor();

    await secretCapacity(scopeOn('enterprise'))(exec, {
      creates: 500,
      names: ['A'],
      removals: [],
      inTransaction: true,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('is not asked anything by a batch that creates nothing', async () => {
    const { exec, execute, select } = recordingExecutor();

    await secretCapacity(scopeOn('free'))(exec, {
      creates: 0,
      names: [],
      removals: [],
      inTransaction: true,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });
});
