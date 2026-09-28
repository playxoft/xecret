import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrgRole } from '@xecret/core/authz';
import { Toaster } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { CustomRoleSelect, CustomRolesLoadError } from './custom-role-select';
import type { CustomRole, Member } from './types';

/**
 * The custom-role select on a member row, rendered to static markup: when it
 * is drawn at all, and that a long name cannot push the row apart.
 */

const LONG_NAME = 'Release manager for production deploys';

const roles: CustomRole[] = [
  {
    id: 'role-1',
    name: LONG_NAME,
    baseRole: 'developer',
    allowedActions: [],
    accessCeiling: null,
    holderCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

function member(role: OrgRole, customRole: Member['customRole'] = null): Member {
  return {
    id: 'member-1',
    userId: 'user-1',
    email: 'dev@example.com',
    displayName: 'Dev',
    avatarUrl: null,
    role,
    customRole,
    status: 'active',
    joinedAt: '2026-01-01T00:00:00.000Z',
    isYou: false,
  };
}

function render(target: Member, assignable: boolean): string {
  const select: ReactElement = createElement(CustomRoleSelect, {
    orgSlug: 'acme',
    member: target,
    choices: { roles, assignable },
    onChanged: () => {},
  });
  return renderToStaticMarkup(createElement(Toaster, null, select));
}

describe('CustomRoleSelect', () => {
  it('draws nothing for an owner, who can never hold a custom role', () => {
    expect(render(member('owner'), true)).not.toContain('Custom role of');
  });

  it('draws nothing without the plan for a member who holds none — there is nothing to take off', () => {
    expect(render(member('developer'), false)).not.toContain('Custom role of');
  });

  it('still draws, without the plan, for a member who holds one — so it can be taken off', () => {
    const html = render(
      member('developer', { id: 'role-1', name: LONG_NAME, baseRole: 'developer' }),
      false,
    );

    expect(html).toContain('aria-label="Custom role of Dev"');
  });

  it('says so, with a way to try again, when the roles could not be loaded', () => {
    const error = new ApiError({
      code: 'internal_error',
      status: 500,
      message: 'Something went wrong.',
      requestId: 'req-123',
    });

    const html = renderToStaticMarkup(
      createElement(CustomRolesLoadError, { error, onRetry: () => {} }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Custom roles could not be loaded');
    expect(html).toContain('req-123');
    expect(html).toContain('Try again');
  });

  it('keeps a long name inside the trigger, and names it in full on hover', () => {
    const html = render(
      member('developer', { id: 'role-1', name: LONG_NAME, baseRole: 'developer' }),
      true,
    );

    expect(html).toContain('[&amp;&gt;span]:truncate');
    expect(html).toContain(`title="${LONG_NAME}"`);
  });
});
