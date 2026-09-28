import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@/components/tokens/types';
import { describeEvent } from './audit-screen';

/**
 * The one line of context an audit row carries. Only the custom-role cases:
 * what a narrowed member became, and what a promotion to owner dropped.
 */

function event(action: string, metadata: Record<string, unknown>): AuditEvent {
  return {
    id: 'event-1',
    actorType: 'user',
    actorId: 'user-1',
    actorLabel: 'owner@example.com',
    action,
    resourceType: 'member',
    resourceId: 'member-1',
    projectId: null,
    environmentId: null,
    outcome: 'success',
    ipAddress: null,
    requestId: null,
    metadata,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('describeEvent', () => {
  it('names the custom role a promotion to owner cleared', () => {
    const line = describeEvent(
      event('member.role_changed', {
        targetEmail: 'dev@example.com',
        previousRole: 'admin',
        newRole: 'owner',
        previousCustomRoleId: 'role-1',
        previousCustomRoleName: 'Deployer',
      }),
    );

    expect(line).toBe('dev@example.com · Deployer → no custom role · admin → owner');
  });

  it('says nothing of a custom role for a role change that had none to clear', () => {
    const line = describeEvent(
      event('member.role_changed', {
        targetEmail: 'dev@example.com',
        previousRole: 'viewer',
        newRole: 'developer',
      }),
    );

    expect(line).toBe('dev@example.com · viewer → developer');
  });

  it('reads a custom-role change from one role, or none, to another', () => {
    expect(
      describeEvent(
        event('member.custom_role_changed', {
          targetEmail: 'dev@example.com',
          customRoleName: 'Auditor',
        }),
      ),
    ).toBe('dev@example.com · no custom role → Auditor');
    expect(
      describeEvent(
        event('member.custom_role_changed', {
          targetEmail: 'dev@example.com',
          previousCustomRoleName: 'Auditor',
        }),
      ),
    ).toBe('dev@example.com · Auditor → no custom role');
  });
});
