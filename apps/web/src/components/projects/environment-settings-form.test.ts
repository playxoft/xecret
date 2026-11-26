import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { EnvironmentDetail } from './types';

/**
 * The environment's details form: Save is offered only once the name or the
 * display order differs from what is saved, read the way a save sends them.
 *
 * A server render runs no handlers, so the edits after the first paint are
 * pinned through `environmentDetailsChanged`, which is what the button's
 * `disabled` is computed from — against saved details the form moves to what
 * it sent the moment a save succeeds.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));

const { Toaster } = await import('@/components/ui');
const { DeleteEnvironmentCard, EnvironmentSettingsForm, environmentDetailsChanged } =
  await import('./environment-settings-form');

const STAGING: EnvironmentDetail = {
  name: 'Staging',
  slug: 'staging',
  sortOrder: 1,
  isProduction: false,
  encryptionMode: 'e2ee',
  secretCount: 4,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function render(canManage: boolean): string {
  return renderToStaticMarkup(
    createElement(
      Toaster,
      null,
      createElement(EnvironmentSettingsForm, {
        orgSlug: 'acme',
        projectId: 'payments-api',
        environment: STAGING,
        canManage,
        onChanged: () => {},
      }),
    ),
  );
}

/** The opening tag of the button whose label is `label`. */
function buttonLabelled(html: string, label: string): string {
  const at = html.indexOf(`>${label}<`);
  if (at === -1) throw new Error(`no button labelled ${label}`);
  const start = html.lastIndexOf('<button', at);
  return html.slice(start, html.indexOf('>', start) + 1);
}

const SAVED = { name: 'Staging', sortOrder: 1 };

describe('the environment details’ Save', () => {
  it('is disabled while the form holds what is saved', () => {
    expect(buttonLabelled(render(true), 'Save changes')).toMatch(/\sdisabled=""/);
  });

  it('is not drawn for somebody who cannot change the environment', () => {
    expect(render(false)).not.toContain('Save changes');
  });

  it('turns on for an edit to either field, and off again when it is undone', () => {
    expect(environmentDetailsChanged(SAVED, { name: 'Staging', sortOrder: '1' })).toBe(false);
    expect(environmentDetailsChanged(SAVED, { name: 'Pre-production', sortOrder: '1' })).toBe(true);
    expect(environmentDetailsChanged(SAVED, { name: 'Staging', sortOrder: '2' })).toBe(true);
    expect(environmentDetailsChanged(SAVED, { name: 'Staging', sortOrder: '1' })).toBe(false);
  });

  it('reads the fields as a save does — the name trimmed, the order parsed', () => {
    expect(environmentDetailsChanged(SAVED, { name: '  Staging ', sortOrder: '01' })).toBe(false);
    // An order that is not a number is not what is stored; Save says why.
    expect(environmentDetailsChanged(SAVED, { name: 'Staging', sortOrder: '' })).toBe(true);
    expect(environmentDetailsChanged(SAVED, { name: 'Staging', sortOrder: 'first' })).toBe(true);
  });

  it('is off again once the details are saved, what was sent being the new baseline', () => {
    const draft = { name: ' QA ', sortOrder: '3' };
    expect(environmentDetailsChanged(SAVED, draft)).toBe(true);
    expect(
      environmentDetailsChanged({ name: 'QA', sortOrder: 3 }, { name: 'QA', sortOrder: '3' }),
    ).toBe(false);
  });
});

describe('the environment’s deletion', () => {
  it('is its own card, outside the details form', () => {
    expect(render(true)).not.toContain('Delete this environment');

    const html = renderToStaticMarkup(
      createElement(
        Toaster,
        null,
        createElement(DeleteEnvironmentCard, {
          orgSlug: 'acme',
          projectId: 'payments-api',
          environment: STAGING,
        }),
      ),
    );
    expect(html).toContain('Delete this environment');
    expect(html).toContain('Its 4 secrets stop being reachable.');
  });
});
