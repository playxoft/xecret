---
title: HTTP API overview
navTitle: Overview
description: The contract the dashboard, CLI and CI all speak — authentication, request shape, error codes, pagination, rate limits and CSRF.
keywords: [xecret api, secrets rest api, bearer token api, api error codes, rate limits, csrf]
updated: 2026-08-16
---

Everything the dashboard does, the CLI does, and CI does, it does through this
API. There is no private back channel.

You will rarely need it directly — `xecret run` is the supported path — but it
is here, documented, for tooling you build yourself.

## Shape

Base path `/api`. JSON in, JSON out, and `Cache-Control: no-store` on every
response.

Resources are addressed by **slug**, never by id:

```http
GET /api/orgs/acme/projects/checkout-api/environments/production/secrets/DATABASE_URL
```

This is a security property rather than an aesthetic one. A slug only means
something inside its parent, so the path itself carries the ownership chain and
every handler must resolve it top-down through your membership. An
id-addressed route (`/api/secrets/{uuid}`) invites the opposite: one lookup by
primary key, with the ownership check as a separate step somebody can forget.
That omission is the classic broken-access-control bug, and it is the one this
product cannot afford.

The cost is one join per level, paid once per request.

## Authentication

Three credentials. **A request presents exactly one.**

| Credential | Carried in | Acts as | Used by |
|---|---|---|---|
| Session | `__Host-xecret_session` cookie | you | the dashboard |
| CLI token | `Authorization: Bearer xct_…` | you | the `xecret` CLI |
| Service token | `Authorization: Bearer xst_…` | the token itself | CI |

A cookie **and** a bearer token on the same request is a rejected request, not
a precedence question. Silently picking one is how a cookie that a browser
attaches automatically ends up authorising a call the client believed was
bearer-authenticated.

```bash
curl https://xecret.playxoft.com/api/tokens/self \
  -H "Authorization: Bearer $XECRET_TOKEN"
```

Full detail on each credential, including what a service token may and may not
do: [tokens](api/tokens.md).

### CSRF

Cookie-authenticated mutations require a double-submit pair: the value of the
`__Host-xecret_csrf` cookie echoed in an `X-Xecret-Csrf` header.

Bearer-authenticated requests do not need it, and must not send it — they carry
no ambient credential for a browser to attach on your behalf, which is the
entire thing CSRF protection defends against.

### Some things only a session can do

Minting a credential is never something a credential can do. These endpoints
require a browser session and reject bearer tokens:

- creating a service token or a CLI authorization code
- inviting a member
- creating or deleting an organisation
- deleting an account

The rule behind it: **a bearer credential may not mint further credentials.**
A leaked CI token must not be able to grow itself into a permanent one.

## Errors

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Request body failed validation.",
    "requestId": "8f2a…",
    "fields": [
      { "field": "name", "message": "Secret name cannot start with a digit." }
    ]
  }
}
```

| Code | Status | Meaning |
|---|---|---|
| `bad_request` | 400 | Malformed request |
| `validation_failed` | 422 | Body failed schema validation; `fields` is populated |
| `unauthenticated` | 401 | No credential, or an invalid one |
| `forbidden` | 403 | Authenticated, membership established, action not permitted |
| `not_found` | 404 | Does not exist, is in another organisation, **or** is not visible to you |
| `conflict` | 409 | Name or slug taken; version race |
| `payload_too_large` | 413 | Body over 1 MB, or a secret over 64 KB |
| `rate_limited` | 429 | Bucket exhausted |
| `csrf_failed` | 403 | Double-submit pair missing or mismatched |
| `session_locked` | 403 | Authenticated, but the session's PIN has not been entered recently |
| `unavailable` | 503 | Misconfigured deployment — a missing binding, an unreachable database |
| `internal_error` | 500 | Unhandled fault |

### 404 and 403 are not interchangeable

403 is returned **only** once your membership in the organisation is already
established, so it reveals nothing you did not already know. Everything else —
wrong tenant, no grant, genuinely absent — is 404.

A client that could tell those apart could enumerate another company's
projects by watching which ones answer 403 rather than 404.

### Messages are fixed strings

`message` is never derived from an exception, a database error, or the input
that was rejected. In this product the rejected input may itself be a secret
value. `requestId` is what correlates a report with the server's logs.

## Pagination

Keyset, not offset:

```http
GET /api/orgs/acme/.../secrets?limit=50&cursor=<opaque>
```

```json
{ "data": [ … ], "nextCursor": "…" }
```

`nextCursor` is `null` on the last page. `limit` is clamped to 200.

Offset pagination re-scans on every page and shifts under concurrent inserts,
so a row can be skipped or repeated between pages. On the append-only audit
table, that degradation is severe.

## Rate limits

| Bucket | Applies to | Counted per |
|---|---|---|
| `RL_LOGIN` | sign-in, PIN operations | IP + identity |
| `RL_CLI_TOKEN` | CLI token creation and exchange | user |
| `RL_INVITE` | invitations | organisation |
| `RL_SECRET_READ` | reveal and pull | actor |
| `RL_SERVICE` | service-token requests | token |
| `RL_MUTATION` | every other write | actor |

Exhausting one returns 429. Counters are per-datacentre rather than global —
they are abuse control, not a security boundary. What actually protects a
secret is authentication, authorisation and the audit trail.

## What is audited

Every mutation, every decryption, and **every denial**. A system that records
only what succeeded cannot detect an attack in progress.

Audit metadata is typed as a fixed allowlist of fields with no catch-all, so a
secret value cannot be placed into a record — the type system rejects it rather
than a reviewer having to notice. See [the audit log](security/audit-log.md).

## Next

- [Endpoint reference](api/reference.md) — every route.
- [Tokens](api/tokens.md) — how to get a credential and what it can do.
- [The CLI](cli.md) — the supported way to use all of this.
