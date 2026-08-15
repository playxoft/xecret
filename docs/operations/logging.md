# Logging

**Version:** 1.0 · Structured JSON, shipped to Better Stack, mirrored to the Cloudflare log tail.

Every line the server emits is one JSON object carrying the request it belongs to, who made it,
which workspace it touched, and which function wrote it. That is the whole design goal: an
incident is reconstructed by filtering, not by grepping free text.

`message` is a **sentence describing what happened**, not a label:

```
Revealed the secret DATABASE_URL in acme/api/production
Refused to decrypt every secret in acme/api/production
Failed to write 3 buffered audit record(s) after the response — those events are now missing
  from the audit log and cannot be recovered
```

Not `request completed`. A label restates fields you already have and makes every line in the
stream look identical until you expand it.

---

## 1. Where lines go

| Destination | Always on | What it is for |
| --- | --- | --- |
| Cloudflare log tail | yes | `wrangler tail`, local development, and the case where log shipping is the outage |
| Better Stack | when configured | Retention, search, dashboards, alerting |

Better Stack is **optional**. A self-hoster with no token still gets everything on the console —
the same call this codebase makes for email. See `apps/web/src/server/logging/index.ts`.

### Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `BETTERSTACK_SOURCE_TOKEN` | no | A credential. Set with `wrangler secret put`, never committed. |
| `BETTERSTACK_INGEST_URL` | no | A source created after mid-2024 has its own `https://<id>.betterstackdata.com`. **Posting to the shared default with such a token answers 401 with nothing explaining why** — the same regional trap as ZeptoMail. |
| `XECRET_LOG_LEVEL` | no | `debug` \| `info` \| `warn` \| `error`. Defaults to `debug` in development, `info` elsewhere. |

`npm run check:env` validates all three.

---

## 2. The schema

Every line carries these. Fields appear as soon as they are known and stay for the rest of the
request — the request context is shared by reference, so binding the principal completes lines
from loggers that already existed.

### Always

| Field | Example | Notes |
| --- | --- | --- |
| `dt` | `2026-08-15T09:00:00.000Z` | Event time. Better Stack reads this — without it a batch flushed after the response would all land on one millisecond. |
| `level` | `error` | `debug` \| `info` \| `warn` \| `error` |
| `message` | `Revealed the secret DATABASE_URL in acme/api/production` | A sentence. See §3. |
| `event` | `secret.reveal` | **Stable key — group and alert on this, never on `message`.** Prose gets rephrased; this does not. Mirrors the audit log's action names. |
| `service` | `xecret-web` | |
| `env` | `production` | One Better Stack source usually receives staging *and* production. |
| `requestId` | `0198…` | **UUIDv7.** Time-ordered, so `ORDER BY requestId` is chronological. Also returned on `x-xecret-request-id`, and stamped on every audit record. |
| `rayId` | `8f1c…` | Cloudflare's ray id, for crossing into the platform's own logs. `null` outside the edge. |
| `method`, `path` | `GET`, `/api/orgs/acme/…` | |
| `ip`, `userAgent` | `203.0.113.5` | From `CF-Connecting-IP`, which the edge sets. |
| `fn` | `revealSecret` | The function that emitted the line. See §5. |

### Once authenticated

| Field | Notes |
| --- | --- |
| `actorType` | `user` \| `cli_token` \| `service_token` |
| `userId` | Absent for a service token, which acts as nobody. |
| `sessionId`, `tokenId` | Whichever credential was presented. |
| `credential` | `cookie` \| `bearer` |
| `accessLevel` | Service tokens only. |

### Once the path is resolved

Bound by the tenancy resolvers, so **every tenant-scoped line carries the workspace** without any
route remembering to say so.

| Field | Notes |
| --- | --- |
| `orgId`, `orgSlug` | The workspace. |
| `projectId`, `projectSlug` | |
| `environmentId`, `envSlug` | |
| `isProduction` | The one tenancy fact that changes how a line should be read. |

### On the completion line

| Field | Notes |
| --- | --- |
| `status` | HTTP status. |
| `outcome` | `success` \| `client_error` \| `server_error`. Derived so a dashboard need not express `status >= 500` in every panel. |
| `durationMs` | |

---

## 3. Messages

### The completion line

`describe-request.ts` maps every route to a verb and an object, and the outcome picks the tense:

| Status | Form | Example |
| --- | --- | --- |
| 2xx/3xx | past tense | `Revealed the secret DATABASE_URL in acme/api/production` |
| 401/403/404 | `Refused to …` | `Refused to reveal the secret DATABASE_URL in acme/api/production` |
| other 4xx | `Rejected a request to …` | `Rejected a request to write a new version of the secret PORT in acme/api/dev` |
| 5xx | `Failed to …` | `Failed to decrypt every secret in acme/api/production` |

"Refused" and "Failed" are different incidents. A reader should not have to check a status code
to tell an authorization decision from a broken system.

A route with no entry in the mapping still gets a sentence — `Served GET /api/something/new`
with `event: http.request`. That is a gap in the mapping to fill, not a silent line.

### Everything else

A message explains the **condition and what it implies**, not the step that produced it. The
function is already in `fn`; repeating it in the message wastes the sentence:

> A stored key is wrapped with root key version 2, which this deployment cannot supply. A key
> rotation was completed before every row had been re-wrapped; restore that version to
> `XECRET_ROOT_KEYS` to make these secrets readable.

Not `root key version unavailable`. Where a remedy is known, the message says it — the person
reading at 3am is not necessarily the person who wrote the code.

Messages are scrubbed and capped at 512 characters like any other string, because a sentence
built from a request contains a path the caller chose.

---

## 4. What is logged, at which level

| Level | Emitted for | In production |
| --- | --- | --- |
| `debug` | Request start; a 4xx rejection | off |
| `info` | Request completion | on |
| `warn` | Authorization denied, PIN attempt failed, identity verification failed — expected traffic worth a pattern | on |
| `error` | 5xx, audit write/flush failure, missing binding, decryption failure, mail failure | on, **alertable** |

One completion line per request, not a start/finish pair. A start line that is never followed by a
finish is indistinguishable from a finish that was dropped, and `durationMs` answers what the start
line was there for.

### Suggested alerts

Query on `event` and `level`, never on `message` — the prose is meant to be improved.

- `level:error` — any. These are broken guarantees, not traffic.
- `outcome:server_error` rate over 5 minutes.
- `event:secret.pull` — one request, every plaintext in an environment. The most sensitive read in the product.
- `event:secret.pull AND isProduction:true` grouped by `userId` — who bulk-read production, and how often.
- `level:error AND fn:settle` — the audit log is missing entries.
- `level:error AND fn:rethrowCryptoFailure` — tampering or a key mismatch.
- `fn:assertPinMatches` grouped by `userId` — a PIN brute force.
- `level:warn AND fn:failure` grouped by `userId` — an account probing for resources it cannot reach.

---

## 5. Writing a log line

Anything holding a `ServiceContext` logs with full attribution and nothing threaded through its
signature:

```ts
services.log
  .at('revealSecret')
  .warn(
    `Refused to reveal ${name}: the grant that allowed it expired, so the caller now has no ` +
      'access to this environment',
    { secretName: name, reason: 'grantExpired' },
  );
```

`at()` stamps `fn`. Name the function you are actually in — messages get copy-pasted between call
sites, function names do not.

For an error, `describeError` gives name, scrubbed message and the top four stack frames:

```ts
services.log.at('writeEvents').error('audit write failed', { error: describeError(cause) });
```

Use `errorName(cause)` instead where the message is known to embed a person's data — a mail
delivery failure embeds the recipient address.

Write the message as a sentence a colleague would understand without opening the file. State the
condition, and the consequence if there is one.

### What must never be logged

A secret value, a PIN, a session or service token, a CSRF token, a wrapped or unwrapped key, or a
ciphertext. The guarantee is held **at the call site**, the same way the audit metadata allowlist is
held.

`redact.ts` is defence in depth behind that, not a substitute for it:

- a field whose *name* suggests a credential is replaced with `[redacted]`, whatever it holds —
  and identifier-shaped names (`tokenId`, `sessionId`, `keyVersion`, `secretName`) survive, because
  those are what an investigation is conducted with;
- connection-string credentials, bearer tokens and inline `password=` pairs are stripped out of
  free text by pattern — the two documented leaks are a postgres.js message carrying the DSN and an
  `Authorization` header landing inside a fetch failure;
- strings are capped at 512 bytes, objects at 4 levels and 48 keys, arrays at 32 items.

---

## 6. Batching and delivery

Lines accumulate in memory for the life of the request and leave in **one** POST, handed to
`waitUntil` after the response has been sent.

- A Worker invocation may open six outgoing connections (ADR 0006) and the database already holds
  one. A POST per line would exhaust that on any request logging more than five times.
- Nothing about shipping is in front of the user.
- A batch is capped at 256 lines per request; drops are counted and reported *in* the batch, so a
  truncated request is visible as truncated.
- A failed flush — network, 401, timeout — replays the whole batch to the console and logs why.
  **A line that cannot be shipped is never silently dropped.**
- `write` cannot throw. An observability pipeline that can fail a request is worse than none.

---

## 7. Correlating an incident

1. The user quotes the `x-xecret-request-id` from the failed response.
2. `requestId:"0198…"` in Better Stack returns every line of that request, including the 500 with
   its stack.
3. The same id is on the `audit_logs` row, so "what did this request change?" is one query against
   the database.
4. `rayId` crosses into Cloudflare's own logs for anything below the application — TLS, edge, a
   Worker that never started.

Widening from there: `userId` for everything one person did, `orgId` for everything that touched one
workspace, `orgId AND isProduction:true` for the production blast radius.
