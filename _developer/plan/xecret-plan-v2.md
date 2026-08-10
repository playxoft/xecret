# xecret — Implementation Plan v2

> Open-source, developer-first secret management.
> Powered by Playxoft.

**Status:** in progress — M0 complete, M1 underway.
**Supersedes:** `plan1.md` (kept for reference — this doc is the source of truth).

**Progress:** ▓▓▓░░░░░░░░ 2 of 11 phases merged, Phase 3 in progress

| Phase | Status | Branch | Merge commit |
|---|---|---|---|
| 0 · Decisions & threat model | ✅ merged | — | `3d75a1e` |
| 1 · Repo foundation | ✅ merged | — | `3d75a1e` |
| 2 · Crypto core | ✅ merged | `feat/crypto-core` | |
| 3 · Auth & organisations | 🔨 core done, wiring pending | `feat/auth-organizations` | |
| 4 · Projects, environments, secrets API | ⬜ | `feat/secrets-api` | |
| 5 · Dashboard UI | ⬜ | `feat/dashboard-ui` | |
| 6 · Go CLI v1 | ⬜ | | |
| 7 · Team, roles, granular access | ⬜ | | |
| 8 · CI, service tokens, audit logs | ⬜ | | |
| 9 · Landing page, docs, open source | ⬜ | | |
| 10 · Security audit, performance, production | ⬜ | | |

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

#### ⬜ Phase 3 — Auth & organisations

- [x] `IdentityProvider` interface so Firebase is swappable
- [ ] Worker-side ID token verification via `firebase-auth-cloudflare-workers`, JWKS cached in KV
- [ ] Firebase client SDK wiring: Google + email/password, verification, password reset
- [x] Session policy + token/cookie primitives (`packages/core/auth`, 261 tests)
- [ ] Session lifecycle wired to the database: create, resolve, touch, revoke
- [ ] Auto-create personal organisation on first login (owner role, default keys)
- [x] CSRF double-submit primitives
- [ ] Rate limit buckets: login, session create, password reset — all strict
- [ ] Tests: token verification failure modes, session expiry/revocation, CSRF rejection

#### ⬜ Phase 4 — Projects, environments, secrets API

- [ ] **The authz engine** — one `can(actor, action, resource)`. Every route calls it. Zero exceptions.
- [ ] Grant resolution: env-specific → project-wide → role default; explicit `none` always denies
- [ ] Org → Project → Environment CRUD with machine-friendly slugs
- [ ] Secrets + `secret_versions` (append-only): create, update, delete, rotate, restore
- [ ] Bulk read path for `xecret run` — ≤3 queries, 0 outgoing fetches
- [ ] **Import engine** (`packages/core/importer`): `.env` (quoting, multiline, `export` prefix), JSON (flat + nested → `A_B`), YAML, shell exports
- [ ] Import conflict resolution: skip / overwrite / rename, with a dry-run preview
- [ ] Export formats: `env`, `json`, `yaml`, `shell`
- [ ] IDOR defence: every query joins through verified membership; cross-tenant returns 404 not 403
- [ ] Audit events emitted for every mutation and every decryption
- [ ] Tests: the security matrix — cross-org, cross-project, cross-env, revoked member, expired session, role escalation

#### ⬜ Phase 5 — Dashboard UI

- [ ] shadcn/ui + Tailwind v4; light / dark / system theme
- [ ] App shell: sidebar, org switcher, user menu
- [ ] Projects list → project overview → environment tabs → secret table
- [ ] Masked by default; reveal is per-secret, audited, auto-remasks
- [ ] Add / edit / delete / rotate with inline validation
- [ ] **Import modal** — drag a `.env`, live preview, conflict resolution, "42 secrets will be added"
- [ ] Environment switcher with unmistakable production styling
- [ ] Confirmation for destructive actions, stronger for production
- [ ] Search, filter, empty states, loading skeletons, error states
- [ ] Auth pages: sign in, sign up, forgot password, reset

**Exit:** the whole solo flow works in a browser without touching a terminal.

#### Phase 6 — Go CLI v1  *(~8 days)*
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

**🎉 M1 milestone: the golden path works. This is the moment to show it to real developers.**

---

### 🏁 M2 — Teams and CI

#### Phase 7 — Team, roles, granular access  *(~5 days)*
- Four fixed roles: Owner, Admin, Developer, Viewer. **No custom roles in v1** — the schema supports them, the UI does not.
- Per-member grants: project → environment → `none | read | write`
- Invitations: single-use, expiring, hashed-at-rest tokens, revocable
- Member management UI, seat counting (no billing — just the data model)
- Effective-permission preview: "what can Alice actually see?" — the feature that prevents misconfiguration

#### Phase 8 — CI, service tokens, audit logs  *(~5 days)*
CI is a **first-class use case**, not a v2 afterthought.

- **Service tokens:** scoped to exactly one project + environment, read-only by default, no user attached, shown once at creation, revocable, optional expiry, optional IP allowlist, `last_used_at` tracked
- `XECRET_TOKEN=xct_... xecret run -- npm run build` — zero interactive login
- `xecret pull --format env > .env` for legacy pipelines, with a stderr warning
- Distribution: GitHub Action, Docker image `ghcr.io/playxoft/xecret`, `curl | sh` for arbitrary CI
- Recipes in `examples/ci/` for GitHub Actions, GitLab, CircleCI, Docker build args
- Token table designed for GitHub OIDC federation in v2 (no static token at all) — schema now, feature later
- **Audit logs:** append-only table, partitioned by month, structured JSON metadata, actor/action/resource/project/env/IP/UA. Every service-token read is logged.
- Audit UI: search + filter by actor, action, project, environment, date, outcome
- Redaction is enforced *in the audit event builder itself*, not by convention

---

### 🏁 M3 — Launch ready

#### Phase 9 — Landing page, docs, open source  *(~5 days)*
- Landing: hero, the 60-second story, CLI demo (real asciinema, not a fake screenshot), security explainer in plain language, open-source pitch, CTA
- Original visual identity — inspired by good developer tools, cloned from none
- Colour system chosen and *documented* (WCAG AA verified in both themes)
- `docs/`: quickstart, CLI reference, self-hosting, security architecture, threat model, encryption, authz, contributing
- Framework guides: Next.js, React/Vite, Node, Go
- Full OSS scaffolding: issue templates, PR template, `SECURITY.md` with a disclosure process and response SLA

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

| | Question | Status |
|---|---|---|
| ✅ | Master key custody | Phase.dev → Cloudflare Secrets Store (D10) |
| ✅ | Repo restructure to `apps/web` + `cli` + `packages` | Approved |
| ✅ | Go module path | `github.com/playxoft/xecret` |
| ✅ | Database access | Hyperdrive (D12) |
| ✅ | Firebase edge library | `firebase-auth-cloudflare-workers` (D6/D11) |
| ⬜ | **Domain name** | **Blocker.** See below. |
| ⬜ | Licence: AGPL vs FSL | Recommendation is AGPL-3.0 + MIT CLI + CLA (D13). Confirm. |

### The domain blocker

A real domain is needed before Phase 3, because it is hardcoded in four places:

1. **Firebase authorised domains** — Google sign-in only works on pre-registered domains.
2. **Google OAuth redirect URI** — must match exactly, character for character.
3. **CLI login target** — `xecret login` opens `https://<domain>/cli/authorize`; this becomes the compiled-in default in every distributed binary. Changing it later means every installed CLI breaks.
4. **Cloudflare Worker route.**

Development can proceed on the free `*.workers.dev` subdomain through Phases 0–2. Lock the real name before Phase 3, and register the **GitHub org and npm `@xecret` scope on the same day** — the name is the product, and squatters are fast.

To check: `xecret.dev` / `xecret.com` / `xecret.io`, `github.com/xecret`, npm `@xecret`.

---

Once the licence is confirmed, **Phase 0 begins**. The domain is only required by Phase 3.
