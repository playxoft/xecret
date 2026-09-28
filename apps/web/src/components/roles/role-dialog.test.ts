import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { actionsForBase } from '@xecret/core/authz';
import type { OrgRole } from '@xecret/core/authz';
import { Dialog, Toaster } from '@/components/ui';
import type { CustomRole } from '@/components/members/types';
import { RoleForm } from './role-dialog';

/**
 * The role form, rendered to static markup inside a bare `Dialog` — the real
 * dialog portals its content, and a server render has nowhere to portal to.
 * What it pins: a new role starts as the whole of its base, the floor is
 * ticked and cannot be unticked, only the base's own actions are offered, and
 * an edit starts from the role as saved.
 */

function render(
  role: CustomRole | null,
  bases: readonly OrgRole[] = ['admin', 'developer', 'viewer'],
) {
  return renderToStaticMarkup(
    createElement(
      Toaster,
      null,
      createElement(
        Dialog,
        { open: true },
        createElement(RoleForm, {
          orgSlug: 'acme',
          role,
          definableBaseRoles: bases,
          onOpenChange: () => {},
          onSaved: () => {},
        }),
      ),
    ),
  );
}

/** Every checkbox in the form, as the markup has it. */
function checkboxes(html: string): string[] {
  return [...html.matchAll(/<button[^>]*role="checkbox"[^>]*>/g)].map((match) => match[0]);
}

describe('RoleForm', () => {
  it('starts a new role as the whole of its base, the developer by default', () => {
    const html = render(null);
    const boxes = checkboxes(html);

    // One box per developer action, plus the ceiling's own switch.
    expect(boxes).toHaveLength(actionsForBase('developer').length + 1);
    const actionBoxes = boxes.slice(0, -1);
    expect(actionBoxes.every((box) => box.includes('aria-checked="true"'))).toBe(true);
    expect(html).toContain('New role');
  });

  it('keeps "see who is in the organisation" ticked and fixed', () => {
    const html = render(null);

    expect(html).toContain('always included');
    const floor = checkboxes(html).filter((box) => /\sdisabled=""/.test(box));
    expect(floor).toHaveLength(1);
    expect(floor[0]).toContain('aria-checked="true"');
  });

  it('starts an edit from the role as saved — its name, its list, its ceiling', () => {
    const html = render({
      id: 'role-1',
      name: 'Auditor',
      baseRole: 'viewer',
      allowedActions: ['member.read', 'project.read'],
      accessCeiling: { nonProduction: 'read', production: 'none' },
      holderCount: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const boxes = checkboxes(html);

    expect(html).toContain('Edit Auditor');
    expect(html).toContain('value="Auditor"');
    // A viewer's actions only, two of them ticked, and the ceiling switched on.
    expect(boxes).toHaveLength(actionsForBase('viewer').length + 1);
    expect(boxes.filter((box) => box.includes('aria-checked="true"'))).toHaveLength(3);
    // Three members hold it, and the form says the change reaches them.
    expect(html).toContain('3 members hold');
  });
});
