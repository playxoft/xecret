# xecret — Implementation Plan v2

> Open-source, developer-first secret management.
> Powered by Playxoft.

**Status:** M0, M1, M2 and **M3's build half** complete — Phases 7 (teams), 8 (CI +
audit) and 9 (launch material) are built. Phase 10 (security audit, performance,
production) is what remains, together with the standing integration caveat below.
**Supersedes:** `plan1.md` (kept for reference — this doc is the source of truth).

**Progress:** ▓▓▓▓▓▓▓▓▓▓░ 10 of 11 phases done

| Phase | Status | Branch |
|---|---|---|
| 0 · Decisions & threat model | ✅ merged | — |
| 1 · Repo foundation | ✅ merged | — |
| 2 · Crypto core | ✅ merged | `feat/crypto-core` |
| 3 · Auth & organisations | ✅ merged | `feat/auth-organizations` |
| 4 · Projects, environments, secrets API | ✅ merged | `feat/secrets-api` |
| 5 · Dashboard UI | ✅ merged | `feat/dashboard-ui` |
| 6 · Go CLI v1 | ✅ built | `feat/cli-v1` |
| 7 · Team, roles, granular access | ✅ built | `feat/teams-roles` |
| 8 · CI, service tokens, audit logs | ✅ built | `feat/ci-service-tokens` |
| 9 · Landing page, docs, open source | ✅ built | `feat/launch-ready` |
| 10 · Security audit, performance, production | ⬜ | |

> Phases 7–9 are stacked branches on `feat/cli-v1` (7 → 8 → 9), so each merges in
> order once reviewed.

> **Nothing here has run against a real database.** Every query is verified by shape
> (`.toSQL()` assertions) and every pure rule by unit test, but no code path has touched
> PostgreSQL, Firebase, or Cloudflare. Integration testing is the first task once the Neon
> project and the Phase.dev values exist. A test suite that has never seen its own database
> proves the code is *consistent*, not that it *works*.

> **Configuration:** all secrets come from **Phase.dev** (`phase run -- <cmd>`). No `.env`
> file exists on any machine. Variable names the code expects are listed in `.env.example`;
> values are added in the Phase.dev dashboard. Code is written against these names now and
> verified against real infrastructure later.

---

## 0. Locked decisions

These are decided. Do not re-open them without an ADR.

| # | Decision | Choice |
|---|---|---|
| D1 | Product name | **xecret** — CLI binary `xecret` |
| D2 | Trust model | **Doppler-style**: server-side envelope encryption. The server *can* decrypt. Documented honestly. E2E is a v2 option, not v1. |
| D3 | Hosting | Cloudflare Workers, **Paid plan** |
| D4 | Web framework | Next.js 16.3 (App Router) via `@opennextjs/cloudflare` |
| D5 | Database | Neon PostgreSQL |
| D6 | Auth provider | **Firebase Auth** (Google + email/password), verified on the edge via `firebase-auth-cloudflare-workers`. `firebase-admin` never enters the repo. |
| D7 | CLI language | **Go** (single static binary, no runtime, ideal for CI images) |
| D8 | Repo layout | **Monorepo** — web + CLI + shared packages in one repo |
| D9 | No Redis | Cloudflare native primitives instead |
| D10 | Root key custody | **Phase.dev** as source of truth → synced to **Cloudflare Secrets Store** at deploy time → read from a binding at runtime. Offline Shamir escrow as backup. |
| D11 | Firebase role | Identity provider **only** — xecret issues its own sessions |
| D12 | DB access | **Drizzle ORM + Hyperdrive + `postgres.js`** |
| D13 | Licence | **AGPL-3.0** (server) + **MIT** (CLI & client SDKs) + CLA |

### Verified platform facts (Aug 2026)

Researched, not assumed:

- **Workers Paid limits:** 10 MB compressed / 64 MB uncompressed script; **30 s CPU default** (raisable to 5 min) — *not* 10 ms, that's the free tier; 10,000 subrequests/request; 128 MB memory; **only 6 simultaneous outgoing connections** per invocation ← this one shapes the design.
- **OpenNext Cloudflare** supports all Next.js 16 minors. Next 16.2 shipped a stable Adapter API built with Cloudflare + OpenNext.
- **Rate Limiting binding is GA** (since Sep 2025, wrangler ≥ 4.36.0). No Redis, no DB counters for the hot path.
- **Neon on Workers:** Hyperdrive + a native driver (`postgres.js` / `pg`) is the fastest and Cloudflare-recommended path. The Neon serverless HTTP driver is the fallback for self-hosters without Hyperdrive.
- **Firebase Admin SDK does not run on Workers** (Node-native deps). ID tokens must be verified as plain RS256 JWTs against Google's JWKS using Web Crypto.

---

## 1. Key management architecture (decided)

### D10 — Root key custody: Phase.dev → Cloudflare Secrets Store

**The key hierarchy:**

```
Root KEK  ──wraps──▶  Org Master Key  ──wraps──▶  Env Data Key  ──encrypts──▶  Secret Version
(never in DB)         (wrapped, in DB)            (wrapped, in DB)             (AES-256-GCM,
                                                                                unique 96-bit IV)
```

Every level carries a `key_version`. Rotating the root = re-wrap N org keys (cheap, no secret touched).
Rotating an env key = re-encrypt that env only. Deleting an env key = cryptographic erasure of that env.

**The only real question is: where does the Root KEK live, and how does the Worker get it?**

Answer: **Phase.dev owns it. Cloudflare serves it. The Worker never calls Phase.**

```
┌──────────────────────────────────────────────────────────────────────┐
│  Phase.dev          SOURCE OF TRUTH                                  │
│  - humans read it here, never from a file                            │
│  - `phase run -- npm run dev`      → local dev process env           │
│  - `phase run -- wrangler deploy`  → CI/deploy process env           │
│  - Phase's Cloudflare Workers sync integration is the alternative    │
└────────────────────────────┬─────────────────────────────────────────┘
                             │  DEPLOY TIME — once per release
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Cloudflare Secrets Store    RUNTIME COPY                            │
│  - bound to the Worker as env.XECRET_ROOT_KEK                        │
│  - read once per isolate, imported as a non-extractable CryptoKey    │
└────────────────────────────┬─────────────────────────────────────────┘
                             │  RUNTIME — 0 ms, 0 subrequests
                             ▼
                    Worker unwraps Org key → Env key → secret
```

**Why the Worker must not fetch from Phase at runtime** — four independent reasons, any one of which is disqualifying:

1. Workers have no `.env` and no disk at runtime. Env values are baked in at deploy. There is nothing to fetch *into*.
2. Phase outage = **total** xecret outage. Not degraded — no secret is decryptable for any customer.
3. It's circular: calling Phase requires a Phase service token, which is itself a secret that must live in the Worker. The problem is moved, not solved, and a network hop is added.
4. It burns the 6-simultaneous-connection budget and adds cold-start latency to the exact path (`xecret run`) we are optimising.

**The bootstrap problem, stated plainly:** xecret can never store xecret's own root key — you would need the key to read the key. Every secret manager has this (Doppler uses AWS KMS). Phase.dev is therefore a **permanent** architectural dependency, not a temporary crutch. That is a deliberate, documented choice.

**Escrow — non-negotiable, and the biggest hole in plan1:**

Phase.dev is the *working* copy, never the *only* copy. If the Phase account is lost, locked, or deleted, every customer's secrets become permanently unrecoverable.

1. `docs/security/key-recovery.md` written **before** any crypto code ships. Hard gate on Phase 2.
2. Root KEK generated by `scripts/keygen.ts`, then split into **2-of-3 Shamir shares** stored offline in physically separate places (USB, printed sheet, safe). Never all in one location, never all digital.
3. Documented restore drill, run quarterly, from escrow shares alone with Phase assumed dead.
4. `key_version` column on every wrapped key and every ciphertext from migration #1.

**Provider interface** — so this is a config change later, not a rewrite:

```ts
interface KeyProvider {
  getRootKey(version: number): Promise<CryptoKey>   // non-extractable
  currentVersion(): number
}
// v1: CloudflareSecretsStoreProvider   ← ships now, key sourced from Phase.dev
// v2: KmsWrappedProvider               ← split trust (CF alone can't decrypt, AWS alone can't)
// v3: OrgScopedKmsProvider             ← BYOK, enterprise sales lever
```

Considered and rejected for v1: per-request KMS unwrap (adds a round-trip to every secret read, and an attacker with Worker code execution simply asks KMS themselves — near-zero security gain for real latency cost).

---

### D11 — Firebase Auth: use it as an identity provider only

You want Firebase and don't want to run auth yourself. Fine — but **do not use Firebase for sessions.** Here's why and what to do instead.

```
Browser ──Firebase JS SDK (Google / email+password)──▶ Firebase
Browser ──POST /api/auth/session { idToken }──────────▶ Worker
Worker  ──verify RS256 vs Google JWKS (Web Crypto, JWKS cached in KV)
        ──check aud == projectId, iss, exp, email_verified
        ──upsert user, create OUR session row in Postgres
        ──Set-Cookie: HttpOnly; Secure; SameSite=Lax; opaque 256-bit token (store SHA-256 hash only)
Browser ──all further requests use OUR session, never a Firebase token
```

Verification uses **`firebase-auth-cloudflare-workers`** — zero dependencies, Web Standard APIs only, purpose-built for Workers, caches Google's JWKS in KV. The browser still uses the normal Firebase JS SDK to render the login UI; the Worker only verifies. **`firebase-admin` is banned by an ESLint `no-restricted-imports` rule** so it can never creep in.

Why this shape:
- No Admin SDK anywhere → no Workers incompatibility.
- **Real revocation.** Firebase ID tokens live ~1 hour with no kill switch. Ours die instantly.
- One session model shared by dashboard, CLI, and CI.
- Firebase stays swappable behind an `IdentityProvider` interface.

**Honest trade-off you're accepting:** self-hosters will need their own Firebase project. That's real friction for an open-source product. The `IdentityProvider` interface means someone can contribute a Postgres-native provider later without touching authz, crypto, or the API. This will be stated plainly in `docs/self-hosting.md` — not hidden.

---

### D12 — Database access

**Drizzle ORM + Hyperdrive + `postgres.js`.** Drizzle for type-safe schema + migrations without ORM magic; Hyperdrive because it's the fastest and Cloudflare-recommended path for Neon.

Behind a 30-line adapter so self-hosters without Hyperdrive can swap in `@neondatabase/serverless` (HTTP) with one env var.

---

### D13 — Licensing: split AGPL / MIT + CLA

| Component | Licence | Reason |
|---|---|---|
| `apps/web`, `packages/*` | **AGPL-3.0** | Fork it, modify it, run it as a service → you must publish your changes. Still OSI-approved, so xecret is honestly "open source" — which matters enormously for a product people are asked to trust with secrets. |
| `cli/`, future client SDKs | **MIT** | The CLI ships inside customers' Docker images and CI pipelines. AGPL there triggers corporate legal bans and would kill adoption. Standard industry split. |
| Contributions | **CLA required** | Every outside contributor assigns rights. Without this, once there are external contributors the licence can *never* be changed. With it, moving to BSL/FSL or selling commercial exceptions stays possible. |

**Honest limit:** AGPL does **not** stop someone running an *unmodified* copy as a competing SaaS — only BSL 1.1 / FSL do, at the cost of losing the "open source" label (see HashiCorp → OpenTofu). If blocking competing SaaS outright becomes the priority, the CLA is what makes that switch legally possible later.

---

## 2. Repository structure

Current state: a Create Next App at repo root, one commit, `.idea/` untracked.

**Proposed target:**

```
xecret/
├── apps/
│   └── web/                        # ← current root app moves here
│       ├── src/
│       │   ├── app/
│       │   │   ├── (marketing)/    # landing, pricing, docs shell
│       │   │   ├── (auth)/         # login, signup, reset
│       │   │   ├── (dashboard)/    # projects, envs, secrets, team, audit
│       │   │   ├── cli/authorize/  # CLI consent screen
│       │   │   └── api/
│       │   ├── components/         # shadcn/ui + app components
│       │   ├── server/             # route logic — never imported by client
│       │   └── lib/
│       ├── wrangler.jsonc
│       ├── open-next.config.ts
│       └── package.json
│
├── cli/                            # Go module: github.com/playxoft/xecret/cli
│   ├── go.mod
│   ├── main.go
│   ├── internal/
│   │   ├── api/                    # HTTP client, retries, error mapping
│   │   ├── auth/                   # PKCE loopback flow, token refresh
│   │   ├── keyring/                # macOS Keychain / Windows CredMan / Secret Service
│   │   ├── cache/                  # encrypted offline cache
│   │   ├── config/                 # .xecret.yaml discovery + resolution
│   │   ├── importer/               # .env / json / yaml parsers (shared w/ export)
│   │   ├── run/                    # process spawn, env injection, signal forwarding
│   │   └── output/                 # tty vs --json, never prints secret values
│   ├── testdata/
│   └── .goreleaser.yaml
│
├── packages/
│   ├── core/                       # pure TS, zero Cloudflare imports, 100% unit-testable
│   │   ├── crypto/                 # envelope encryption, key providers, KAT vectors
│   │   ├── authz/                  # permission evaluation — THE single source of truth
│   │   ├── audit/                  # event builders + redaction
│   │   └── validation/             # Zod schemas shared by API + UI + CLI contract
│   └── db/
│       ├── schema/                 # Drizzle table definitions
│       ├── migrations/
│       └── seed/
│
├── examples/
│   ├── nextjs/  react-vite/  nodejs/  go/
│   └── ci/                         # github-actions, gitlab, circleci, docker
│
├── docs/
│   ├── adr/                        # 0001-doppler-vs-e2e.md, 0002-master-key.md, ...
│   ├── architecture/  security/  cli/  self-hosting/  development/
│
├── scripts/                        # keygen, rotate-root-key, bundle-size-check
├── _developer/                     # your planning space (gitignored? your call)
│
├── .github/workflows/
├── package.json                    # npm workspaces
├── LICENSE  README.md  SECURITY.md  CONTRIBUTING.md  CODE_OF_CONDUCT.md  CHANGELOG.md
└── .env.example
```

**Why monorepo:** the CLI and API share a wire contract that will change often in the first months. Atomic commits across both is worth far more than clean separation right now. Go modules in subdirectories work fine; GoReleaser handles it natively.

**Why `packages/core` has zero Cloudflare imports:** crypto and authz are the two things that must be trivially unit-testable and reviewable by an outside security auditor. If they import `env` bindings, they can't be.

### Git setup (Phase 1)

- `.gitignore` += `.idea/`, `.wrangler/`, `.dev.vars`, `.env*`, `*.enc`, `cli/dist/`
- `git config user.email nitheesh@playxoft.com` (repo-local — the machine's global is a personal address)
- Commit messages carry **no AI attribution or co-author trailers**
- Branch protection on `main`; work on `feat/*` branches
- Conventional Commits (drives CHANGELOG + release automation)
- Signed commits recommended for a security product
- `.github/workflows/`: `ci.yml` (lint/typecheck/test/bundle-size), `cli.yml` (go test, matrix build), `release.yml` (GoReleaser)
- **Secret-scanning + gitleaks in pre-commit.** Non-negotiable for this product — the embarrassment of leaking a key in a secrets manager's own repo is existential.

---

## 3. Phased plan

Four milestones, eleven phases. Each phase ends with the report format in §5 and does not start until the previous one is green.

Estimates assume focused work; treat as relative sizing, not commitments.

---

### 🏁 M0 — Foundations

#### ✅ Phase 0 — Decisions & threat model

- [x] ADRs 0001–0007: trust model, root key custody, Firebase-as-IdP, Go CLI, monorepo, database access, licensing
- [x] `docs/security/threat-model.md` — 10 attacker classes × (threat, impact, likelihood, mitigation, residual risk)
- [x] `docs/security/key-recovery.md` — **gate: no crypto code before this exists**
- [x] Full DB schema on paper, reviewed end-to-end before a single migration
- [x] `docs/architecture/system-architecture.md`

#### ✅ Phase 1 — Repo foundation

- [x] Monorepo restructure, history preserved via `git mv`
- [x] npm workspaces, TypeScript strict, ESLint, Prettier, Vitest
- [x] OpenNext + wrangler configured; Worker bundle builds (0.93 MB gzipped / 6 MB budget)
- [x] Drizzle configured; `db:generate` / `db:migrate`; 15 tables, 3 migrations
- [x] CI: lint, typecheck, test, prod-dependency audit, gitleaks, bundle-size gate
- [x] `LICENSE` (AGPL-3.0), `cli/LICENSE` (MIT), `SECURITY.md`, `.env.example`
- [x] Go CLI skeleton — builds, vets, tests, cross-compiles
- [ ] Neon project + Hyperdrive binding created *(needs your Cloudflare/Neon account)*
- [ ] Phase.dev project + values populated *(you're doing this)*
- [ ] CLA bot configured *(before the repo goes public)*
- [ ] Deploy a live Worker *(needs Cloudflare auth)*

#### ✅ Phase 2 — Crypto core

Built **before** the API, because it is the highest-risk component and the hardest to change later.

- [x] `packages/core/ids` — UUIDv7 generator, monotonic within a millisecond (RFC 9562)
- [x] `KeyProvider` interface + Secrets Store / env / in-memory sources
- [x] AES-256-GCM envelope encryption, unique 96-bit IV per operation
- [x] AAD binding ciphertext to `(org_id, env_id, secret_id, version)` — blocks ciphertext relocation
- [x] Key generation, wrapping, unwrapping, versioning (root → org → env)
- [x] `value_hmac` via HKDF-derived key — change detection without decryption
- [x] Root-key rotation (re-wrap) + env-key rotation (re-encrypt)
- [x] Cryptographic erasure path for deletes
- [x] `scripts/keygen.ts` (generate + Shamir 2-of-3 split + recover + drill), `scripts/rotate-root-key.ts`
- [x] Tests: known-answer vectors, tamper detection, wrong-AAD rejection, IV uniqueness, rotation round-trip, key-version downgrade rejection

**Exit:** ≥95% coverage on `crypto/`. — **achieved: 99.4% statements, 98.4% branches, 221 tests.**

---

### 🏁 M1 — A solo developer's loop works end to end

#### ✅ Phase 3 — Auth & organisations

- [x] `IdentityProvider` interface so Firebase is swappable
- [x] Worker-side ID token verification via `firebase-auth-cloudflare-workers`, JWKS cached in KV (in-memory fallback when the binding is absent)
- [x] Firebase client SDK wiring: Google + email/password, verification, password reset
- [x] Session policy + token/cookie primitives (`packages/core/auth`)
- [x] Session lifecycle wired to the database: create, resolve, touch, revoke, revoke-all
- [x] Auto-create personal organisation on first login (owner role, org + env keys, default project, all in one transaction)
- [x] CSRF double-submit primitives, enforced on cookie-authenticated mutations only
- [x] Rate limit buckets wired: `RL_LOGIN` keyed on IP **and** on identity
- [x] Request spine: `bindings` → `context` → `actor` → `tenancy` → `route`, with a single error boundary
- [x] Tests: token verification failure modes, session expiry/revocation, CSRF rejection, cookie-shadowing, body-size limits

**Exit:** a credential can be established, resolved, and revoked, and nothing below the route layer can be reached without passing through `authenticate()`.

#### ✅ Phase 4 — Projects, environments, secrets API

- [x] **The authz engine** — one `can(actor, action, resource)`. Every route calls it via `authorize()`. Two gates that cannot bypass each other: role capability **and** resolved access level
- [x] Grant resolution: env-specific → project-wide → role default; explicit `none` always denies, even an owner
- [x] Org → Project → Environment CRUD; slugs are immutable because they appear in `.xecret.yaml` and CI config
- [x] Secrets + `secret_versions` (append-only): create, update, delete, restore
- [x] Bulk read path for `xecret run` — **2 queries** plus a batched audit insert, constant in the number of secrets, 0 outgoing fetches
- [x] **Import engine** (`packages/core/importer`): `.env` (quoting, multiline PEM, `export` prefix, CRLF, BOM, trailing comments), JSON (flat + nested → `A_B`), YAML, shell exports
- [x] Import conflict resolution: skip / overwrite / rename, with a dry run that calls the identical planning function as the real import
- [x] Export formats: `env`, `json`, `yaml`, `shell`, `docker` — round-trip property-tested against the parsers
- [x] IDOR defence: every resolver joins through verified membership; cross-tenant returns 404, never 403
- [x] Audit events for every mutation, every decryption, and every denial
- [x] Tests: the security matrix — cross-org, cross-project, cross-env, service-token pinning, suspended member, production deny-by-default, role escalation, and all four ciphertext-relocation attacks

**Two real bugs caught here, both silent and both fatal:**
- `createSecret` minted the secret id *after* the value was encrypted, while AAD binds `secret_id`. Every secret created through it would have been permanently undecryptable, with no error anywhere.
- `addSecretVersion` computed `MAX(version)+1` inside the INSERT while the AAD was bound to the version the request expected. A concurrent writer committing first produced a row whose ciphertext was bound to a version it was never assigned — again undecryptable, again silent.

**One restriction shipped deliberately:** service tokens are read-only, because `secret_versions.created_by` is `NOT NULL REFERENCES users`. Lifting it is a Phase 8 migration — see `docs/architecture/api.md` §2.

#### ✅ Phase 5 — Dashboard UI

- [x] Own design system on Radix + Tailwind v4; light / dark / system, dark primary, no flash of wrong theme
- [x] Palette documented with **measured** WCAG ratios in both themes — body text AAA, every interactive state AA, non-text UI ≥3:1
- [x] App shell: collapsible sidebar, org switcher, user menu, breadcrumbs
- [x] Projects list → project overview → environment cards → secret table
- [x] Masked by default; reveal is per-secret, goes through the audited endpoint every time, auto-remasks on timeout **and** on tab-hide
- [x] Copy-to-clipboard never renders the value — and is audited, because a copy is a decryption
- [x] Add / edit / delete with inline validation mirroring the server's rules
- [x] **Import modal** — drag a `.env`, live dry-run preview, conflict resolution, per-row status. No value column, and the server never sends values back
- [x] Export dialog that states plainly that writing secrets to disk is a downgrade
- [x] Production styling that survives greyscale: a reserved accent **plus** hazard hatching and letterform, never colour alone
- [x] Destructive actions confirmed; production requires typing the resource name
- [x] Search, filter, empty states, skeletons, error states surfacing the `requestId`
- [x] Auth pages: sign in, sign up, forgot password, reset — with the four "wrong credential" Firebase codes collapsed into one message, so the form is not a user-enumeration oracle

**Caught while measuring:** the root layout's barrel imports were pulling `UserMenu → lib/firebase → firebase/auth`, shipping **310 KB of the Firebase SDK to the public landing page**. Fixed structurally — sign-out no longer needs the Firebase SDK at all, since it is one `DELETE /api/auth/session`.

**Removed:** `src/proxy.ts`. Next 16 defaults Proxy to the Node.js runtime and throws if `runtime` is set; `@opennextjs/cloudflare` refuses to build Node middleware. It could never have deployed. The signed-out redirect lives in the API client's 401 handling, which is where Next's own docs say authorization belongs anyway.

**Exit:** the whole solo flow is reachable in a browser. Not yet exercised end to end — that needs the Neon database and the Phase.dev values.

#### ✅ Phase 6 — Go CLI v1
The phase that decides whether people love this product.

```bash
xecret login / logout / whoami
xecret init                       # writes .xecret.yaml
xecret projects / environments
xecret secrets list|get|set|delete
xecret import .env
xecret pull --format env|json|yaml
xecret run -- npm run dev
xecret cache clear
```

- **Auth:** OAuth-style loopback + PKCE against *your* server (never Firebase directly). `xecret login` → PKCE challenge → loopback listener on `127.0.0.1:<random>` → browser consent screen showing the device name → code → exchange for a refresh token in the **OS keychain** (Keychain / Credential Manager / Secret Service), falling back to a `0600` file with a visible warning. Never printed, never in argv, never in shell history.
- **`run`:** fetch → decrypt server-side → inject into child env → exec → forward signals → propagate exit code. Secrets never touch disk, argv, or stdout.
- **Encrypted local cache:** AES-256-GCM, key in the OS keychain, `0600` file in `~/.xecret/cache/`, per project+env. Used automatically when the API is unreachable, with a loud stderr warning showing cache age. `--offline` forces it, `--no-cache` disables it, logout wipes it. **This is what stops a xecret outage from stopping every customer's `npm run dev`.**
- `.xecret.yaml`: `project` + `environment` only. Never secrets. Safe to commit.
- Error messages that say what to do next, not what went wrong internally
- `--json` for scripting; respects `NO_COLOR`, detects non-TTY
- GoReleaser: darwin/linux/windows × amd64/arm64, Homebrew tap, `curl | sh` installer, checksums + cosign signatures

**Exit:** `xecret run -- npm run dev` works on macOS, Linux, and Windows, online and offline.

**Shipped, with four decisions worth recording:**

- **The server half now exists too.** `POST /api/cli/authorize` (consent, session+CSRF,
  PIN-gated), `POST /api/cli/token` (PKCE exchange — the code is consumed atomically
  *before* the verifier check, so a failed binding kills it), `DELETE /api/cli/token`
  (logout self-revocation), a `cli_auth_codes` table (migration 0005), and a consent
  screen at `/cli/authorize`. All in `docs/architecture/api.md` §4.
- **Consent requires membership, not `token.create`.** That capability gates *service*
  tokens, which grant standing access and outlive their creator. A CLI token acts as its
  user and adds no authority — requiring an admin to approve every developer's laptop
  would kill the golden path while protecting nothing `can()` does not already enforce.
- **`secrets get` is masked by default; `--plain` reveals.** An audited `secret.revealed`
  row therefore always means a plaintext actually left the server.
- **The offline cache never answers a 4xx.** Network failure and 5xx fall back, loudly,
  with the cache age; a revoked or denied credential does not — a cache that outlives
  revocation would be a revocation bypass. Cache files are AES-256-GCM with the key in
  the OS keychain and the AAD bound to (host, org, project, env) — the client-side twin
  of the server's anti-relocation design.

**Still open before binaries are *distributed* (not before merging):** the permanent
domain (§7) — it is compiled into every copy — plus the `playxoft/homebrew-tap` repo and
a cosign key for the release workflow. `xecret login` has not yet run against a deployed
Worker; that joins the same integration pass as everything else in the standing caveat
at the top of this document.

**🎉 M1 milestone: the golden path works. This is the moment to show it to real developers.**

---

### 🏁 M2 — Teams and CI

#### ✅ Phase 7 — Team, roles, granular access
- [x] Four fixed roles: Owner, Admin, Developer, Viewer. **No custom roles in v1** — the schema supports them, the UI does not.
- [x] Per-member grants: project → environment → `none | read | write | admin` (the engine's fourth level, kept rather than papered over)
- [x] Invitations: single-use, expiring, hashed-at-rest tokens, revocable
- [x] Member management UI, seat counting (no billing — just the data model)
- [x] Effective-permission preview: "what can Alice actually see?" — computed by the same `resolveAccessLevel` the enforcement path calls

**Shipped, with the decisions worth recording:**

- **The role hierarchy is a second predicate, not a capability.** `canAssignRole`
  (core/authz) refuses any role above the actor's own, applied to *both* sides of
  every member change — the role being handed out and the role currently held.
  Without it, `member.invite` plus one forged request lets an admin mint an owner.
- **Invitations supersede on re-invite.** A new invitation revokes the address's
  outstanding one inside the same transaction, so "resend" is just "invite" and at
  most one live link per (org, email) can circulate — which is also what makes
  re-inviting after expiry survive the partial unique index.
- **Acceptance is one transaction under the organisation lock:** state, address
  match (a forwarded email must not let a colleague join as somebody else), seat
  count, and the membership insert all settle together. Seats count members
  whatever their status — suspension is a security act, never a discount — plus
  open unexpired invitations.
- **The invite link is returned once, like a token.** Mail stays optional for
  self-hosters; the inviter can hand the link over themselves, and closing the
  dialog discards it.
- **Member mutations are session-only** (a bearer credential may not mint further
  credentials — the CLI-authorize rule, generalised), and self-changes are refused
  outright: demoting yourself has no self-service undo.
- Audit grew `member.suspended`, `member.reinstated`, `invitation.revoked`, and
  previous/new access-level metadata — and a real bug fell out: `sanitizeMetadata`
  silently dropped `deviceName`, `sessionCount` and `valueType` because the
  field-by-field rebuild never learned them. Fixed with a test that sweeps every
  declared field.

#### ✅ Phase 8 — CI, service tokens, audit logs
CI is a **first-class use case**, not a v2 afterthought.

- [x] **Service tokens:** scoped to exactly one project + environment, read-only by default, no user attached, shown once at creation, revocable, optional expiry, optional IP allowlist, `last_used_at` tracked
- [x] **Migration 0006: service-token write attribution** — exactly as specified, applied to `secrets` *and* `secret_versions` (both carried `NOT NULL created_by`; `secret.create` is in the allowlist, so both needed the pair + CHECK). The 403 in `secrets-service.ts` became `secretWriter`, returning `{userId}` or `{serviceTokenId}`.
- [x] `XECRET_TOKEN=xst_... xecret run -- npm run build` — zero interactive login *(the plan's `xct_` here was a typo: `xst_` is the service prefix, as api.md and the CLI README already said)*
- [x] `xecret pull --format env > .env` for legacy pipelines, with a stderr warning
- [x] Distribution: GitHub Action (`action.yml`, composite, checksum-verified), Docker image `ghcr.io/playxoft/xecret` (distroless static, multi-arch), `curl | sh` wired at `/install.sh`, `release.yml` with keyless cosign — all actions SHA-pinned
- [x] Recipes in `examples/ci/` for GitHub Actions, GitLab, CircleCI, Docker (BuildKit secret mounts, and what never to do)
- [x] Token table already shaped for GitHub OIDC federation in v2 — schema now, feature later
- [x] **Audit logs:** the Phase 1 partitioned table + Phase 4 writes, now readable — keyset-paginated query API over `(created_at, id)` with the clamped 90-day window stated in every response
- [x] Audit UI: filter by action, outcome, project; load-more pagination *(actor and date filters are in the API; the UI exposes the three that answer real questions first)*
- [x] Redaction enforced in the audit event builder itself — unchanged from Phase 4, now also covering the new fields

**Shipped, with the decisions worth recording:**

- **`GET /api/tokens/self`** is the piece the spec did not name: a service token
  is pinned to ids but every API path speaks slugs, so the CLI introspects the
  credential once and learns exactly its own scope — which is why CI needs zero
  configuration beyond the token. The answer derives from the token row alone;
  there is no parameter to lie in.
- **XECRET_TOKEN never touches the offline cache.** A runner is ephemeral, a
  shared runner is worse, and a cache that outlived a token's revocation would be
  a revocation bypass. `--offline` under a service token is an error, not a
  fallback.
- **`secret.delete` and `secret.rotate` stay outside the allowlist.** CI rotates
  a value by writing a new one; destroying history remains a human's decision.
- **Revocation authority differs by kind on purpose:** your own CLI token always
  (signing out a laptop must not need an admin), anything else `token.revoke`.
  The service-token *listing* shares the mint gate — a map of standing
  credentials is reconnaissance.
- The dashboard's Actor display now says "CI token" for token-attributed writes;
  the token's display prefix in audit metadata is redacted by the credential
  detector, accepted as correct — the row's resource id already names the token.

---

### 🏁 M3 — Launch ready

#### ✅ Phase 9 — Landing page, docs, open source
- [x] Landing: hero, the 60-second story, CLI demo, security explainer in plain language, open-source pitch, CTA
- [x] Original visual identity — the Phase 5 design system, extended rather than replaced
- [x] Colour system documented (`docs/design/colour-system.md`) — the measured WCAG ratios were already annotated in `globals.css`; the doc explains the system and makes the annotation the review artifact
- [x] `docs/`: index, quickstart, CLI reference, self-hosting; security architecture / threat model / encryption / authz already existed from Phases 0–4 and are now linked from one index
- [x] Framework guides: Next.js, React/Vite, Node, Go (+ pointer READMEs in `examples/`)
- [x] Full OSS scaffolding: issue forms (security routed to private advisories before anything else), PR template restating the standing rules as its checklist, `SECURITY.md` gained GitHub private vulnerability reporting beside the existing mail route and SLA

**Shipped, with one honest substitution:** the plan asked for "real asciinema,
not a fake screenshot" — and there is no deployed server to record against yet.
The landing demo is a typed re-enactment built from the CLI's actual format
strings (login → init → run), labelled as such on the page, with the child
process's lines visually attributed to the child. Reduced-motion and no-JS
visitors get the complete transcript immediately. A true recording replaces it
the day the integration pass produces a deployment to point a terminal at.

#### Phase 10 — Security audit, performance, production  *(~5 days)*
- **Adversarial security pass** — I attack the app as an external tester: IDOR/BOLA, authz bypass, privilege escalation, token replay, session fixation, invitation reuse, cross-env leakage, rate-limit bypass, SSRF, XSS, CSRF, injection, timing attacks on token comparison, CLI credential theft
- Verify the log pipeline for secret leakage end to end (app logs, error responses, Sentry-equivalent, CF analytics)
- Performance: bundle size, CPU per request, DB query count (kill all N+1s), p50/p99 secret retrieval, CLI startup time, cold-start impact
- Production: migrations runbook, Firebase prod config, key ceremony + escrow, monitoring, error reporting, backup + **tested** restore, incident response doc
- Third-party review recommendation before accepting real customer secrets

---

## 4. Deliberately NOT in v1

Billing · custom roles · SSO/SAML · automatic third-party rotation · secret referencing across envs · webhooks · Kubernetes operator · approval workflows · integrations marketplace · AI features · mobile app · E2E encryption mode

Each is a schema-compatible addition, not a rewrite. That's the point of the phasing.

---

## 5. Per-phase report format

```
Phase / Status
Implemented          — what actually works now
Architecture decisions — what I chose and why (ADR link if significant)
Files changed
Security considerations — what this phase exposes and how it's mitigated
Tests                — what's covered, what isn't
Known limitations    — stated plainly, not buried
Next phase           — and what I need from you
```

---

## 6. Standing rules

1. Security > correctness > simplicity > DX > performance > maintainability, in that order, when they conflict.
2. Never invent cryptography. Web Crypto primitives only.
3. No plaintext secrets in the database. Ever.
4. No secret values in logs, errors, URLs, analytics, traces, audit records, or client state.
5. One authorization function. Every protected route calls it.
6. Never trust `projectId`, `orgId`, `userId`, or `role` from the client.
7. Every security-sensitive action produces an audit event.
8. No dependency that can't run on Workers. Prefer Web APIs.
9. Major architecture changes need an ADR and your approval.
10. When uncertain, research and present options — don't guess.

---

## 7. Status of open questions

| State | Question | Status |
|---|---|---|
| ✅ | Master key custody | Phase.dev → Cloudflare Secrets Store (D10) |
| ✅ | Repo restructure to `apps/web` + `cli` + `packages` | Approved |
| ✅ | Go module path | `github.com/playxoft/xecret` |
| ✅ | Database access | Hyperdrive (D12) |
| ✅ | Firebase edge library | `firebase-auth-cloudflare-workers` (D6/D11) |
| ✅ | Licence | AGPL-3.0 server + MIT CLI + CLA (D13) — confirmed |
| 🔶 | **Domain name** | `xecret.playxoft.com` for now. A permanent name is still needed before the CLI ships. See below. |

### The domain question

`xecret.playxoft.com` is wired in as the interim origin, which unblocks everything through Phase 5. It is **not** yet safe to ship a CLI binary, because the domain is compiled into every distributed copy.

A permanent domain is needed in four places:

1. **Firebase authorised domains** — Google sign-in only works on pre-registered domains.
2. **Google OAuth redirect URI** — must match exactly, character for character.
3. **CLI login target** — `xecret login` opens `https://<domain>/cli/authorize`; this becomes the compiled-in default in every distributed binary. Changing it later means every installed CLI breaks.
4. **Cloudflare Worker route.**

Lock the real name before Phase 6 (the CLI), and register the **GitHub org and npm `@xecret` scope on the same day** — the name is the product, and squatters are fast.

To check: `xecret.dev` / `xecret.com` / `xecret.io`, `github.com/xecret`, npm `@xecret`.

---

Once the licence is confirmed, **Phase 0 begins**. The domain is only required by Phase 3.
