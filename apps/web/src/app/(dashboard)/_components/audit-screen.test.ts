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
  it('says how an owner got past their organisation’s single sign-on (review C3)', () => {
    expect(describeEvent(event('auth.sso_exemption_used', { signInMethod: 'password' }))).toBe(
      'signed in by password',
    );
    expect(describeEvent(event('auth.sso_exemption_used', { signInMethod: 'sso' }))).toBe(
      'signed in by another organisation’s single sign-on',
    );
  });

  it('says a just-in-time join was turned away because the person was removed (review S4)', () => {
    const turnedAway = {
      ...event('member.jit_denied', { targetEmail: 'gone@acme.example', reason: 'removed' }),
      outcome: 'error' as const,
    };
    expect(describeEvent(turnedAway)).toBe('gone@acme.example · removed from the organisation');
  });

  it('says which way an SSO policy switch moved', () => {
    expect(describeEvent(event('org.sso.required_toggled', { enabled: true }))).toBe('switched on');
    expect(describeEvent(event('org.sso.jit_toggled', { enabled: false }))).toBe('switched off');
    // Anything but a boolean says nothing rather than something wrong.
    expect(describeEvent(event('org.sso.jit_toggled', { enabled: 'true' }))).toBe('');
  });

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
