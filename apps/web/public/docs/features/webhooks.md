---
title: Webhooks on secret change
navTitle: Webhooks
description: Get a signed HTTPS call when a secret is created, changed, rotated or deleted, or an environment is promoted or restored. Payloads carry names, never values.
keywords: [secret change webhook, standard webhooks, webhook signature verification, secret rotation notification, devops automation]
updated: 2026-10-21
---

A webhook calls an HTTPS endpoint of yours when something changes in your
organisation's secrets. Pro includes 3 endpoints, Team 25, Enterprise as many as
you need. Set them up in *Organisation settings → Webhooks* (owners and admins).

## Events

| Event | When |
|---|---|
| `secret.created` | A secret is created — directly, by an import, a promotion or a restore |
| `secret.updated` | A secret's value changes, or it is renamed |
| `secret.deleted` | A secret is deleted — directly, or by a promotion or a restore |
| `secret.rotated` | An earlier version is made current again |
| `environment.promoted` | A [promotion](promotion-and-restore.md#promotion) lands, with counts |
| `environment.restored` | A [point-in-time restore](promotion-and-restore.md#point-in-time-restore) lands, with counts |

Writing a value identical to the current one changes nothing and sends nothing.
Each endpoint subscribes to the events it wants.

### One event per kind of change, not per secret

An import, a promotion or a restore can change hundreds of secrets in one go.
It sends **one event of each kind it caused** — one `secret.created` for
everything it created, one `secret.updated`, one `secret.deleted` — listing the
secrets in `data.secrets`, with `data.counts` saying how many:

```json
{
  "type": "secret.created",
  "timestamp": "2026-10-20T09:30:00.000Z",
  "data": {
    "organization": { "id": "0193…", "slug": "acme" },
    "project": { "id": "0193…", "slug": "checkout-api" },
    "environment": { "id": "0193…", "slug": "staging" },
    "secrets": [
      { "name": "SENTRY_DSN", "version": 1 },
      { "name": "STRIPE_WEBHOOK_SECRET", "version": 1 }
    ],
    "counts": { "created": 2 },
    "actor": { "type": "user", "id": "0193…", "label": "dana@acme.example" }
  }
}
```

An event about one secret carries `data.secret`; an event about several carries
`data.secrets` instead — never both — so handle both shapes. The list holds at
most 1,000 entries, which is also the most one batch can change.

## The payload never contains a value

Names, slugs, version numbers, counts and who did it — the same vocabulary as
the [audit log](../security/audit-log.md). Anybody who wants the value fetches
it with a credential, and is audited doing so.

```json
{
  "type": "secret.updated",
  "timestamp": "2026-10-20T09:30:00.000Z",
  "data": {
    "organization": { "id": "0193…", "slug": "acme" },
    "project": { "id": "0193…", "slug": "checkout-api" },
    "environment": { "id": "0193…", "slug": "production" },
    "secret": { "name": "STRIPE_SECRET_KEY", "version": 7 },
    "actor": { "type": "user", "id": "0193…", "label": "dana@acme.example" }
  }
}
```

## Verifying the signature

Every delivery is signed with the [Standard Webhooks](https://www.standardwebhooks.com/)
scheme — the same one xecret consumes from its own payment provider — using the
endpoint's `whsec_…` secret. It is shown **once**, when the endpoint is created
or its secret rotated; xecret stores it encrypted and never shows it again.

Three headers arrive with each request: `webhook-id`, `webhook-timestamp` (Unix
seconds) and `webhook-signature` (`v1,` and a base64 HMAC-SHA256). Sign
`id.timestamp.body` with the base64-decoded part of the secret after `whsec_`,
compare in constant time, and reject a timestamp more than five minutes away
from your clock:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret: string, headers: Headers, body: string): boolean {
  const id = headers.get('webhook-id') ?? '';
  const timestamp = headers.get('webhook-timestamp') ?? '';
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  return (headers.get('webhook-signature') ?? '')
    .split(' ')
    .map((part) => Buffer.from(part.replace(/^v1,/, ''), 'base64'))
    .some((given) => given.length === expected.length && timingSafeEqual(given, expected));
}
```

Verify against the raw body, before parsing it. The official Standard Webhooks
libraries do all of this for you.

## Delivery and retries

A 2xx response is a success; anything else — including a redirect, which is
never followed — is a failure. Each attempt waits up to ten seconds. A failed
delivery is retried with backoff — 1 minute, 5 minutes, 30 minutes, 2 hours, 6
hours, 12 hours and 24 hours after each failure, give or take the five minutes
between delivery sweeps — then abandoned. A retry sends the same body,
re-signed with a fresh timestamp, under the same `webhook-id`, so use it to
discard duplicates.

The first few deliveries of a change are sent straight away; anything left over,
and every retry, is sent by the next delivery sweep. A sweep takes organisations
**in turns** — every organisation's oldest delivery before anybody's second — so
another organisation's large backlog never holds yours up, and keeps sending
until nothing is due or its time is up, when the rest waits for the next sweep.

An endpoint that keeps failing — 15 failures in a row spanning at least a day —
is **disabled automatically**, and the organisation's owners and admins are
emailed. Re-enable it from the dashboard once it is fixed.

Each endpoint has a delivery log — status, attempts, the response code, the
body sent — and a *Send test* button that sends one `webhook.test` delivery.

Endpoint URLs must be `https://`, and may not point at a private, loopback or
link-local address.

## If your plan changes

Your endpoints are kept. On a plan with no webhooks they are paused — nothing is
sent, and the dashboard says why — and resume when the plan includes them again.

## Next

- [Promotion and restore](promotion-and-restore.md) — the environment-wide events.
- [The audit log](../security/audit-log.md) — the same facts, kept forever.
