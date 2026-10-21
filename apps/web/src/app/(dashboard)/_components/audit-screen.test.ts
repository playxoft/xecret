import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@/components/tokens/types';
import { AUDIT_FILTER_ACTIONS, describeEvent } from './audit-screen';

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

describe('the action filter (review round 1, L11)', () => {
  it('offers every action the P19 features write, and secret.rotated', () => {
    const filterable = new Set<string>(AUDIT_FILTER_ACTIONS);
    for (const action of [
      'secret.rotated',
      'environment.parent_changed',
      'environment.link_crosses_protection',
      'environment.promoted',
      'environment.restored',
      'environment.policy_changed',
      'org.policy_changed',
      'override.set',
      'override.removed',
      'webhook.created',
      'webhook.updated',
      'webhook.deleted',
      'webhook.secret_rotated',
      'webhook.disabled',
    ]) {
      expect(filterable.has(action), action).toBe(true);
    }
    expect(filterable.size).toBe(AUDIT_FILTER_ACTIONS.length);
  });
});

describe('describeEvent', () => {
  it('reads the P19 records (review round 1, L11)', () => {
    expect(
      describeEvent(
        event('environment.parent_changed', {
          projectSlug: 'api',
          environmentSlug: 'staging',
          parentEnvironmentSlug: 'base',
          previousParentEnvironmentSlug: null,
        }),
      ),
    ).toBe('api/staging · inherits from nothing → base');
    expect(
      describeEvent(
        event('environment.link_crosses_protection', {
          projectSlug: 'api',
          environmentSlug: 'production',
          sourceProjectSlug: 'api',
          sourceEnvironmentSlug: 'staging',
          secretName: 'DB_URL',
          reason: 'referenced',
        }),
      ),
    ).toBe('DB_URL · api/production · a template reads from api/staging, which is not production');
    expect(
      describeEvent(
        event('environment.promoted', {
          projectSlug: 'api',
          environmentSlug: 'production',
          sourceEnvironmentSlug: 'staging',
          createdCount: 2,
          updatedCount: 3,
          deletedCount: 0,
        }),
      ),
    ).toBe('api/production · from staging · 2 created, 3 updated, 0 deleted');
    expect(
      describeEvent(event('environment.restored', { restoredTo: '2026-10-19T14:30:00.000Z' })),
    ).toBe('to 2026-10-19T14:30:00.000Z');
    expect(describeEvent(event('org.policy_changed', { policyName: 'secrets' }))).toBe(
      'secret naming and strength policy',
    );
    expect(
      describeEvent(
        event('webhook.created', {
          endpointHost: 'hooks.example.com',
          eventTypes: ['secret.updated', 'environment.promoted'],
        }),
      ),
    ).toBe('hooks.example.com · secret.updated, environment.promoted');
  });

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

  it('says why a held-back sign-in was asked, and whether it was confirmed or declined (review round 2)', () => {
    expect(describeEvent(event('auth.sign_in_declined', { confirmation: 'organization' }))).toBe(
      'declined — it came back through an organisation the sign-in did not ask for',
    );
    expect(describeEvent(event('auth.login', { confirmation: 'not-member' }))).toBe(
      'confirmed — single sign-on of an organisation the account was not in',
    );
    expect(describeEvent(event('auth.login', { confirmation: 'reused-session' }))).toBe(
      'confirmed — a sign-in session reused without asking',
    );
    // An unknown value says nothing rather than something made up.
    expect(describeEvent(event('auth.login', { confirmation: 'because' }))).toBe('');
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
