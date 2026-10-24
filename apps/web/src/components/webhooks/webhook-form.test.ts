import { describe, expect, it } from 'vitest';

import { WEBHOOK_EVENT_TYPES, WEBHOOK_URL_MAX_LENGTH } from '@xecret/core/webhooks';
import { parseWith } from '@/server/http';
import { webhookCreateSchema, webhookPatchSchema } from '@/server/schemas/webhooks';
import type { Webhook } from './types';
import {
  atWebhookLimit,
  createBody,
  deliveryErrorText,
  deliveryStatusCopy,
  emptyWebhookForm,
  eventLabel,
  eventSummary,
  formFromWebhook,
  hasErrors,
  patchBody,
  testOutcomeCopy,
  toggleEventType,
  validateWebhookForm,
  WEBHOOK_DESCRIPTION_MAX_LENGTH,
  webhookStateCopy,
} from './webhook-form';

/**
 * The webhook form's rules and bodies, without a DOM.
 *
 * The bodies are run through the server's own zod schemas, as the environment
 * key tests do for theirs: a form that builds a body it likes and a route that
 * refuses it is the failure that only shows up in production.
 */

function webhook(over: Partial<Webhook> = {}): Webhook {
  return {
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
    ...over,
  };
}

describe('validateWebhookForm', () => {
  it('accepts a fresh form once it has a public https URL', () => {
    const values = { ...emptyWebhookForm(), url: 'https://hooks.example.com/x' };
    expect(validateWebhookForm(values)).toEqual({});
    expect(hasErrors(validateWebhookForm(values))).toBe(false);
  });

  it('asks for a URL before anything else is wrong with it', () => {
    expect(validateWebhookForm({ ...emptyWebhookForm(), url: '   ' }).url).toBe(
      'Enter the URL to deliver to.',
    );
  });

  it.each([
    ['http://hooks.example.com/x', 'https'],
    ['https://user:pass@hooks.example.com/x', 'username or password'],
    ['https://10.0.0.5/hook', 'private'],
    ['https://localhost/hook', 'local host name'],
    ['not a url', 'full URL'],
  ])('refuses %s with the rule it breaks', (url, phrase) => {
    const message = validateWebhookForm({ ...emptyWebhookForm(), url }).url;
    expect(message).toContain(phrase);
  });

  it('never echoes the URL back — it may be a credential', () => {
    const url = 'https://user:hunter2@hooks.example.com/T000/B000/XXXX';
    const message = validateWebhookForm({ ...emptyWebhookForm(), url }).url ?? '';
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('XXXX');
  });

  it('refuses a URL past the length the server stores', () => {
    const url = `https://hooks.example.com/${'a'.repeat(WEBHOOK_URL_MAX_LENGTH)}`;
    expect(validateWebhookForm({ ...emptyWebhookForm(), url }).url).toContain(
      String(WEBHOOK_URL_MAX_LENGTH),
    );
  });

  it('bounds the description, counting it trimmed', () => {
    const base = { ...emptyWebhookForm(), url: 'https://hooks.example.com/x' };
    expect(
      validateWebhookForm({
        ...base,
        description: ` ${'d'.repeat(WEBHOOK_DESCRIPTION_MAX_LENGTH)} `,
      }).description,
    ).toBeUndefined();
    expect(
      validateWebhookForm({ ...base, description: 'd'.repeat(WEBHOOK_DESCRIPTION_MAX_LENGTH + 1) })
        .description,
    ).toContain(String(WEBHOOK_DESCRIPTION_MAX_LENGTH));
  });

  it('wants at least one event', () => {
    const values = { ...emptyWebhookForm(), url: 'https://hooks.example.com/x', eventTypes: [] };
    expect(validateWebhookForm(values).eventTypes).toBe('Choose at least one event to deliver.');
  });
});

describe('createBody', () => {
  it('trims, leaves an empty description out, and is a body the route accepts', () => {
    const body = createBody({
      url: '  https://hooks.example.com/x  ',
      description: '   ',
      eventTypes: ['secret.deleted', 'secret.created'],
    });
    expect(body).toEqual({
      url: 'https://hooks.example.com/x',
      // The form's canonical order, whatever order the boxes were ticked in.
      eventTypes: ['secret.created', 'secret.deleted'],
    });
    expect(parseWith(webhookCreateSchema, body)).toEqual(body);
  });

  it('subscribes a fresh form to every event', () => {
    const body = createBody({ ...emptyWebhookForm(), url: 'https://hooks.example.com/x' });
    expect(body.eventTypes).toEqual([...WEBHOOK_EVENT_TYPES]);
    expect(() => parseWith(webhookCreateSchema, body)).not.toThrow();
  });
});

describe('patchBody', () => {
  it('sends nothing when nothing changed', () => {
    const original = webhook();
    expect(patchBody(original, formFromWebhook(original))).toBeNull();
  });

  it('treats ticking and unticking back as no change', () => {
    const original = webhook();
    const values = formFromWebhook(original);
    const ticked = toggleEventType(values.eventTypes, 'secret.deleted', true);
    const back = toggleEventType(ticked, 'secret.deleted', false);
    expect(patchBody(original, { ...values, eventTypes: back })).toBeNull();
  });

  it('sends only the fields that changed', () => {
    const original = webhook();
    const patch = patchBody(original, {
      ...formFromWebhook(original),
      eventTypes: ['secret.created'],
    });
    // Not the URL: a patch that resends it is an edit to it, audited as one, and
    // refused on a plan that allows no webhooks where switching off is not.
    expect(patch).toEqual({ eventTypes: ['secret.created'] });
    expect(parseWith(webhookPatchSchema, patch)).toEqual(patch);
  });

  it('clears an emptied description with null, and leaves an absent one alone', () => {
    const described = webhook({ description: 'Deploy bot' });
    expect(patchBody(described, { ...formFromWebhook(described), description: '  ' })).toEqual({
      description: null,
    });

    const bare = webhook({ description: null });
    expect(patchBody(bare, { ...formFromWebhook(bare), description: '' })).toBeNull();
  });

  it('sends a changed URL trimmed', () => {
    const original = webhook();
    expect(
      patchBody(original, { ...formFromWebhook(original), url: ' https://other.example.com/y ' }),
    ).toEqual({ url: 'https://other.example.com/y' });
  });
});

describe('formFromWebhook', () => {
  it('offers only the events this build knows, in the form order', () => {
    const values = formFromWebhook(
      webhook({ eventTypes: ['secret.updated', 'secret.someday', 'secret.created'] }),
    );
    expect(values.eventTypes).toEqual(['secret.created', 'secret.updated']);
  });
});

describe('the words', () => {
  it('names every event, the test, and one it has never heard of', () => {
    expect(eventLabel('environment.promoted')).toBe('Environment promoted');
    expect(eventLabel('webhook.test')).toBe('Test delivery');
    expect(eventLabel('secret.someday')).toBe('secret.someday');
  });

  it('summarises a subscription', () => {
    expect(eventSummary([...WEBHOOK_EVENT_TYPES])).toBe('Every event');
    expect(eventSummary(['secret.updated', 'secret.created'])).toBe(
      'Secret created, Secret updated',
    );
    expect(eventSummary([])).toBe('No events');
  });

  it('tells a failed-off endpoint from a switched-off one', () => {
    expect(webhookStateCopy(webhook()).label).toBe('Active');
    expect(webhookStateCopy(webhook({ state: 'paused' })).tone).toBe('warning');
    expect(
      webhookStateCopy(webhook({ state: 'disabled', enabled: false, disabledReason: 'manual' }))
        .label,
    ).toBe('Off');
    expect(
      webhookStateCopy(webhook({ state: 'disabled', enabled: false, disabledReason: 'failures' })),
    ).toEqual({ label: 'Switched off after failures', tone: 'danger' });
  });

  it('tells a queued delivery from one that is retrying', () => {
    expect(deliveryStatusCopy('pending', 0).label).toBe('Queued');
    expect(deliveryStatusCopy('pending', 2).label).toBe('Retrying');
    expect(deliveryStatusCopy('succeeded').tone).toBe('success');
    expect(deliveryStatusCopy('abandoned').label).toBe('Gave up');
  });

  it('says a single failed test failed, rather than gave up', () => {
    expect(testOutcomeCopy('abandoned')).toEqual({ label: 'Failed', tone: 'danger' });
    expect(testOutcomeCopy('succeeded').label).toBe('Delivered');
  });

  it('turns every failure category into a sentence', () => {
    expect(deliveryErrorText(null)).toBeNull();
    expect(deliveryErrorText('timeout')).toContain('in time');
    expect(deliveryErrorText('network')).toContain('could not be reached');
    expect(deliveryErrorText('redirect', 301)).toContain('HTTP 301');
    expect(deliveryErrorText('invalid_url')).toContain('no longer');
    expect(deliveryErrorText('signing_failed')).toContain('sign');
    expect(deliveryErrorText('http_503', 503)).toBe('The endpoint answered HTTP 503.');
    // The server's own fixed sentence for an abandonment, shown as it is.
    expect(deliveryErrorText('endpoint switched off before delivery')).toBe(
      'endpoint switched off before delivery',
    );
  });
});

describe('atWebhookLimit', () => {
  it('is reached at the ceiling, never where there is none', () => {
    expect(atWebhookLimit({ max: 3, used: 2 })).toBe(false);
    expect(atWebhookLimit({ max: 3, used: 3 })).toBe(true);
    expect(atWebhookLimit({ max: 0, used: 0 })).toBe(true);
    expect(atWebhookLimit({ max: null, used: 500 })).toBe(false);
  });
});
