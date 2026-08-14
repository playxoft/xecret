# HTTP API

The contract the dashboard, the CLI, and CI all speak. Written before the handlers so the
client and server halves cannot drift, and so the security properties below are decisions
rather than accidents.

---

## 1. Shape

Base path `/api`. JSON in, JSON out, `Cache-Control: no-store` on every response.

Resources are addressed by **slug**, not by id:

```
/api/orgs/{orgSlug}/projects/{projectSlug}/environments/{envSlug}/secrets/{name}
```

This is a security property, not an aesthetic one. A slug is scoped to its parent, so the
path itself carries the tenancy chain and every handler must resolve it top-down through
membership. An id-addressed route (`/api/secrets/{uuid}`) invites the opposite: a single
lookup by primary key, with the tenancy check as a separate step a developer can forget.
That omission is the IDOR bug this product cannot afford (threat T2).

The cost is one join per level. It is paid once per request and is the reason the read path
budget is expressed in queries, not in convenience.

---

## 2. Authentication

Three credentials, resolved in this order. A request may present exactly one.

| Credential | Carried in | Actor | Used by |
|---|---|---|---|
| Session | `__Host-xecret_session` cookie | `user` | Dashboard |
| CLI token | `Authorization: Bearer xct_…` | `cliToken` (acts as its user) | `xecret` CLI |
| Service token | `Authorization: Bearer xst_…` | `serviceToken` (no user) | CI |

A cookie and a bearer token on the same request is a **rejected** request, not a precedence
question. Silently picking one is how a CSRF-able cookie ends up authorising a call the
client believed was bearer-authenticated.

### Service tokens are read-only in v1

The authorization engine permits `secret.create` and `secret.update` to a service token
holding a `write` grant, but the API refuses both with 403. The reason is
`secret_versions.created_by`: it is `NOT NULL` and references `users`, and a service token
has no user behind it by construction (threat T5).

The two ways out were both worse than the restriction:

- **Attribute the write to whoever created the token.** The "who changed this" column would
  then name a person for a write they did not make, in the one log a company reaches for
  during an incident.
- **Make `created_by` nullable.** That weakens attribution for *every* write in the product
  to accommodate a case v1 does not have.

The right fix is a nullable `created_by_service_token_id` alongside the user column, with a
check constraint requiring exactly one. That is a migration, and it belongs with the rest of
the CI work in Phase 8 rather than bolted onto Phase 4. Until then: CI reads secrets, and a
human or a CLI token writes them.

Firebase ID tokens are accepted at exactly one endpoint — `POST /api/auth/session` — and
never again. See ADR 0003.

### CSRF

Cookie-authenticated mutations require the double-submit pair: the `__Host-xecret_csrf`
cookie value echoed in the `X-Xecret-Csrf` header. Bearer-authenticated requests do not,
and must not — they carry no ambient credential for a browser to attach.

---

### There is no middleware, and there cannot be — ADR 0008

A `proxy.ts` (Next 16's rename of `middleware.ts`) that redirected signed-out visitors away
from `/app/**` was written and then removed. It cannot work on this stack:

- Next 16 **defaults Proxy to the Node.js runtime**, and the `runtime` config option "is not
  available in Proxy files. Setting the `runtime` config option in Proxy will throw an
  error." (`node_modules/next/dist/docs/.../proxy.md` §Runtime.)
- `@opennextjs/cloudflare` refuses to build a Node middleware — `useNodeMiddleware()` in
  `dist/cli/build/build.js` exits 1 with "Consider switching to Edge Middleware."

There is no configuration that satisfies both, so the dashboard layout performs the redirect
instead. Nothing is lost in security terms: the redirect was always a convenience, never a
control. Next's own documentation makes the same point — "Always verify authentication and
authorization inside each Server Function rather than relying on Proxy alone."

Every `/api/**` route authenticates and authorises independently, which is where the actual
boundary is and always was.

---

## 3. Errors

```json
{
  "error": {
    "code": "not_found",
    "message": "Not found.",
    "requestId": "8f2a…",
    "fields": [{ "field": "name", "message": "Secret name cannot start with a digit." }]
  }
}
```

| Code | Status | Meaning |
|---|---|---|
| `bad_request` | 400 | Malformed request |
| `validation_failed` | 422 | Body failed schema validation; `fields` populated |
| `unauthenticated` | 401 | No credential, or an invalid one |
| `forbidden` | 403 | Authenticated, membership established, action not permitted |
| `not_found` | 404 | Does not exist, is in another organisation, **or** is not visible to you |
| `conflict` | 409 | Name or slug already taken; version race |
| `payload_too_large` | 413 | Body over 1 MB, or a secret over 64 KB |
| `rate_limited` | 429 | Bucket exhausted |
| `csrf_failed` | 403 | Double-submit pair missing or mismatched |
| `session_locked` | 403 | Authenticated, but the session has not had its PIN entered recently |
| `unavailable` | 503 | Misconfigured deployment — a missing binding, an unreachable database |
| `internal_error` | 500 | Unhandled fault |

**404 and 403 are not interchangeable.** 403 is only ever returned once membership in the
organisation is already established, so it reveals nothing new. Everything else — wrong
tenant, no grant, genuinely absent — is 404. A client that can distinguish these can
enumerate another tenant's projects.

`message` is a fixed string. Nothing derived from an exception, a database error, or the
rejected input reaches the client; in this product the rejected input may be a secret value.

---

## 4. Endpoints

### Auth

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/auth/session` | Body `{ idToken }`. Verifies with Firebase, upserts the user, bootstraps a personal organisation on first login, sets the session and CSRF cookies. Rate limited: `RL_LOGIN`. |
| `DELETE` | `/api/auth/session` | Revokes the current session, clears both cookies. Idempotent. |
| `GET` | `/api/auth/me` | The signed-in user, their organisations, their role in each, and the PIN state. Exempt from the lock gate. |
| `GET` `POST` | `/api/auth/pin` | Read the PIN state; set or change the PIN. Changing one requires the current PIN. Rate limited: `RL_LOGIN`. Exempt from the lock gate. |
| `POST` | `/api/auth/pin/unlock` | Body `{ pin }`. Unlocks this session for 8 hours. Rate limited: `RL_LOGIN`, plus the per-account lockout. Exempt from the lock gate. |
| `POST` | `/api/auth/pin/lock` | Locks this session, or every session with `{ everywhere: true }`. Does **not** revoke — the user stays signed in. |
| `POST` | `/api/auth/pin/reset` | Emails a single-use reset link to the account's own address. Requires a session, so there is no enumeration oracle. Exempt from the lock gate. |
| `POST` | `/api/auth/pin/reset/confirm` | Body `{ token, pin }`. Requires the emailed token **and** a session belonging to the same account. Exempt from the lock gate. |
| `GET` | `/api/auth/sessions` | Active sessions for the "signed-in devices" view. Never returns a token hash. |
| `DELETE` | `/api/auth/sessions` | Sign out everywhere. Optional `?except=current`. |

`POST /api/auth/session` returns **401 with a fixed message** for every verification
failure — expired, wrong audience, bad signature, unverified email. The specific reason is
logged, never returned: telling a caller which part of a forged token to fix is a gift.

### CLI authorization — how `xecret login` gets its token

RFC 8252-style loopback flow with PKCE (S256 only), against this server — never Firebase
directly. The CLI opens `/cli/authorize?challenge&port&device&state` in a browser; an
already-signed-in person approves the named device; the consent screen redirects the
one-time code to `http://127.0.0.1:{port}/callback`; the CLI exchanges code + verifier.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/cli/authorize` | Session + CSRF only — a bearer credential may not mint further credentials, and the PIN lock gate applies. Body `{ orgSlug, deviceName, codeChallenge }`. Mints a single-use code (10 min TTL, hashed at rest, supersedes the user's outstanding codes). Requires active membership (`member.read`) — deliberately **not** `token.create`, which gates *service* tokens: a CLI token acts as its user and adds no authority. Rate limited: `RL_CLI_TOKEN`. Audited as `token.authorized`. |
| `POST` | `/api/cli/token` | Public — the caller holds no credential yet. Body `{ code, codeVerifier }`. The code is consumed atomically **before** the PKCE check, so a failed binding kills it rather than leaving it guessable. Membership is re-checked; the minted `xct_` token is returned exactly once. Every failure is the same fixed 401. Rate limited: `RL_CLI_TOKEN` by IP. Audited as `token.created`. |
| `DELETE` | `/api/cli/token` | The token revokes itself — `xecret logout`. CLI-token bearers only; idempotent; audited as `token.revoked` by the call that actually did it. |

Listing and revoking CLI tokens from the dashboard ("your devices") lands with the token
management routes in Phase 8.

### Members, invitations, grants

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/orgs/{orgSlug}/members` | `member.read`, which every active role holds. Names, emails, roles, status, join dates, and the seat count — never access grants, which are per-project and belong on the member's own page. |
| `POST` | `/api/orgs/{orgSlug}/members` | Invite by email. Session + CSRF only — an invitation is a minted credential, and a bearer credential may not mint further credentials (same rule as `/api/cli/authorize`). Requires `member.invite` **and** the role hierarchy: nobody hands out a role above their own. Supersedes any open invitation for the address; enforces the seat limit under the organisation lock. Returns the acceptance link **once**; only the token's hash is stored. Rate limited: `RL_INVITE` by org. Audited as `member.invited`. |
| `PATCH` | `/api/orgs/{orgSlug}/members/{memberId}` | Exactly one of `{ role }` or `{ status: active\|suspended }` per request — they are different acts with different audit records (`member.role_changed`, `member.suspended`, `member.reinstated`). Requires `member.update`, the role hierarchy on *both* sides (the role held and the role assigned), refuses self-changes, and the repository transaction enforces the last-owner invariant under the organisation lock. |
| `DELETE` | `/api/orgs/{orgSlug}/members/{memberId}` | Requires `member.remove` and the role hierarchy; refuses self-removal; last-owner guarded. Grants die with the membership (`ON DELETE CASCADE`). Audited as `member.removed`. |
| `PUT` `DELETE` | `/api/orgs/{orgSlug}/members/{memberId}/grants` | Create/replace or remove one grant, addressed by `{ projectSlug, environmentSlug?, accessLevel }` — `environmentSlug` absent or `null` means the whole project. Requires `member.update` + the hierarchy on the member being granted. Audited as `access.granted` / `access.revoked` with the previous and new levels. |
| `GET` | `/api/orgs/{orgSlug}/members/{memberId}/access` | The effective-permission preview: every project and environment with the member's resolved level and the rule that produced it (`environment-grant` / `project-grant` / `role-default` / `suspended`). Computed by the same `resolveAccessLevel` the enforcement path calls, so it cannot disagree with it. Own row: any member. Someone else's: `member.update`. |
| `GET` | `/api/orgs/{orgSlug}/invitations` | Open invitations, expired ones included (`state` says which). Gated on `member.invite`: who has been *asked* is recruitment metadata, not membership. |
| `DELETE` | `/api/orgs/{orgSlug}/invitations/{invitationId}` | Withdraws an open invitation; the emailed link stops working at commit. `member.invite`; audited as `invitation.revoked`. |

### Accepting an invitation

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/invitations/lookup` | Public — the holder may have no account yet. Body `{ token }`. Returns the organisation's display name, the invited address, role, state and expiry; nothing else. The token travels in the body, never the query string. Rate limited: `RL_INVITE` by IP. |
| `POST` | `/api/invitations/accept` | Session + CSRF. Body `{ token }`. The session's address must match the invited one — a forwarded email must not let a colleague join as somebody else. State, address, seat count and the membership insert are all settled inside one transaction under the organisation lock. Audited as `member.joined`. |

### Organisations

| Method | Path |
|---|---|
| `GET` | `/api/orgs` |
| `GET` | `/api/orgs/{orgSlug}` |
| `PATCH` | `/api/orgs/{orgSlug}` |

### Projects

| Method | Path |
|---|---|
| `GET` `POST` | `/api/orgs/{orgSlug}/projects` |
| `GET` `PATCH` `DELETE` | `/api/orgs/{orgSlug}/projects/{projectSlug}` |

`DELETE` is a soft delete. A hard delete would orphan the audit records that say the project
existed and who removed it.

### Environments

| Method | Path |
|---|---|
| `GET` `POST` | `…/projects/{projectSlug}/environments` |
| `GET` `PATCH` `DELETE` | `…/environments/{envSlug}` |

Creating an environment also creates its Env Data Key, in the same transaction. An
environment without a key cannot hold a secret and cannot be repaired without an operator.

### Secrets

| Method | Path | Notes |
|---|---|---|
| `GET` | `…/environments/{envSlug}/secrets` | **Masked.** Names, versions, timestamps, updater. No ciphertext leaves the database. |
| `POST` | `…/secrets` | Create. Body `{ name, value, note?, valueType? }`. |
| `GET` | `…/secrets/{name}` | **Reveal.** Decrypts one value. Audited as `secret.revealed` every time. |
| `PATCH` | `…/secrets/{name}` | Appends a new version. Body `{ value, valueType? }`. A value identical to the current one is a no-op, detected via `value_hmac` without decrypting. |
| `PUT` | `…/secrets/{name}` | Metadata only — `{ note?, valueType? }`. Appends **no** version and unwraps no key: declaring a type is not a rotation. |
| `DELETE` | `…/secrets/{name}` | Soft delete. |
| `GET` | `…/secrets/{name}/versions/{version}` | **Reveal one historical version.** Audited as `secret.revealed`, with the version in `reason`. The listing beside it stays metadata-only. |
| `GET` | `…/secrets/{name}/versions` | History. Metadata only — no ciphertext, no values. |
| `POST` | `…/secrets/{name}/restore` | Body `{ version }`. Re-appends an earlier value as a new version; never rewrites history. |

The masked listing and the reveal endpoint are **separate routes on purpose**. Decryption
happens in exactly one handler, so "where can a plaintext secret be produced?" has a
one-line answer that a reviewer can verify by grep.

### Bulk read — the path `xecret run` depends on

| Method | Path |
|---|---|
| `GET` | `…/environments/{envSlug}/pull?format=env\|json\|yaml\|shell\|docker` |

One environment, every current secret, decrypted server-side. Budget: **≤3 queries and 0
outgoing fetches**, constant in the number of secrets. Audited once per call as
`secret.read` with a count — not once per secret, which would make a 200-secret pull write
200 audit rows and turn the audit table into a denial-of-service surface against itself.

### Import / export

| Method | Path | Notes |
|---|---|---|
| `POST` | `…/environments/{envSlug}/import` | Body `{ content, format?, strategy, dryRun }`. `dryRun: true` returns the plan and writes nothing. |
| `GET` | `…/environments/{envSlug}/export?format=…` | Same data as `pull`, as a file download. |

The dry run and the real import call the **same** planning function, so the preview cannot
disagree with the outcome.

### Tokens, audit — **specified, not yet implemented**

These land in Phase 8. They are written down here because the data layer and the
authorization engine already support them, and agreeing the shape now is what keeps that
phase additive. **No handler exists for any of them today** — a request returns 404.

| Method | Path | Phase |
|---|---|---|
| `GET` `POST` | `/api/orgs/{orgSlug}/tokens/cli` | 8 |
| `GET` `POST` | `/api/orgs/{orgSlug}/tokens/service` | 8 |
| `DELETE` | `/api/orgs/{orgSlug}/tokens/{kind}/{tokenId}` | 8 |
| `GET` | `/api/orgs/{orgSlug}/audit` | 8 |

A created token's value will be returned **once**, in the creation response, and is never
retrievable again. Only its hash is stored — the repository layer already enforces this,
and no listing function selects `token_hash`. The same rule already governs the
invitation link above.

---

## 5. Pagination

Keyset, not offset:

```
GET …/secrets?limit=50&cursor=<opaque>
→ { "data": [...], "nextCursor": "…" | null }
```

Offset pagination re-scans on every page and shifts under concurrent inserts, so a row can
be skipped or repeated between pages. On the append-only, month-partitioned audit table
that degradation is severe. `limit` is clamped to 200.

---

## 6. Rate limits

| Bucket | Applies to | Key |
|---|---|---|
| `RL_LOGIN` | `POST /api/auth/session` | IP + Firebase subject |
| `RL_CLI_TOKEN` | CLI token creation and exchange | user id |
| `RL_INVITE` | Invitations | org id |
| `RL_SECRET_READ` | Reveal and pull | actor id |
| `RL_SERVICE` | Service-token requests | token id |
| `RL_MUTATION` | Every other write | actor id |

Counters are per-colo, not global — abuse control, not a security boundary. What actually
protects a secret is authentication, authorization, and the audit trail.

---

## 7. What is audited

Every mutation, every decryption, and **every denial**. A system that records only what
succeeded cannot detect an attack in progress.

Audit metadata is typed as an allowlist with no index signature, so a secret value cannot be
placed in a record — the type system rejects it rather than a reviewer having to notice.
