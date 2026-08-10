# xecret System Architecture

**Version:** 1.0 · **Date:** 2026-08-10

Decisions referenced here are recorded in [`docs/adr/`](../adr/). This document describes how
they fit together.

---

## 1. Components

```
                    ┌──────────────────┐        ┌──────────────────┐
                    │     Browser      │        │  Go CLI / CI     │
                    │  Next.js client  │        │  xecret binary   │
                    └────────┬─────────┘        └────────┬─────────┘
                             │ session cookie            │ Bearer token
                             │ (__Host-, HttpOnly)       │ (CLI or service)
                             └─────────────┬─────────────┘
                                           │ HTTPS
                    ┌──────────────────────▼──────────────────────┐
                    │        Cloudflare Worker (OpenNext)          │
                    │                                              │
                    │  RSC pages ·  Route handlers ·  Server actions│
                    │  ─────────────────────────────────────────── │
                    │  authn → authz → validate → act → audit      │
                    │  ─────────────────────────────────────────── │
                    │  packages/core: crypto · authz · audit        │
                    │  Root KEK held as non-extractable CryptoKey   │
                    └───┬────────────┬────────────┬────────────┬───┘
                        │            │            │            │
                 Hyperdrive       KV          Secrets      Rate Limit
                        │            │         Store        binding
                        ▼            ▼            ▼            ▼
                ┌──────────────┐  JWKS      Root KEK      per-endpoint
                │ Neon Postgres│  cache     (deploy-time  buckets
                │  ciphertext  │            from Phase)
                │  + metadata  │
                └──────────────┘
```

External services touched **at deploy time only**: Phase.dev.
External services touched **at login only**: Firebase (token verification, via cached JWKS).
External services touched **on the secret-read path**: none.

---

## 2. The request pipeline

Every protected route runs the same five stages, in this order, with no exceptions:

```
1. AUTHENTICATE   resolve the actor from a session cookie or Bearer token
                  → 401 if unresolvable
2. AUTHORIZE      can(actor, action, resource) in packages/core/authz
                  → 404 if the actor may not know the resource exists
                  → 403 only when existence is already known to them
3. VALIDATE       Zod schema on every input, including path params
                  → 400 with field-level messages
4. ACT            business logic; decryption happens here if at all
5. AUDIT          emit an event — success, denial, or error alike
```

**Why 404 rather than 403 for cross-tenant access:** a 403 confirms the resource exists,
which is itself an information leak. A member of org A probing org B's project IDs must not
be able to distinguish "exists but forbidden" from "does not exist".

Authorization is evaluated **per request against current database state**. It is never baked
into a token. Revoking a member's access takes effect on their next request, including for
already-issued CLI tokens.

---

## 3. Authentication paths

### 3.1 Browser

```
Firebase JS SDK (Google or email+password)  →  Firebase ID token
                                                     │
POST /api/auth/session  { idToken }  ────────────────┘
   │
   ├─ verify RS256 against Google JWKS (firebase-auth-cloudflare-workers, JWKS in KV)
   ├─ assert aud == FIREBASE_PROJECT_ID, iss, exp, email_verified
   ├─ upsert user by firebase_uid
   ├─ insert sessions row  (store SHA-256 of a 256-bit opaque token — never the token)
   └─ Set-Cookie: __Host-xecret_session; HttpOnly; Secure; SameSite=Lax; Path=/
```

The Firebase ID token is used exactly once and then discarded. See
[ADR 0003](../adr/0003-firebase-as-identity-provider.md).

### 3.2 CLI — loopback + PKCE against *our* server

```
xecret login
   ├─ generate code_verifier (256-bit) + code_challenge = S256(verifier)
   ├─ bind an ephemeral listener on 127.0.0.1:<random port>
   ├─ open browser → /cli/authorize?challenge=…&port=…&device=<hostname>
   │       user (already signed in, or signs in) sees a consent screen naming the device
   ├─ browser redirects → http://127.0.0.1:<port>/callback?code=…
   ├─ POST /api/cli/token { code, code_verifier }  → refresh token
   └─ store refresh token in the OS keychain
```

The one-time code is single-use, expires in 60 seconds, and is bound to the challenge.
Firebase tokens are never used as CLI credentials. Nothing is ever printed to the terminal.

### 3.3 CI — service token

```
XECRET_TOKEN=xct_… xecret run -- npm run build
```

No interactive step. The token is scoped to one project + one environment, read-only by
default, carries no user identity, and every use is audited with its source IP.

---

## 4. The secret read path

This is the hot path and the one to protect from regressions.

```
CLI ──GET /api/v1/secrets?project=…&environment=…──▶ Worker
                                                       │
  1. resolve actor from Bearer token (single indexed lookup by token hash)
  2. can(actor, 'secret.read', environment)  — one query, joins membership + grants
  3. load env_key (wrapped) + all secret_versions for the environment  — one query
  4. unwrap: Root KEK (in memory) → Org key → Env key
  5. decrypt each ciphertext with AES-256-GCM, verifying AAD
  6. emit ONE audit event: secret.read, N secrets, actor, env, IP
  7. respond { NAME: value, … } over TLS
```

**Three database queries. Zero outgoing `fetch` calls.** The Root KEK is already in isolate
memory; JWKS is not consulted (this is a Bearer token, not a Firebase token); Phase.dev is
not involved.

This matters because a Worker invocation may only have **6 outgoing connections in flight**
at once. Designs that call an external KMS per secret would queue and degrade precisely as a
customer's secret count grows. See [ADR 0002](../adr/0002-root-key-custody.md).

**AAD binding.** Each ciphertext is authenticated against
`org_id ‖ environment_id ‖ secret_id ‖ version`. Moving a ciphertext row to another
environment or secret makes decryption *fail* rather than silently succeed — a database-write
attacker cannot relocate a production secret into an environment they can read.

---

## 5. Where decryption is and is not allowed

| Surface | Decrypts? | Why |
|---|---|---|
| Dashboard secret list | **No** | Names and metadata only. Loading a page must never decrypt. |
| Dashboard "reveal" on one secret | Yes | Explicit user action, audited, single secret. |
| `xecret run` / `pull` | Yes | The entire purpose. One audit event for the batch. |
| Audit log rendering | **Never** | Audit records contain no values, by construction. |
| Any log, trace, or error path | **Never** | Enforced by the audit event builder and a redaction layer. |
| Search / filter | **No** | Operates on names and metadata only. |

---

## 6. Rate limiting

Cloudflare's native rate-limit binding (GA) — no Redis, no database counters on the hot path.

| Bucket | Limit | Keyed on |
|---|---|---|
| Login / session create | strict | IP + email |
| CLI token exchange | strict | IP |
| Invitation accept | strict | IP + token |
| Secret read (interactive) | moderate | user |
| Secret read (service token) | generous | token — CI must not be throttled into failure |
| Dashboard reads | moderate | user |
| Mutations | moderate | user |

Slow-moving abuse that a request-rate limiter cannot see — invitation spam, failed logins
across many IPs — is counted in the database and evaluated per action, not per request.

---

## 7. Deployment and configuration flow

```
Developer laptop                     CI / deploy                     Runtime
────────────────                     ───────────                     ───────
phase run -- npm run dev             phase run -- wrangler deploy    env bindings
   │                                     │                              │
   └─ secrets in process env             └─ pushes to CF Secrets Store  └─ no network
      never on disk                         and Worker bindings
```

No `.env` file exists on any developer machine. `.env.example` documents variable *names*
only and holds no values.

---

## 8. Failure modes

| Failure | Effect | Recovery |
|---|---|---|
| Neon unavailable | API down; **CLI falls back to its encrypted local cache** with a loud warning | Neon failover; cache keeps developers working |
| Firebase unavailable | New logins fail; existing sessions and all CLI/CI operations continue | Wait |
| Phase.dev unavailable | No effect on runtime; deploys blocked | Wait — see key-recovery §4.1 |
| Cloudflare Secrets Store entry deleted | **Total outage** — nothing decryptable | Re-deploy from Phase.dev |
| Root KEK lost | **Permanent, total data loss** | Escrow only — see [key-recovery](../security/key-recovery.md) |

The CLI's encrypted offline cache is what prevents an xecret outage from becoming an outage
for every customer's local development and CI. It is a core feature, not a convenience.

---

## 9. Performance budget

| Metric | Budget | Enforced by |
|---|---|---|
| Worker bundle (compressed) | < 10 MB hard, < 6 MB target | CI check that fails the build |
| Secret read, p50 | < 100 ms | Load test in Phase 10 |
| Secret read, p99 | < 300 ms | Load test in Phase 10 |
| DB queries per secret read | ≤ 3 | Query-count assertion in integration tests |
| Outgoing `fetch` on read path | **0** | Code review + test |
| CLI startup | < 30 ms | Benchmark in CI |
| CPU per request | < 50 ms | Cloudflare analytics (limit is 30 s; we are nowhere near it) |
