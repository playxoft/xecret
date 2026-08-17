# xecret Threat Model

**Version:** 1.0 · **Date:** 2026-08-10 · **Status:** living document

Review this document at the end of every phase and whenever a new trust boundary is
introduced. An unreviewed threat model is worse than none, because it creates false comfort.

---

## 1. What we are protecting

| Asset | Sensitivity | Impact if lost |
|---|---|---|
| Customer secret plaintext | **Critical** | Customer production systems compromised. Existential for xecret. |
| Root KEK | **Critical** | Every customer's secrets decryptable. Also: if *lost* rather than stolen, all data permanently unrecoverable. |
| Org / Env keys (wrapped) | High | Useless without the Root KEK, but narrow the attack. |
| Session & CLI tokens | High | Account takeover at the privilege of the token. |
| Service tokens (CI) | High | Read access to one project+environment. |
| Audit logs | Medium | Loss of forensic ability; tampering hides an intrusion. |
| User PII (email, name) | Medium | Privacy breach, disclosure obligations. |
| Secret *names* and metadata | Low–Medium | `STRIPE_LIVE_KEY` existing in `production` is itself intelligence. |

## 2. Trust boundaries

```
┌─ UNTRUSTED ────────────────────────────────────────────────────────┐
│ Browser · CLI on a developer laptop · CI runner · public internet   │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ TLS + authn + authz  ◀── BOUNDARY 1
┌──────────────────────────────▼─────────────────────────────────────┐
│ TRUSTED: Cloudflare Worker                                          │
│ holds Root KEK in memory · performs all decryption                  │
└───────┬──────────────────────────────────────┬─────────────────────┘
        │ BOUNDARY 2 (Hyperdrive/TLS)          │ BOUNDARY 3 (deploy only)
┌───────▼──────────────┐              ┌────────▼──────────────────────┐
│ SEMI-TRUSTED: Neon   │              │ Phase.dev / CF Secrets Store  │
│ ciphertext only,     │              │ Root KEK at rest              │
│ never a usable key   │              │                               │
└──────────────────────┘              └───────────────────────────────┘
```

**Core invariant:** the database alone is never sufficient to read a secret. Compromising
Neon yields ciphertext and wrapped keys — no plaintext.

---

## 3. Attacker classes

Likelihood is judged over a 12-month horizon for a product of this profile.

### T1 — Unauthenticated internet attacker

| | |
|---|---|
| **Goal** | Reach any secret without credentials |
| **Impact** | Critical · **Likelihood** | High (constant background scanning) |

**Threats:** credential stuffing on login · brute force on invitation and CLI tokens ·
enumerating IDs on API routes · SQL injection · SSRF via user-supplied URLs · exploiting an
unauthenticated route added by accident.

**Mitigations:** authentication is deny-by-default — routes opt *in* to being public, never
out · Cloudflare rate limiting on login, token exchange, and invitation acceptance ·
parameterised queries only (Drizzle) · 256-bit random tokens compared in constant time ·
no user-supplied URL is ever fetched server-side in v1 · security headers and strict CORS ·
a Content Security Policy on every response (`apps/web/src/lib/csp.ts`).

**Residual risk:** Low. A zero-day in Cloudflare or Next.js remains possible.

**Known limit of the CSP.** `script-src` carries `'unsafe-inline'`, so the policy does not
stop an injected inline `<script>` from running — the App Router streams its RSC payload as
a per-page inline script, and the nonce that would replace it requires a Proxy this stack
cannot have (ADR 0008). What the policy does remove is what such a script could accomplish:
`connect-src` and `img-src` refuse exfiltration to any other origin, `script-src 'self'`
refuses a second stage, `form-action` refuses a redirected POST, and `base-uri 'self'`
refuses a rewrite of every relative URL on the page. Treat inline execution as *contained*,
not prevented, and keep escaping at the point of render — see the documentation renderer,
which is where this was learned.

---

### T2 — Authenticated user attacking another tenant

| | |
|---|---|
| **Goal** | Read secrets from an organisation they do not belong to |
| **Impact** | Critical · **Likelihood** | **High** — this is the single most likely real breach |

**Threats:** IDOR/BOLA by substituting `projectId`, `environmentId`, or `secretId` ·
accepting an invitation intended for someone else · a forgotten `WHERE org_id` in one query.

**Mitigations:**
- **One authorization function.** Every protected route calls `can(actor, action, resource)`
  in `packages/core/authz`. No route implements its own check.
- Resource lookups always resolve *through* the verified org membership, never by bare ID.
- Automated test matrix: for every route, a member of org A attempts every operation on
  org B's resources and must receive 404 (not 403 — 403 confirms existence).
- Invitations are bound to the invited email address and are single-use.

**Residual risk:** Medium. This is where bugs will be. Mitigated by making the test matrix a
CI gate, not an aspiration.

---

### T3 — Malicious or over-curious team member

| | |
|---|---|
| **Goal** | Access environments above their granted level (typically production) |
| **Impact** | High · **Likelihood** | Medium |

**Threats:** editing their own role · using a stale CLI token after a downgrade · reading
production through the CLI when the UI hides it · exfiltrating via `xecret pull`.

**Mitigations:** role changes require `member.update`, which no one can exercise on
themselves for elevation · **authorization is evaluated per request, never cached in the
token** — a downgrade takes effect immediately, including for existing CLI tokens · every
secret read is audited with actor, environment, IP, and timestamp · production environments
require an explicit grant and are visually distinct.

**Residual risk:** Medium. A user with legitimate read access can always exfiltrate what they
can read. Audit logs make it *detectable*, not preventable. This is inherent to the product.

---

### T4 — Stolen CLI credential (laptop theft, malware, leaked dotfile)

| | |
|---|---|
| **Goal** | Use a developer's stored token |
| **Impact** | High · **Likelihood** | Medium |

**Threats:** reading the credential from disk · another process on the machine reading it ·
the token appearing in shell history or a screen recording.

**Mitigations:** credentials stored in the **OS keychain** (macOS Keychain, Windows
Credential Manager, Linux Secret Service); the file fallback is `0600` with a visible warning
· tokens never printed, never passed via argv, never placed in a URL · every token is
revocable from the dashboard with device name, last-used time, and last-used IP · tokens
expire and refresh · the offline cache is encrypted with a separate key, also in the keychain.

**Residual risk:** Medium. An attacker with full control of an unlocked developer machine
wins — but that is true of every tool on that machine.

---

### T5 — Compromised CI environment

| | |
|---|---|
| **Goal** | Extract the service token or the secrets it retrieves |
| **Impact** | High · **Likelihood** | Medium (malicious PR, compromised action) |

**Threats:** a pull request modifying the workflow to print secrets · a compromised
third-party GitHub Action · secrets landing in build logs or a cached artifact.

**Mitigations:** service tokens are scoped to exactly **one project + one environment** and
are read-only by default · no user identity is attached, so a stolen CI token cannot touch
anything else · optional IP allowlist and expiry · every use is audited with source IP ·
documentation explicitly warns against granting production tokens to workflows triggered by
forked pull requests.

**Residual risk:** Medium–High, and largely outside our control. Mitigated by blast-radius
limitation. GitHub OIDC federation (no static token at all) is the planned v2 answer; the
token schema is already designed for it.

---

### T6 — Database compromise (Neon breach, stolen credentials, backup leak)

| | |
|---|---|
| **Goal** | Read secrets from the database directly |
| **Impact** | **Low for secrets**, Medium for metadata · **Likelihood** | Low |

**Mitigations:** **this is the attack envelope encryption exists to defeat.** The database
holds only ciphertext and wrapped keys; the Root KEK is never present in any column, backup,
or replica. Session and API tokens are stored as SHA-256 hashes, so a dump yields no usable
credentials. The application database role has no DDL rights.

**Residual risk:** Low for secret values. Metadata — org names, user emails, secret *names*,
audit history — is exposed and is genuinely sensitive intelligence. Accepted and documented.

---

### T7 — Application / Worker compromise (RCE, malicious dependency)

| | |
|---|---|
| **Goal** | Execute code inside the trust boundary |
| **Impact** | **Critical** · **Likelihood** | Low |

This is the worst realistic case: code running in the Worker holds the Root KEK in memory and
can decrypt anything.

**Mitigations:** minimal dependency count, reviewed before addition · `npm audit` and
Dependabot in CI · lockfiles committed; CI installs with `npm ci` · Root KEK imported as a
**non-extractable `CryptoKey`**, so it cannot be trivially serialised out · no `eval`, no
dynamic `import()` of user input · CSP · Cloudflare's V8 isolate provides a strong sandbox ·
all decryption is audited, so mass decryption is visible.

**Residual risk:** **Medium — and the highest residual risk in the system.** Envelope
encryption does not defend against an attacker inside the boundary. Only ADR 0001's rejected
E2E model would, at costs documented there. Detection (audit anomaly alerting) is the
practical answer.

---

### T8 — Supply-chain attack

| | |
|---|---|
| **Goal** | Ship malicious code into the Worker or the CLI binary |
| **Impact** | Critical · **Likelihood** | Low–Medium (rising industry-wide) |

**Mitigations:** few dependencies, each justified · lockfiles committed and CI-enforced ·
Dependabot with review required · release binaries checksummed and **signed with cosign** ·
reproducible Go builds · GitHub Actions pinned to commit SHAs, not tags · protected `main`
with required review.

**Residual risk:** Medium. A compromised upstream package is a real and growing threat.
`packages/core` deliberately has near-zero dependencies for exactly this reason.

---

### T9 — Insider (xecret operator with production access)

| | |
|---|---|
| **Goal** | Read customer secrets |
| **Impact** | Critical · **Likelihood** | Low |

**Honest statement:** under ADR 0001, an operator with production access **can** decrypt
customer secrets. No technical control in v1 fully prevents this.

**Mitigations:** Root KEK access is restricted in Phase.dev and Cloudflare with per-person
accounts and their own audit trails · production access requires MFA · this limitation is
stated plainly in `SECURITY.md` and the privacy documentation rather than obscured.

**Residual risk:** **High, and inherent to the trust model.** Customers who cannot accept it
need a zero-knowledge product. Saying so honestly is the only acceptable position.

---

### T10 — Loss of the Root KEK (not theft — loss)

| | |
|---|---|
| **Goal** | n/a — accident, not attack |
| **Impact** | **Existential** · **Likelihood** | Low, but non-zero |

Phase.dev account deleted, locked, or lost; Cloudflare account closed; the one person who
knew the ceremony leaves.

**Consequence:** **every customer's secrets become permanently unrecoverable.** A database
backup does not help — ciphertext without the key is noise.

**Mitigations:** 2-of-3 Shamir escrow stored offline in physically separate locations ·
documented, rehearsed restore procedure · quarterly drill assuming Phase.dev is gone · more
than one person knows the ceremony. See [`key-recovery.md`](key-recovery.md).

**Residual risk:** Low **only if the drills actually happen.** Untested backups are not
backups. This threat was entirely absent from the original project brief and is the reason
the recovery document is a hard gate on Phase 2.

---

## 4. Risk summary

| ID | Threat | Impact | Likelihood | Residual |
|---|---|---|---|---|
| T1 | Unauthenticated attacker | Critical | High | Low |
| T2 | Cross-tenant access | Critical | High | **Medium** |
| T3 | Malicious team member | High | Medium | Medium |
| T4 | Stolen CLI credential | High | Medium | Medium |
| T5 | Compromised CI | High | Medium | **Medium–High** |
| T6 | Database compromise | Low (secrets) | Low | Low |
| T7 | Worker compromise | Critical | Low | **Medium** |
| T8 | Supply chain | Critical | Low–Med | Medium |
| T9 | Insider | Critical | Low | **High (inherent)** |
| T10 | Root key loss | Existential | Low | Low *if drilled* |

**Where to spend effort, in order:** T2 (test matrix as a CI gate) · T10 (escrow drills) ·
T7 (dependency discipline, anomaly detection) · T5 (blast-radius limits, OIDC in v2).

## 5. Explicitly out of scope for v1

Nation-state adversaries · physical attacks on Cloudflare or Neon data centres · side-channel
and timing attacks against Web Crypto · malicious Cloudflare or Neon staff · compromise of a
customer's own systems after legitimate secret delivery.

## 6. Review log

| Date | Reviewer | Change |
|---|---|---|
| 2026-08-10 | — | Initial version, Phase 0 |
