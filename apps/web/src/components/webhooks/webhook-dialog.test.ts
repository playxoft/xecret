import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Dialog } from '@/components/ui';
import type { Webhook } from './types';
import { WebhookForm } from './webhook-dialog';

/**
 * The webhook form's Save, rendered to static markup inside a bare `Dialog` —
 * the real dialog portals its content, and a server render has nowhere to
 * portal to. Offered for a new endpoint at once, and for an edit only once the
 * form differs from the endpoint as saved (`webhookFormChanged`, whose own
 * tests cover the edits).
 */

const ENDPOINT: Webhook = {
  id: '018f3f6a-0000-7000-8000-00000000aa01',
  url: 'https://hooks.example.com/xecret',
  endpointHost: 'hooks.example.com',
  description: 'Deploy bot',
  eventTypes: ['secret.created', 'secret.updated'],
  state: 'active',
  enabled: true,
  disabledReason: null,
  disabledAt: null,
  consecutiveFailures: 0,
  failingSince: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function render(webhook: Webhook | null): string {
  return renderToStaticMarkup(
    createElement(
      Dialog,
      { open: true },
      createElement(WebhookForm, {
        orgId: 'acme',
        webhook,
        onOpenChange: () => {},
        onCreated: () => {},
        onSaved: () => {},
        onSavingChange: () => {},
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

describe('the webhook form’s Save', () => {
  it('is disabled on an edit that has not changed anything yet', () => {
    expect(buttonLabelled(render(ENDPOINT), 'Save changes')).toMatch(/\sdisabled=""/);
  });

  it('is offered at once for a new endpoint, whose checks run when it is pressed', () => {
    expect(buttonLabelled(render(null), 'Add endpoint')).not.toMatch(/\sdisabled=""/);
  });
});
