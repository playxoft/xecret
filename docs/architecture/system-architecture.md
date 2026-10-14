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
                    └───┬───────────────────┬──────────────────┬───┘
                        │                   │                  │
                 Hyperdrive              Secrets           Rate Limit
                        │                 Store             binding
                        ▼                   ▼                  ▼
                ┌──────────────┐        Root KEK          per-endpoint
                │ Neon Postgres│        (deploy-time      buckets
                │  ciphertext  │         from Phase)
                │  + metadata  │
                └──────────────┘
```

External services touched **at deploy time only**: Phase.dev.
External services touched **at sign-in only**: WorkOS — one authenticated code exchange per
sign-in, plus a read of the organisation's verified domains for an SSO sign-in. The vault
reset's emailed code is the only other call, and only on that path.
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
GET /api/auth/login?next=…
   ├─ validate next (same-origin path only)
   ├─ Set-Cookie: __Host-xecret_oauth_state  (HMAC-signed: state, PKCE verifier, next,
   │                                          purpose; HttpOnly; SameSite=Lax; 10 min)
   └─ 307 → AuthKit hosted pages (password · Google · MFA · SSO)
                                                     │
GET /api/auth/callback?code=…&state=…  ◀─────────────┘
   │
   ├─ rate limit (IP); verify the state cookie (MAC, age, constant-time match); clear it
   ├─ authenticateWithCode(code, code_verifier)  — one authenticated call to WorkOS
   ├─ refuse impersonation · unverified email · SSO outside the org's verified domains
   ├─ rate limit (IP + WorkOS user id)
   ├─ link: workos_user_id → else the verified address → else create (upsertUserFromWorkosIdentity)
   ├─ sso_required · just-in-time membership · personal organisation if none
   ├─ insert sessions row  (store SHA-256 of a 256-bit opaque token — never the token)
   ├─ Set-Cookie: __Host-xecret_session; HttpOnly; Secure; SameSite=Lax; Path=/
   └─ 303 → next
```

The browser never holds a provider token. The authorization code is exchanged once, server to
server, and the access and refresh tokens WorkOS returns with it are discarded unread. Every
refusal is a 303 to `/sign-in?error=<code>`. See
[ADR 0010](../adr/0010-workos-as-identity-provider.md), which supersedes the Firebase design of
[ADR 0003](../adr/0003-firebase-as-identity-provider.md) and keeps its central decision: the
provider proves who somebody is, once, and every session after that is ours.

The linking pass is the one piece of logic that decides which account a returning person
lands in: match `workos_user_id` (deleted accounts are refused, not skipped); else adopt the
account holding the same **verified** address, under ASCII-only case folding; else create one.
Everything after it — the session row, the cookie — is the same as it was under Firebase.

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
Identity-provider tokens are never used as CLI credentials — none is ever kept. Nothing is
ever printed to the terminal.

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
memory; the identity provider is not consulted (it is asked only at sign-in, and this is a
Bearer token of ours); Phase.dev is not involved.

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
| Sign-in callback | strict | IP, then IP + WorkOS user id |
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
Developer laptop                 CI / deploy                              Runtime
────────────────                 ───────────                              ───────
phase run -- npm run dev         phase run -- sh scripts/deploy-web.sh    env bindings
   │                                │                                        │
   └─ secrets in process env        └─ reads wrangler.toml for that env,     └─ no network
      never on disk                    builds with its origin, uploads the
                                       Worker and binds what it names
```

No `.env` file exists on any developer machine. `.env.example` documents variable *names*
only and holds no values.

The deploy is a script rather than a bare `wrangler deploy` for one reason worth stating here:
a deployment is a *build* and an *upload*, and only the upload can read `wrangler.toml`. The
documentation and marketing pages are prerendered, so each one's canonical URL, its sitemap
entry and the `Host` line in `robots.txt` are decided while `next build` runs — before any
binding exists. The script closes that gap by resolving the environment's `vars` itself and
exporting them into the build, which is what makes the origin in the HTML and the origin the
Worker answers on the same string rather than two strings kept in step by hand.

Nothing about the identity provider reaches the build: sign-in is a server-initiated redirect,
so the client bundle carries no provider configuration. `WORKOS_CLIENT_ID` is a per-environment
var in `wrangler.toml`, which the script refuses to deploy without, and `WORKOS_API_KEY` and
`WORKOS_COOKIE_PASSWORD` are Worker secrets that originate in Phase.dev. The redirect URI is
derived from `XECRET_PUBLIC_URL` at runtime rather than configured.

The account's Secrets Store entry and the Hyperdrive resource are created once by
`scripts/deploy-bootstrap.sh`, not by a deploy — a deploy binds those resources and fails if
they are absent. See [key recovery §3](../security/key-recovery.md) for why that separation is
deliberate.

---

## 8. Failure modes

| Failure | Effect | Recovery |
|---|---|---|
| Neon unavailable | API down; **CLI falls back to its encrypted local cache** with a loud warning | Neon failover; cache keeps developers working |
| WorkOS unavailable | New sign-ins and vault resets fail, and the sign-in page says sign-in is unavailable; existing sessions and all CLI/CI operations continue | Wait |
| ZeptoMail unavailable, or refusing | **Vault resets are refused** (503, nothing reset): the escape archive is emailed before every reset, and a failed send stops it. Invitations fall back to a shareable link; PIN-reset mail is not sent. A production deployment with no mail configured at all refuses every reset | Wait; each retry needs a fresh sign-in and code |
| Cron Trigger missing or failing | **Nothing is purged**: reset vaults stay in the database past their seven days. Nothing is exposed — every read filters by the window, so an expired vault is unreachable — but the retention promise is broken until it runs | Restore `[env.production.triggers]` and redeploy; the next run purges the backlog in batches (the deployment-check skill's post-deploy step) |
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
