import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Toaster } from '@/components/ui';
import { MemberRowActions } from './member-actions';
import type { Member } from './types';

/**
 * A member row's controls, rendered to static markup: each drawn only for the
 * action the server will ask of it. Removal asks `member.remove`, which a role
 * can lack while holding `member.update` — the capability that draws the row's
 * other controls.
 */

const member: Member = {
  id: 'member-1',
  userId: 'user-1',
  email: 'dev@example.com',
  displayName: 'Dev',
  avatarUrl: null,
  role: 'viewer',
  customRole: null,
  status: 'active',
  joinedAt: '2026-01-01T00:00:00.000Z',
  isYou: false,
};

function render(canRemove: boolean): string {
  return renderToStaticMarkup(
    createElement(
      Toaster,
      null,
      createElement(MemberRowActions, {
        orgSlug: 'acme',
        member,
        assignableRoles: ['developer', 'viewer'],
        canRemove,
        customRoles: null,
        onChanged: () => {},
      }),
    ),
  );
}

describe('MemberRowActions', () => {
  it('draws Remove only for a viewer who holds member.remove', () => {
    expect(render(true)).toContain('aria-label="Remove Dev from the organisation"');
    expect(render(false)).not.toContain('Remove Dev');
  });

  it('keeps the role select and suspension, which member.update covers', () => {
    const html = render(false);

    expect(html).toContain('aria-label="Role of Dev"');
    expect(html).toContain('aria-label="Suspend Dev"');
  });
});
