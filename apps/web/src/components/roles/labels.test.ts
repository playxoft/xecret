import { describe, expect, it } from 'vitest';
import { ROLE_CAPABILITIES } from '@xecret/core/authz';
import type { Action } from '@xecret/core/authz';
import { ACTION_GROUPS, ACTION_LABELS } from './labels';

/**
 * Custom roles are a positive list: an action that is not on the form can never
 * be ticked, and so can never be granted to any custom role. These pin that
 * the form's groups cover every action exactly once.
 */
describe('the Roles form’s action groups', () => {
  const everyAction = Object.keys(ROLE_CAPABILITIES.owner) as Action[];

  it('offers every action there is, once', () => {
    const grouped = ACTION_GROUPS.flatMap((group) => group.actions);

    expect([...grouped].sort()).toEqual([...everyAction].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('labels every action in plain words', () => {
    for (const action of everyAction) {
      expect(ACTION_LABELS[action].length, action).toBeGreaterThan(0);
      expect(ACTION_LABELS[action], action).not.toContain('.');
    }
  });
});
