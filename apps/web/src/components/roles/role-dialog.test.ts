import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { actionsForBase } from '@xecret/core/authz';
import type { OrgRole } from '@xecret/core/authz';
import { Dialog, Toaster } from '@/components/ui';
import type { CustomRole } from '@/components/members/types';
import { RoleForm, roleBody, roleFormChanged } from './role-dialog';

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
          orgId: 'acme',
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

/** The opening tag of the button whose label is `label`. */
function buttonLabelled(html: string, label: string): string {
  const at = html.indexOf(`>${label}<`);
  if (at === -1) throw new Error(`no button labelled ${label}`);
  const start = html.lastIndexOf('<button', at);
  return html.slice(start, html.indexOf('>', start) + 1);
}

const AUDITOR: CustomRole = {
  id: 'role-1',
  name: 'Auditor',
  baseRole: 'viewer',
  allowedActions: ['member.read', 'project.read'],
  accessCeiling: { nonProduction: 'read', production: 'none' },
  holderCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** The form seeded from a role, as `RoleForm` seeds it. */
function seeded(role: CustomRole) {
  return {
    name: role.name,
    baseRole: role.baseRole,
    actions: new Set(role.allowedActions),
    capped: role.accessCeiling !== null,
    ceiling: role.accessCeiling ?? { nonProduction: 'read' as const, production: 'none' as const },
  };
}

describe('Save on an edit', () => {
  it('is disabled until something differs from the role as saved', () => {
    expect(buttonLabelled(render(AUDITOR), 'Save changes')).toMatch(/\sdisabled=""/);
  });

  it('is never held back on a new role, which has nothing saved to equal', () => {
    expect(buttonLabelled(render(null), 'Create role')).not.toMatch(/\sdisabled=""/);
    expect(roleFormChanged(null, roleBody(seeded(AUDITOR)))).toBe(true);
  });

  it('turns on for each kind of edit, and off again when it is undone', () => {
    const form = seeded(AUDITOR);
    const changed = (over: Partial<typeof form>) =>
      roleFormChanged(AUDITOR, roleBody({ ...form, ...over }));

    expect(changed({})).toBe(false);
    expect(changed({ name: 'Auditors' })).toBe(true);
    // Normalised as a save sends it: the same name with its spacing mangled is the same name.
    expect(changed({ name: '  Auditor ' })).toBe(false);
    expect(changed({ actions: new Set(['member.read' as const]) })).toBe(true);
    expect(changed({ capped: false })).toBe(true);
    expect(changed({ ceiling: { nonProduction: 'write', production: 'none' } })).toBe(true);
    expect(changed({ baseRole: 'developer' })).toBe(true);
    // Unticking and ticking back is no change; neither is the floor, kept either way.
    expect(changed({ actions: new Set(['project.read' as const, 'member.read' as const]) })).toBe(
      false,
    );
    expect(changed({ actions: new Set(['project.read' as const]) })).toBe(false);
  });

  it('is off again once the role is saved as the form describes it', () => {
    const edited = { ...seeded(AUDITOR), name: 'Reviewer', capped: false };
    const saved: CustomRole = { ...AUDITOR, ...roleBody(edited) };

    expect(roleFormChanged(AUDITOR, roleBody(edited))).toBe(true);
    expect(roleFormChanged(saved, roleBody(edited))).toBe(false);
  });
});
