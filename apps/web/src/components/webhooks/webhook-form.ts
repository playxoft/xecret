import {
  checkWebhookUrl,
  isWebhookEventType,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_TEST_EVENT,
  WEBHOOK_URL_MAX_LENGTH,
} from '@xecret/core/webhooks';
import type { WebhookEventType } from '@xecret/core/webhooks';
import type { BadgeTone } from '@/components/ui';
import type {
  DeliveryStatus,
  Webhook,
  WebhookCreateBody,
  WebhookListResponse,
  WebhookPatchBody,
} from './types';

/**
 * Everything the webhooks card decides without rendering: what the form may
 * submit, the body it submits, and the words every state is shown in.
 *
 * Pure, so it is tested without a DOM — and so the rules a person is shown
 * while typing are the same rules, from the same `@xecret/core/webhooks`, that
 * the server applies when the request arrives. The server's copy is the one
 * that counts; this one exists so the refusal arrives while the URL is still
 * under the cursor rather than as a 422.
 */

/** Matches `WEBHOOK_DESCRIPTION_MAX_LENGTH` on the server. A label, not a document. */
export const WEBHOOK_DESCRIPTION_MAX_LENGTH = 500;

/** What each subscribable event means, in the order the form offers them. */
export const EVENT_TYPE_COPY: Readonly<
  Record<WebhookEventType, { label: string; description: string }>
> = {
  'secret.created': {
    label: 'Secret created',
    description: 'A new secret was added to an environment.',
  },
  'secret.updated': {
    label: 'Secret updated',
    description: 'A secret was given a new value, or renamed.',
  },
  'secret.deleted': {
    label: 'Secret deleted',
    description: 'A secret was removed from an environment.',
  },
  'secret.rotated': {
    label: 'Secret rotated',
    description:
      'Reserved for scheduled rotation. Subscribe now and it arrives when rotation does.',
  },
  'environment.promoted': {
    label: 'Environment promoted',
    description: 'Values were promoted into an environment from another one.',
  },
  'environment.restored': {
    label: 'Environment restored',
    description: 'An environment was put back to how it was at an earlier moment.',
  },
};

/**
 * An event type as a person reads it. The test event, and any type a newer
 * server sends that this build does not know, are named rather than dropped —
 * a delivery log that hid an entry would be a log that lies.
 */
export function eventLabel(type: string): string {
  if (type === WEBHOOK_TEST_EVENT) return 'Test delivery';
  return isWebhookEventType(type) ? EVENT_TYPE_COPY[type].label : type;
}

/** "Every event", or the labels of the ones chosen, in the form's order. */
export function eventSummary(types: readonly string[]): string {
  const known = new Set(types);
  if (WEBHOOK_EVENT_TYPES.every((type) => known.has(type))) return 'Every event';
  const labels = [
    ...WEBHOOK_EVENT_TYPES.filter((type) => known.has(type)).map((type) => eventLabel(type)),
    // Anything this build does not know, kept and named.
    ...types.filter((type) => !isWebhookEventType(type)),
  ];
  return labels.length === 0 ? 'No events' : labels.join(', ');
}

/** What the form holds. Strings exactly as typed; trimming happens on the way out. */
export interface WebhookFormValues {
  url: string;
  description: string;
  eventTypes: readonly WebhookEventType[];
}

/**
 * A fresh form. Every event is ticked: an endpoint added to "tell us when a
 * secret changes" wants all of them far more often than a subset, and unticking
 * is one click per event where ticking would be six.
 */
export function emptyWebhookForm(): WebhookFormValues {
  return { url: '', description: '', eventTypes: [...WEBHOOK_EVENT_TYPES] };
}

/** The form an existing endpoint opens with. Types this build does not know are not offered. */
export function formFromWebhook(webhook: Webhook): WebhookFormValues {
  return {
    url: webhook.url,
    description: webhook.description ?? '',
    eventTypes: WEBHOOK_EVENT_TYPES.filter((type) => webhook.eventTypes.includes(type)),
  };
}

/** Ticks or unticks one event, keeping the form's canonical order. */
export function toggleEventType(
  current: readonly WebhookEventType[],
  type: WebhookEventType,
  checked: boolean,
): WebhookEventType[] {
  const chosen = new Set(current);
  if (checked) chosen.add(type);
  else chosen.delete(type);
  return WEBHOOK_EVENT_TYPES.filter((entry) => chosen.has(entry));
}

export type WebhookFormField = 'url' | 'description' | 'eventTypes';
export type WebhookFormErrors = Partial<Record<WebhookFormField, string>>;

/**
 * What is wrong with the form, field by field — empty when it may be sent.
 *
 * The URL rules are `checkWebhookUrl`'s: `https:` only, no username or
 * password, nothing private, loopback or local. Its messages are fixed strings
 * and never echo the URL, which matters here — the URL of a chat integration's
 * incoming webhook *is* a credential.
 */
export function validateWebhookForm(values: WebhookFormValues): WebhookFormErrors {
  const errors: WebhookFormErrors = {};

  const url = values.url.trim();
  if (url.length === 0) {
    errors.url = 'Enter the URL to deliver to.';
  } else if (url.length > WEBHOOK_URL_MAX_LENGTH) {
    errors.url = `A webhook URL may be at most ${WEBHOOK_URL_MAX_LENGTH} characters.`;
  } else {
    const check = checkWebhookUrl(url);
    if (!check.valid) errors.url = check.message ?? 'Enter a full URL, starting with https://.';
  }

  if (values.description.trim().length > WEBHOOK_DESCRIPTION_MAX_LENGTH) {
    errors.description = `A description must be at most ${WEBHOOK_DESCRIPTION_MAX_LENGTH} characters.`;
  }

  if (values.eventTypes.length === 0) {
    errors.eventTypes = 'Choose at least one event to deliver.';
  }

  return errors;
}

export function hasErrors(errors: WebhookFormErrors): boolean {
  return Object.values(errors).some((message) => message !== undefined);
}

/** The body that adds an endpoint. An empty description is left out, not sent as "". */
export function createBody(values: WebhookFormValues): WebhookCreateBody {
  const description = values.description.trim();
  return {
    url: values.url.trim(),
    ...(description.length === 0 ? {} : { description }),
    eventTypes: WEBHOOK_EVENT_TYPES.filter((type) => values.eventTypes.includes(type)),
  };
}

/**
 * The body that changes an endpoint: only the fields that differ from what is
 * stored, or `null` when nothing does.
 *
 * Only what changed, for two reasons. The server reads the *shape* of a patch —
 * one that only switches an endpoint off is allowed on a plan that includes no
 * webhooks, and one that also resends the URL is not — so sending the whole form
 * would turn an always-allowed edit into a refused one. And an edit that resent
 * an unchanged URL would be audited as a change to it.
 *
 * A description emptied out is sent as `null`, which clears it; one that was
 * never set and is still empty is not sent at all. Events are compared as sets,
 * so ticking and unticking back is no change.
 */
export function patchBody(original: Webhook, values: WebhookFormValues): WebhookPatchBody | null {
  const patch: WebhookPatchBody = {};

  const url = values.url.trim();
  if (url !== original.url) patch.url = url;

  const description = values.description.trim();
  const stored = original.description ?? '';
  if (description !== stored) patch.description = description.length === 0 ? null : description;

  const next = WEBHOOK_EVENT_TYPES.filter((type) => values.eventTypes.includes(type));
  const before = new Set(original.eventTypes);
  const sameEvents = next.length === before.size && next.every((type) => before.has(type));
  if (!sameEvents) patch.eventTypes = next;

  return Object.keys(patch).length === 0 ? null : patch;
}

/** Whether the organisation already holds every endpoint its plan allows. */
export function atWebhookLimit(limit: WebhookListResponse['limit']): boolean {
  return limit.max !== null && limit.used >= limit.max;
}

/** An endpoint's state, as one badge. */
export function webhookStateCopy(webhook: Webhook): { label: string; tone: BadgeTone } {
  switch (webhook.state) {
    case 'active':
      return { label: 'Active', tone: 'success' };
    case 'paused':
      return { label: 'Paused', tone: 'warning' };
    default:
      return webhook.disabledReason === 'failures'
        ? { label: 'Switched off after failures', tone: 'danger' }
        : { label: 'Off', tone: 'neutral' };
  }
}

/**
 * A delivery's status, as one badge.
 *
 * `pending` reads two ways: a delivery nobody has attempted yet is queued, and
 * one that has failed and is waiting for its next attempt is retrying. The
 * attempt count is what tells them apart.
 */
export function deliveryStatusCopy(
  status: DeliveryStatus | string,
  attempts = 0,
): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'succeeded':
      return { label: 'Delivered', tone: 'success' };
    case 'delivering':
      return { label: 'Sending', tone: 'accent' };
    case 'pending':
      return attempts > 0
        ? { label: 'Retrying', tone: 'warning' }
        : { label: 'Queued', tone: 'neutral' };
    case 'abandoned':
      return { label: 'Gave up', tone: 'danger' };
    default:
      return { label: status, tone: 'neutral' };
  }
}

/**
 * A test delivery's outcome, as one badge.
 *
 * Not `deliveryStatusCopy`: a test is tried exactly once and never retried, so
 * a failed one comes back `abandoned`, and "Gave up" over a single attempt the
 * person pressed a button for a second ago describes a patience nobody showed.
 * It failed, and that is the word.
 */
export function testOutcomeCopy(status: DeliveryStatus | string): {
  label: string;
  tone: BadgeTone;
} {
  switch (status) {
    case 'succeeded':
      return { label: 'Delivered', tone: 'success' };
    case 'abandoned':
      return { label: 'Failed', tone: 'danger' };
    default:
      return { label: 'Queued', tone: 'neutral' };
  }
}

/**
 * Why the last attempt failed, as a sentence — or `null` when it did not.
 *
 * The server records a fixed category, never the receiver's response body: the
 * body is text a third party wrote, and this screen is the one place it would
 * end up displayed. A category this build does not know is one of the server's
 * own fixed sentences (an abandonment's reason), and is shown as it is.
 */
export function deliveryErrorText(
  lastError: string | null,
  lastStatusCode: number | null = null,
): string | null {
  if (lastError === null) return null;
  switch (lastError) {
    case 'timeout':
      return 'The endpoint did not answer in time.';
    case 'network':
      return 'The endpoint could not be reached.';
    case 'redirect':
      return lastStatusCode === null
        ? 'The endpoint answered with a redirect, which is never followed. Point the webhook at the final URL.'
        : `The endpoint answered with a redirect (HTTP ${lastStatusCode}), which is never followed. Point the webhook at the final URL.`;
    case 'invalid_url':
      return 'The URL is no longer one a webhook may be sent to. Edit the endpoint and give it an allowed URL.';
    case 'signing_failed':
      return 'xecret could not sign the delivery, so it was not sent. Try again; rotating the secret replaces it.';
    default: {
      const http = /^http_(\d{3})$/.exec(lastError);
      if (http !== null) return `The endpoint answered HTTP ${http[1]}.`;
      return lastError;
    }
  }
}

/** The receiver's HTTP status beside a delivery, where one answered. */
export function statusCodeText(code: number | null): string | null {
  return code === null ? null : `HTTP ${code}`;
}
