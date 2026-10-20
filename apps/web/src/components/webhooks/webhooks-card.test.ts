import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authoritySummary } from '@xecret/core/authz';
import type { OrgRole } from '@xecret/core/authz';
import type { SessionOrganization } from '@/app/(dashboard)/_components/session';
import type { Webhook, WebhookListResponse } from './types';

/**
 * The Webhooks card, rendered to static markup with the listing it would fetch
 * handed to it — a server render runs no effects, so the data hook is stubbed
 * with what the API would answer, as the single sign-on card's test does.
 *
 * What is pinned is what the card may and may not draw: who is shown anything,
 * that the list names hosts and never URLs, and that a control the plan will
 * refuse is replaced by a sentence naming the plan that would allow it.
 */

const resource = vi.hoisted(() => ({
  current: { data: null as unknown, error: null as unknown, loading: false },
  paths: [] as (string | null)[],
}));

vi.mock('@/app/(dashboard)/_lib/use-api-resource', () => ({
  useApiResource: (path: string | null) => {
    resource.paths.push(path);
    return path === null
      ? { data: null, error: null, loading: false, reload: async () => {} }
      : { ...resource.current, reload: async () => {} };
  },
}));

const { Toaster } = await import('@/components/ui');
const { WebhooksCard } = await import('./webhooks-card');

function organization(role: OrgRole): SessionOrganization {
  return {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    role,
    authority: { role, customRole: null, ...authoritySummary({ role }) },
  };
}

function webhook(over: Partial<Webhook> = {}): Webhook {
  return {
    id: '018f3f6a-0000-7000-8000-00000000aa01',
    url: 'https://hooks.slack.example.com/services/T000/B000/SECRETPATH',
    endpointHost: 'hooks.slack.example.com',
    description: 'Deploys channel',
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
    ...over,
  };
}

function shows(over: Partial<WebhookListResponse> = {}): void {
  const data: WebhookListResponse = {
    webhooks: [webhook()],
    limit: { max: 3, used: 1 },
    paused: false,
    upgradeTo: null,
    ...over,
  };
  resource.current = { data, error: null, loading: false };
}

function render(org: SessionOrganization): string {
  return renderToStaticMarkup(
    createElement(
      Toaster,
      null,
      createElement(WebhooksCard, { orgSlug: 'acme', organization: org }),
    ),
  );
}

beforeEach(() => {
  resource.paths = [];
  shows();
});

describe('WebhooksCard', () => {
  it.each(['developer', 'viewer'] as const)(
    'tells a %s who manages webhooks, and fetches nothing',
    (role) => {
      const html = render(organization(role));
      expect(html).toContain('managed by the organisation’s owners and admins');
      expect(html).not.toContain('New endpoint');
      expect(resource.paths).toEqual([null]);
    },
  );

  it('lists an endpoint by its host, never by its URL', () => {
    const html = render(organization('admin'));
    expect(resource.paths).toContain('/api/orgs/acme/webhooks');
    expect(html).toContain('hooks.slack.example.com');
    expect(html).toContain('Deploys channel');
    // The path of a chat integration's URL is its credential.
    expect(html).not.toContain('SECRETPATH');
    expect(html).toContain('New endpoint');
  });

  it('replaces New endpoint with the plan that allows another, at the ceiling', () => {
    shows({ limit: { max: 3, used: 3 }, upgradeTo: 'team' });
    const html = render(organization('owner'));
    expect(html).not.toContain('New endpoint');
    expect(html).toContain('the most its plan allows');
    expect(html).toContain('Adding another endpoint needs the Team plan.');
  });

  it('says a paused organisation keeps its endpoints, and which plan starts them', () => {
    shows({
      webhooks: [webhook({ state: 'paused' })],
      limit: { max: 0, used: 1 },
      paused: true,
      upgradeTo: 'pro',
    });
    const html = render(organization('owner'));
    expect(html).toContain('Webhooks are paused');
    expect(html).toContain('Delivering webhooks needs the Pro plan.');
    expect(html).not.toContain('New endpoint');
  });

  it('explains an endpoint switched off for failing, and offers to switch it back on', () => {
    shows({
      webhooks: [
        webhook({
          state: 'disabled',
          enabled: false,
          disabledReason: 'failures',
          consecutiveFailures: 15,
          failingSince: '2026-10-18T00:00:00.000Z',
        }),
      ],
    });
    const html = render(organization('admin'));
    expect(html).toContain('Switched off after failures');
    expect(html).toContain('15 times in a row');
    expect(html).toContain('Re-enable');
  });

  it('does not offer to re-enable a failed endpoint while the plan includes none', () => {
    shows({
      webhooks: [
        webhook({
          state: 'disabled',
          enabled: false,
          disabledReason: 'failures',
          consecutiveFailures: 15,
        }),
      ],
      limit: { max: 0, used: 1 },
      paused: true,
      upgradeTo: 'pro',
    });
    const html = render(organization('admin'));
    expect(html).not.toContain('Re-enable');
    expect(html).toContain('waits for a plan that includes webhooks');
  });

  it('says so when there are none', () => {
    shows({ webhooks: [], limit: { max: 3, used: 0 } });
    expect(render(organization('owner'))).toContain('No endpoints yet');
  });
});
