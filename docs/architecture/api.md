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

### Service tokens and writes

A service token holding a `write` grant may create and update secrets. What it may never
do is act as a person: writes are attributed by a **pair** of columns — `created_by`
naming a user, or `created_by_service_token_id` naming the token — with a CHECK constraint
requiring exactly one (migration 0006). A CI write is recorded as the act of a named
token, never as the act of whoever minted it.

Two repairs were considered in Phase 4 and rejected, and the reasoning still governs the
design: attributing the write to the token's creator would put a person's name on a write
they did not make, in the one log a company reaches for during an incident; and making
`created_by` nullable *without* the paired column would have weakened attribution for
every write in the product.

`secret.delete` and `secret.rotate` remain outside the service-token allowlist entirely —
CI rotates a value by writing a new one; destroying history is a human's decision.

### Invitation-time access — deny-by-default

`POST /api/orgs/{orgSlug}/members` accepts a `grants` array of
`{ projectSlug, environmentSlug | null }` selections. When present (an empty array
included), acceptance becomes **deny-by-default**: every project the organisation has at
acceptance time receives an explicit project-wide `none` grant unless selected, selected
whole-projects and environments receive grants at the invited role's non-production level,
and the existing resolution rules (environment → project → role default, `none` always
denies) do the rest. A ticked production environment is the conscious act that grants it.
Selections are resolved to ids at invitation time — a bad slug fails in front of the person
who can fix it — and anything deleted before acceptance is skipped, safely covered by the
`none` rows. Invitations without the field (from before it existed) keep the old
role-default behaviour. Projects created *after* acceptance fall back to the role default;
narrowing that is the member page's job.

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
| `session_locked` | 403 | Authenticated, but the session's vault is locked — see §4 Auth |
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

### Version

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/version` | `{ name, version, commit, builtAt }`. No credential, no database, no rate limit. |
| `GET` | `/version` | The same body, outside the `/api` prefix. Not a redirect — both routes call `versionPayload()`. |

`/api/version` is the canonical one and sits with everything else. `/version`
exists because a version check is the one request made by somebody handed a
hostname and nothing else — an uptime monitor, a `curl` during an incident — and
a 404 there reads as a broken deployment. A 308 was rejected: it costs a monitor
a round trip and has to be explicitly followed by `curl` and most shell scripts,
which is a worse trade than one shared function.

The one endpoint that answers before anything else works. It goes through
`publicRoute` — so it carries a request id, logs, and the same error envelope as
everything else — but issues no query, which is deliberate: the moment you most
want to know what is deployed is the moment something else is failing.

`version` is inlined from `apps/web/package.json` at build time; `commit` and
`builtAt` are stamped by `scripts/deploy-web.sh`. A build from any other path
reports `unknown` for the latter two rather than inventing them, which also
means an `unknown` in production is itself a finding: that Worker was not
deployed by the script.

Unauthenticated on purpose, and the trade is worth stating because
`next.config.ts` turns `poweredByHeader` off on the principle that a secret
manager leaks no build detail. That rule is about disclosure bought for nothing.
Here the disclosure is close to nil — the server is AGPL, so the version names a
tag anyone can already read — and the value is real: the CLI can warn before
issuing a request this server is too old to satisfy. What the endpoint must
never grow is anything describing the *install* rather than the build; the shape
is pinned by a test for that reason.

### Auth

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/auth/session` | Body `{ idToken }`. Verifies with Firebase, upserts the user, bootstraps a personal organisation on first login, sets the session and CSRF cookies. Rate limited: `RL_LOGIN`. |
| `DELETE` | `/api/auth/session` | Revokes the current session, clears both cookies. Idempotent. |
| `GET` | `/api/auth/me` | The signed-in user, their organisations, their role in each, and the vault state (`{ configured, unlocked, unlockedUntil, autoLockMinutes }`). Never carries key material. Exempt from the lock gate. |
| `GET` | `/api/auth/sessions` | Active sessions for the "signed-in devices" view. Never returns a token hash. |
| `DELETE` | `/api/auth/sessions` | Sign out everywhere. Optional `?except=current`. |
| `DELETE` | `/api/auth/account` | The account deletes itself. Body `{ confirm: <account email> }`. Browser sessions only (never a bearer token), vault-gated, rate limited `RL_MUTATION`. The vault is deleted outright, so every environment key sealed to that account's public key becomes unopenable. One transaction: solo organisations are soft-deleted with the account, other memberships removed, every session and CLI token revoked, the user row soft-deleted — terminal, since the identity upsert refuses to revive a deleted row. **409** while the caller is the only active owner of an organisation other people are in: ownership must move first. Audited as `auth.account_deleted`; the response clears both cookies. |

`POST /api/auth/session` returns **401 with a fixed message** for every verification
failure — expired, wrong audience, bad signature, unverified email. The specific reason is
logged, never returned: telling a caller which part of a forged token to fix is a gift.

### The vault

Every secret is encrypted in the browser under a key hierarchy the server cannot open
(ADR 0009; byte-level formats in `docs/security/e2ee-crypto-spec.md`). These endpoints
store and return that hierarchy. **None of them decrypts anything, and none of them could
be extended to** — the server holds no key to extend them with.

Three conventions hold throughout:

- **Binary values travel as unpadded base64url.** Public keys, the KDF salt, the unlock
  verifier, lookup hashes and credential ids are raw bytes. Padding is refused, because
  two spellings of one value would make a `bytea` equality lookup miss one of them.
- **Wraps and encrypted private keys travel as `xk2.…` blob strings**, verbatim. The
  server checks the prefix, the alphabet and length bounds — never the contents. Request
  schemas are in `server/schemas/vault.ts` (`vaultCreateSchema`, `vaultUnlockSchema`,
  `vaultPassphraseSchema`, `recoveryBeginSchema`, `recoveryCompleteSchema`,
  `recoveryRegenerateSchema`, `passkeyEnrollSchema`, `autoLockSchema`).
- **A recovery kit is exactly five codes.** Redeeming one invalidates all five, because
  all five wrap the same User Key.
- **There are two unlock verifiers, and they are not interchangeable.**
  `unlockVerifier` is `HKDF(SK, …)` and only a passphrase can produce it;
  `ukUnlockVerifier` is `HKDF(UK, …)` and is what a passkey unlock sends, since it opens
  the User Key directly and never derives `SK`. They are stored as separate digests and
  compared against the matching one only.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/auth/vault` | `{ vault, material }`. `material` is `null` when no vault exists or the caller is a token; otherwise `{ encAlgorithm, encPublicKey, encPrivateKeyEnc, signAlgorithm, signPublicKey, signPrivateKeyEnc, kdfSalt, kdfParams, passphraseWrap, recoveryCodesRemaining, passkeys[] }`. `recoveryCodesRemaining` is a count — a recovery wrap is only ever returned in exchange for its own lookup hash. Served to a **locked** session on purpose: an unlock is a client-side operation, and a client cannot unwrap a key it has not been given. Exempt from the lock gate. |
| `POST` | `/api/auth/vault` | The setup ceremony, in one body: `{ encPublicKey, encPrivateKeyEnc, signPublicKey, signPrivateKeyEnc, kdfSalt, kdfParams, unlockVerifier, ukUnlockVerifier, passphraseWrap, recoveryWraps[5] }`, each recovery entry `{ lookupHash, wrap }`. Both verifiers are recorded here and only here, so either unlock path works from the moment a vault exists. Written in one transaction, and unlocks the session that ran it. **409** on a second call — never an overwrite, because the old public key has environment keys sealed to it. Rate limited: `RL_LOGIN`. Audited `vault.created`. Exempt from the lock gate. |
| `PATCH` | `/api/auth/vault` | Body `{ autoLockMinutes }`, one of the fixed menu; `0` disables the idle lock. Not exempt from the gate — a locked session has no business loosening a protection. Rate limited: `RL_MUTATION`. Audited `auth.autolock_changed`. |
| `POST` | `/api/auth/vault/unlock` | Body is **exactly one of** `{ unlockVerifier }` or `{ ukUnlockVerifier }` — a union, so a body carrying both or neither is a **422**. Compared in constant time against the matching stored `SHA-256`, sets `vault_unlocked_at` for 8 hours, returns `{ vault, unlockedUntil }`. Rate limited: `RL_LOGIN`, plus a durable per-account lockout (5 free attempts, then 60 s doubling to a 60 min ceiling) that **both** forms share — they attest to the same capability, and separate counters would be two budgets against one gate. Audited `vault.unlocked`, and `vault.unlock_failed` on refusal, each carrying `method: passphrase \| passkey` — with a uniform reason, so the audit log does not become the oracle the API refuses to be. Exempt from the lock gate. |
| `POST` | `/api/auth/vault/lock` | Locks this session, or every session with `{ everywhere: true }`. Does **not** revoke — the user stays signed in. Returns `{ locked }`. Audited `auth.locked`. |
| `POST` | `/api/auth/vault/passphrase` | Body `{ currentUnlockVerifier, unlockVerifier, kdfSalt, kdfParams, passphraseWrap }`. Re-wraps the User Key and swaps the verifier in one transaction; returns `{ vault, material }` so the client can replace the wrap it now holds. Requires an unlocked session **and** the current passphrase: the gate proves this session unlocked at some point in the last 8 hours, the verifier proves the person typing knows it now. The User Key is unchanged, so recovery codes keep working, enrolled passkeys keep working, `ukUnlockVerifier` stays valid, and other devices stay unlocked. Rate limited: `RL_LOGIN`, plus the same lockout as unlock. Audited `vault.passphrase_changed`. |
| `POST` | `/api/auth/vault/recovery` | Body `{ lookupHash }` — step one. Returns `{ wrap, material }` for the code that hash addresses. An unknown hash, an already-redeemed code and another account's code all get **one** indistinguishable refusal. Rate limited: `RL_LOGIN` under a `vault_recovery` key on the user alone, plus a per-account recovery lockout counted separately from the passphrase one, so a mistyped code cannot spend the budget protecting the passphrase. Exempt from the lock gate. |
| `POST` | `/api/auth/vault/recovery/complete` | Body `{ lookupHash, unlockVerifier, kdfSalt, kdfParams, passphraseWrap, recoveryWraps[5] }` — step two. Redeems the code, sets the new passphrase and reissues the whole kit in one transaction, then unlocks the session; returns `{ vault, material }`. The reset and the reissue are not optional: somebody here has lost control of their passphrase, and four other codes still open the same key. **409** if the code was redeemed in between. Audited `vault.recovery_used` **and** `vault.recovery_codes_regenerated`. Exempt from the lock gate. |
| `PUT` | `/api/auth/vault/recovery` | Body `{ unlockVerifier, recoveryWraps[5] }`. Reissues the kit from an unlocked session with the passphrase re-entered (sudo mode). Every live code is revoked in the transaction that writes the new five; redeemed ones keep their tombstones. Returns `{ vault, recoveryCodesRemaining }`. Audited `vault.recovery_codes_regenerated`. |
| `GET` `POST` | `/api/auth/vault/prf` | List, or enrol, a passkey for one-touch unlock. `POST` body `{ credentialId, label, transports?, wrap }` → **201** `{ passkey }`. A passkey is never the only wrap — the passphrase wrap always exists and has no removal path — so enrolling adds a door rather than replacing one. Rate limited: `RL_MUTATION`. |
| `DELETE` | `/api/auth/vault/prf/{passkeyId}` | Unenrols a passkey; its wrap goes with it by cascade. **204**. Scoped by user, so another account's id answers the same **404** as one that does not exist. |
| `POST` | `/api/auth/vault/reset` | Body `{ confirm: "reset my vault" }`, compared with the same trimming, case-insensitive helper `DELETE /api/auth/account` uses. Destroys `user_keys` and every wrap and passkey, and clears `vault_unlocked_at` on **all** the account's sessions, in one transaction; returns `{ vault }` reporting `configured: false`, so the client routes straight to the setup ceremony. **404** when there is no vault. **This is not recovery** — nothing is decrypted or restored, because nothing can be. Rate limited: `RL_LOGIN` under a `vault_reset` key of its own, deliberately *not* sharing recovery's counter. Audited `vault.reset`. Exempt from the lock gate, which is the entire point. |

**What the server holds.** Public keys, an Argon2id salt and its parameters, the digests of
both unlock verifiers, and a set of ciphertexts. Each verifier is a *sibling* HKDF branch of
a wrap key, so holding a digest opens nothing — they exist so the server can gate the API,
throttle attempts, and keep an audit trail. `ukUnlockVerifier` concedes nothing further:
anyone who can compute it already holds the User Key, and therefore already holds every
private key and environment key the account can reach, so the proof is strictly weaker than
the capability it attests to. A client MUST NOT send the stretched key, the User Key, any
wrap key, or any private key, including in diagnostics.

**The concession, stated plainly.** `GET /api/auth/vault` serves the wraps to a locked
session, because an unlock cannot happen otherwise. A stolen session cookie therefore
yields an *offline* Argon2id attack on the master passphrase, unbounded by the lockout.
That is inherent to a browser-delivered zero-knowledge product, and it is why ADR 0009
sets the passphrase bar where it does rather than at a composition rule.

### CLI authorization — how `xecret login` gets its token

RFC 8252-style loopback flow with PKCE (S256 only), against this server — never Firebase
directly. The CLI opens `/cli/authorize?challenge&port&device&state` in a browser; an
already-signed-in person approves the named device; the consent screen redirects the
one-time code to `http://127.0.0.1:{port}/callback`; the CLI exchanges code + verifier.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/cli/authorize` | Session + CSRF only — a bearer credential may not mint further credentials, and the vault lock gate applies. Body `{ orgSlug, deviceName, codeChallenge }`. Mints a single-use code (10 min TTL, hashed at rest, supersedes the user's outstanding codes). Requires active membership (`member.read`) — deliberately **not** `token.create`, which gates *service* tokens: a CLI token acts as its user and adds no authority. Rate limited: `RL_CLI_TOKEN`. Audited as `token.authorized`. |
| `POST` | `/api/cli/token` | Public — the caller holds no credential yet. Body `{ code, codeVerifier }`. The code is consumed atomically **before** the PKCE check, so a failed binding kills it rather than leaving it guessable. Membership is re-checked; the minted `xct_` token is returned exactly once. Every failure is the same fixed 401. Rate limited: `RL_CLI_TOKEN` by IP. Audited as `token.created`. |
| `DELETE` | `/api/cli/token` | The token revokes itself — `xecret logout`. CLI-token bearers only; idempotent; audited as `token.revoked` by the call that actually did it. |

Listing and revoking CLI tokens from the dashboard ("your devices") is the token
management routes below.

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

**Every membership mutation above reconciles the member's environment keys.** Gaining access
queues a key share (`envkey.grant_pending`); losing it deletes their grants and leaves the
environment owing a rotation (`envkey.grant_revoked`). One reconciliation rather than a branch
per act, because the acts compose: a role change can widen access on one environment and narrow
it on another in a single request.

`POST /api/orgs/{orgSlug}/members` additionally accepts `invitePublicKey` — the invitation's own
X25519 public key, derived by the inviter's client from a 16-byte fragment (crypto spec §10).
**The fragment never appears in this body or any other.** It travels to the invitee out of band,
over a different channel from the emailed link, which is the whole of the two-channel design: a
leaked email decrypts nothing, and a leaked fragment authenticates nothing.

The invitation's sealed grants are uploaded afterwards, one environment at a time, through
`POST …/environments/{envSlug}/keys/grants` with `recipientKind: "invite"`. They are *not*
accepted on the invitation body, and the reason is not tidiness: a grant names its recipient,
never its resource, so a batch posted there would carry no unambiguous statement of which
environment each belongs to — and filing a key under the wrong environment produces a row that
looks exactly like a working grant until somebody tries to use it. The per-environment route has
the environment in its path.

### Accepting an invitation

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/invitations/lookup` | Public — the holder may have no account yet. Body `{ token }`. Returns the organisation's display name, the invited address, role, state and expiry; nothing else. The token travels in the body, never the query string. Rate limited: `RL_INVITE` by IP. |
| `POST` | `/api/invitations/accept` | Session + CSRF. Body `{ token }`. The session's address must match the invited one — a forwarded email must not let a colleague join as somebody else. State, address, seat count and the membership insert are all settled inside one transaction under the organisation lock. Audited as `member.joined`. Acceptance then reconciles the new member's environment keys, which queues a share for every `e2ee` environment they can now read — including ones the invitation carried sealed grants for, because those are sealed to the invite keypair rather than to the invitee's own, and they hold no member grant until they re-seal. |

### Organisations

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/orgs` | The caller's memberships. No `authorize()` call: the answer *is* the set of organisations they hold an active membership in, established in SQL. Refused for a service token, which is pinned to one organisation and has no switcher. |
| `GET` | `/api/orgs/availability?slug=` | Is an organisation slug free? Returns `{ slug, available, reason?: invalid\|reserved\|taken }` — one bit and a category, never who holds it. The categories come from `checkSlug` in `@xecret/core/validation`, the same function `organizationSlugSchema` is built from, so this route cannot report a slug as available that `POST` would reject. Browser session only — the same rule as `POST /api/orgs` and `DELETE /api/orgs/{orgSlug}`, because a leaked CLI token would otherwise be able to enumerate the global namespace — and rate limited on `RL_SLUG_CHECK`. A **snapshot, not a reservation**: the unique index settles the race, and `POST` still answers 409. `availability` is a reserved slug, so no organisation can shadow this route. |
| `POST` | `/api/orgs` | Body `{ name, slug? }`. `name` is at most `ORGANIZATION_NAME_MAX_LENGTH` (25) characters — shorter than a project name, because it is rendered in the sidebar switcher and every breadcrumb. `slug` is what the dashboard always sends, having shown it to the user and checked it; it is claimed **exactly**, and a collision is a 409 on the `slug` field rather than a silent `acme-2`. Omitted, the slug is derived from the name and uniquified — the path sign-up and API clients take, where there is nobody to ask. Session + CSRF only: a CLI token acts as its user for secrets, not for existence. Provisions the Org Master Key, a default project, its environments and an Env Data Key for each in one transaction — an organisation without them cannot hold a secret and cannot be repaired. Rate limited: `RL_MUTATION` by user, and capped at `ORGANIZATIONS_PER_ACCOUNT_LIMIT` (10) — counted as the live organisations the account created **and is still an active member of**, so being removed from one releases the place and being made an owner of somebody else's spends nothing. A rate limit bounds the cost per minute, and this endpoint also spends something no deletion returns, since a claimed slug leaves the shared namespace permanently. The count and the refusal happen inside the provisioning transaction, behind a `SELECT … FOR UPDATE` on the account row, so concurrent creations from one account queue rather than race past the ceiling. Over the cap the answer is 409. Audited as `org.created` — the refusal too, with `reason: quotaExceeded`, filed against an organisation the account is a member of, or not at all when it is in none. |
| `GET` | `/api/orgs/{orgSlug}` | `member.read`, which every active role holds. |
| `PATCH` | `/api/orgs/{orgSlug}` | The name only, under the same 25-character ceiling as creation. `assertSlugImmutable` refuses a slug change with an explanation rather than ignoring it. Requires `org.update`. Audited as `org.updated`. |
| `DELETE` | `/api/orgs/{orgSlug}` | Soft delete. Requires `org.delete` — owners only, the one action an admin is denied — a browser session, and `{ "confirm": "<orgSlug>" }`. Everything inside stops resolving at once, for every member, because each read joins back through `organizations` with a `deleted_at is null` filter. Audited as `org.deleted`; an unconfirmed attempt is recorded too. |

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

**Every environment created from Phase 3 onward is end-to-end encrypted.** `POST` therefore
requires the client-generated key hierarchy alongside the name:
`{ name, slug?, isProduction?, sortOrder?, keys: { grant } }`, where `grant` is the EDK and the
EHK sealed to the creator's own public key and signed by their signing key (see *Environment
keys* below for the shape). There is **no `encryptionMode` field**, and there must not be:
`server` mode is a migration state, not a choice, and offering it as one would let a client opt
an environment out of end-to-end encryption for the life of that environment.

The environment row, the `env_data_keys` row, the `env_hmac_keys` row and the creator's grant
land in **one transaction**. That mattered before and matters more now: a `server`-mode
environment created without its key needs an operator holding the Root KEK to repair, while an
`e2ee` one created without its keys **cannot be repaired at all** — the bytes existed only in a
browser that has since navigated away.

**A service or CLI token cannot create an environment.** Producing the grant means sealing to a
public key and signing with a private one, and a bearer credential has neither: it holds no
vault. The refusal is a `bad_request` naming what is missing, not a `forbidden`, because nothing
about the caller's permissions is wrong — they are holding the wrong kind of credential. A user
who has not completed the vault ceremony is refused for the same reason and told to run it.

The environment payload carries `encryptionMode`, and every client has to branch on it: the
body a secret write takes, whether a reveal returns a plaintext, and whether an export can be
requested at all all depend on it. A client that had to *discover* the mode by sending the
wrong body and reading the error would put a plaintext credential in a request to an e2ee
environment exactly once, which is once too many.

### Environment keys

| Method | Path | Notes |
|---|---|---|
| `GET` | `…/environments/{envSlug}/keys` | The caller's own grant, the active key, and the administrative state. `secret.read`. |
| `POST` | `…/environments/{envSlug}/keys` | Initialise, for an `e2ee` environment that somehow has none. Body `{ grant }`. `environment.update`. A second call is a **409**. |
| `POST` | `…/environments/{envSlug}/keys/rotate` | Body `{ newVersion, grants: [...] }` — the **complete** replacement set. `environment.update`. |
| `POST` | `…/environments/{envSlug}/keys/grants` | Body `{ envDataKeyId, grants: [...] }`. Hands the key to principals that did not have it. `secret.read`. |
| `DELETE` | `…/environments/{envSlug}/keys/grants/{grantId}` | Removes one grant. `environment.update`. |

A grant is `{ recipientKind: "member" | "token" | "invite", recipientId, edkSealed, ehkSealed,
signature }`. The blobs are `xk2.x25519.` sealed boxes and an `xk2.ed25519.` signature (crypto
spec §§2, 5, 6). **The server validates shape, never meaning**: prefix, alphabet and length, and
then it stores what it is given. It holds no key with which it could do more, and a validator
that opened a grant would be the first line of the code path ADR 0009 exists to make
impossible.

`recipientKind` and `recipientId` travel in the body rather than being inferred, because both
are **signed** (spec §6.1) — so a server cannot relabel a service-token grant as a member grant
or move a valid grant between principals. Accepting them as fields, and storing them into the
columns the signature names, is what makes that guarantee reachable when verification is later
enabled.

`GET` answers:

```jsonc
{
  "keys": {
    "encryptionMode": "e2ee",
    "activeEdk": { "id": "…", "version": 3 },
    "myGrant": { "edkSealed": "xk2.x25519.…", "ehkSealed": "…", "signature": "…",
                 "signedByUserId": "…" },
    "ehkExists": true,
    "pendingGrants": [ … ],          // admins only; null for anyone else
    "needsRotation": false,
    "currentMaxSecretVersion": 41
  }
}
```

**`needsRotation`** is the honest name for "somebody's grant was deleted and the key they held
has not been replaced". Deleting a grant stops a principal being handed the key *again*; only a
rotation stops the copy they already have from opening what is written next. Until one lands
with a version bump the revocation is on paper, and this field is how a dashboard says so
rather than letting an administrator believe an act completed that did not. It is **derived**
from the rows, never stored, so it cannot drift from the grants it describes.

**`currentMaxSecretVersion`** is freshness groundwork and nothing more. ADR 0009 records
rollback as an accepted residual risk — a server can serve stale grants or omit recent
`secret_versions`, and signatures do not help because they prove origin rather than recency.
Returning it on every key read means a client-side monotonic counter can be added later without
an API change. **Nothing on the server enforces it**; a compromised server would report a lower
number.

**`pendingGrants` is served only to callers who can act on it.** It names other people, and a
developer learning that three teammates are waiting for production keys learns the shape of the
team's access without holding any authority over it.

#### Rotation completeness — the one thing the server checks

The client generates the new key and seals it, because only the client can. But that means the
client also chooses who receives it, and a client that quietly omitted somebody would produce a
request that succeeds and **silently revokes a colleague**: they keep read access, keep seeing
every secret name, and simply cannot decrypt anything written afterwards — a failure with no
error, no screen, and no audit record beyond a successful rotation.

So the server recomputes the required set from the authorization model and requires an exact
match:

- **Every active member** whose resolved level on this environment is at least `read`, decided
  by the same `can()` every request goes through — so the key set and the access model cannot
  disagree.
- **Every service token** pinned to this environment that still has a `public_key`. Tokens
  minted before the Phase 4 creation flow have no keypair, so there is nothing to seal to;
  excluding them is what stops a rotation being blocked for ever by a legacy credential nobody
  can re-key.
- **Invitations are permitted but never required.** Their grants are sealed to a one-off keypair
  whose private half exists only in a fragment the server has never seen, so nobody rotating can
  re-seal to them.

Both directions are refused, and the second matters as much: an **extra** grant is a key handed
to somebody the access model does not permit, minted through the one endpoint whose job is
writing grants in bulk. Without the check, a rotation would be a way to give a viewer production
keys while the audit log recorded routine maintenance.

The refusal is a `422` naming the principals that are missing or surplus. That is a deliberate
exception to §3's rule against echoing request content: the ids are ones the caller already
holds, and the alternative — "your grant set is wrong", against a set of forty — gives a client
no way to correct it except to re-derive everything and hope.

`newVersion` is supplied by the client rather than computed here, because every grant has
already been sealed with that number bound into its AAD (spec §4.2). If the server assigned it,
a rotation racing another would produce grants whose AAD names version 4 stored against a row
numbered 5 — every one of which would fail to open, for ever, with no error at write time. A
mismatch is a `409` the client retries after re-reading.

#### The pending key-share queue

Access is decided by people who may not hold the key. An owner can grant a developer access to
`production` without ever having opened it, and if they hold no grant their browser has no EDK
to seal. Refusing the access change would make authorization depend on who happens to hold which
key; granting it with no key would leave a member who can list every secret name and decrypt
none of them, with nothing anywhere saying why.

So the access change lands and a row records the debt, which the next unlocked member holding
that key fulfils through `POST …/keys/grants` — the grant and the queued row are written and
deleted in one transaction, so the banner cannot outlive the key it was asking for. Every
membership mutation (add, role change, grant change, suspend, reinstate, remove, invitation
acceptance) runs the same reconciliation, so an act nobody thought about is still handled.

Audit: `envkey.created`, `envkey.rotated`, `envkey.granted`, `envkey.grant_revoked`,
`envkey.grant_pending`. The last two both describe *partial* acts, and a partial act with no
record is how an administrator comes to believe something finished.

### Secrets

Every route below serves both encryption modes, and the mode is read from the environment row —
never from a request. `server` behaviour is unchanged, field for field.

| Method | Path | Notes |
|---|---|---|
| `GET` | `…/environments/{envSlug}/secrets` | **Masked.** Names, versions, timestamps, updater, and `encNote` for `e2ee` rows. No value ciphertext leaves the database. |
| `POST` | `…/secrets` | Create. `server`: `{ name, value, note?, valueType? }`. `e2ee`: `{ name, value: { ciphertext, clientAlgorithm, envDataKeyId, valueHmac }, encNote?, valueType? }`. |
| `GET` | `…/secrets/{name}` | **Reveal.** `server` decrypts and returns `value`; `e2ee` returns `value: null` plus `ciphertext`, `clientAlgorithm` and `envDataKeyId`. Audited as `secret.revealed` in both. |
| `PATCH` | `…/secrets/{name}` | Appends a new version, same two body shapes. A value identical to the current one is a no-op in **both** modes, detected via `value_hmac` without decrypting. |
| `PUT` | `…/secrets/{name}` | Metadata only — `{ name?, note?, encNote?, valueType? }`. Appends **no** version. Sending `note` to an `e2ee` environment, or `encNote` to a `server` one, is refused rather than ignored. |
| `DELETE` | `…/secrets/{name}` | Soft delete. |
| `GET` | `…/secrets/{name}/versions/{version}` | **Reveal one historical version.** In `e2ee` mode `envDataKeyId` may name a **retired** key — a version written before a rotation is still encrypted under the key that was active then. |
| `GET` | `…/secrets/{name}/versions` | History. Metadata only — no ciphertext, no values. |
| `POST` | `…/secrets/{name}/restore` | `server`: `{ version }`, and the Worker re-encrypts. `e2ee`: `{ version, value: { … }, encNote? }` — the client reads the old version, decrypts it, encrypts the same plaintext for the version about to be written, and posts the result. |

**Why an `e2ee` restore carries a ciphertext.** A restore is a *re-encryption*, never a copy:
the AAD binds `version`, so bytes produced for version 3 and stored as version 7 would fail to
decrypt for the rest of their life, silently. In `server` mode the Worker performs it because it
holds the key; here it cannot, so the only party that can does. The server records which version
was restored *from*, and does not pretend to have verified that the ciphertext holds that
version's value.

**No value-type check in `e2ee` mode.** `checkSecretValue` inspects a plaintext, and this path
has none — the shape of a value is the client's to enforce, with the same
`@xecret/core/validation` module the dashboard already runs as you type. This is the one
guarantee the migration genuinely gives up, and pretending otherwise (by checking a
ciphertext's length, say) would be worse than conceding it. The declared type is still stored,
still inherited across a rotation, and still the rule the client applies.

The masked listing and the reveal endpoint are **separate routes on purpose**. Decryption
happens in exactly one handler, so "where can a plaintext secret be produced?" has a
one-line answer that a reviewer can verify by grep — and after ADR 0009 that answer is narrower
still: only the server half of `secrets-service.ts`, and only for environments that have not
migrated.

### Bulk read — the path `xecret run` depends on

| Method | Path |
|---|---|
| `GET` | `…/environments/{envSlug}/pull?format=env\|json\|yaml\|shell\|docker` |

In `server` mode: one environment, every current secret, decrypted server-side. Budget: **≤3
queries and 0 outgoing fetches**, constant in the number of secrets. Audited once per call as
`secret.read` with a count — not once per secret, which would make a 200-secret pull write
200 audit rows and turn the audit table into a denial-of-service surface against itself.

In `e2ee` mode the same two queries return a JSON bundle instead:
`{ encryptionMode: "e2ee", keys: { … }, secrets: [ { name, ciphertext, clientAlgorithm,
envDataKeyId, version, … } ] }`. The **caller's grant travels with the values**, and that is
not a convenience: fetching `…/keys` and then `…/pull` would be two round trips on the hottest
path in the product and would open a window in which a rotation lands between them, leaving the
client holding a key for one version and ciphertext for another with nothing in either response
saying so.

`format` is not consulted in `e2ee` mode, and a caller who asks for one is not silently given
JSON — formatting takes plaintext, so it moves to the client with the decryption. A caller who
has access but no grant gets a **409 `no_key_grant`** rather than a 403: their permissions are
not the problem, and the request succeeds the moment somebody fulfils the queued share.

### Import / export

| Method | Path | Notes |
|---|---|---|
| `POST` | `…/environments/{envSlug}/import` | `server`: `{ content, format?, strategy, dryRun }`. `e2ee`: `{ entries: [{ name, value: { … }, encNote? }], dryRun }`. |
| `GET` | `…/environments/{envSlug}/export?format=…` | Same data as `pull`, as a file download. **`e2ee` returns 409 `client_side_only`.** |

The dry run and the real import call the **same** planning function, so the preview cannot
disagree with the outcome. In both modes `dryRun: true` runs every decision — including the
HMAC comparison that produces `unchanged` — and stops before the transaction.

**What moved in `e2ee` mode is the parsing.** A `server`-mode import receives a `.env` file and
parses it here, because parsing means reading the values and the Worker is allowed to. An
`e2ee` import receives the *outcome* — names and ciphertexts — because the same
`@xecret/core/importer` module runs in the browser and the CLI, and a file uploaded to be parsed
would be every secret in it, in plaintext, in a request body. The `skip`/`overwrite`/`rename`
strategy is applied client-side for the same reason: it is a decision about names, and names are
plaintext in both modes.

**Export refuses rather than degrades.** Formatting takes plaintext, and the client already
holds every value — it decrypted them to show them — so the download is one it can build itself
with `@xecret/core/format` compiled for the browser. The `client_side_only` marker is stable so
a client can branch on it rather than on prose.

### Tokens

| Method | Path | Notes |
|---|---|---|
| `GET` `POST` | `/api/orgs/{orgSlug}/tokens/service` | Both gated on `token.create` — the listing is a map of every standing credential, which is reconnaissance for anyone who should not hold it. Minting is session + CSRF only (a bearer credential may not mint further credentials). Body `{ name, projectSlug, environmentSlug, accessLevel?: read\|write, expiresAt?, ipAllowlist? }` — `read` by default, `admin` unrepresentable. The token is returned **once**; only its hash is stored. Audited as `token.created`. |
| `GET` | `/api/orgs/{orgSlug}/tokens/cli` | "Your devices" — the caller's **own** CLI tokens only, revoked ones included so a recent revocation is visible. An admin revokes others' tokens without browsing their device names first. |
| `DELETE` | `/api/orgs/{orgSlug}/tokens/{kind}/{tokenId}` | `kind` is `cli` or `service`. Your own CLI token: always. Someone else's, or any service token: `token.revoke`. Immediate — the hash lookup filters `revoked_at IS NULL` in SQL — and idempotent, with the audit record written only by the call that actually did it. |
| `GET` | `/api/tokens/self` | Service-token introspection: the pinned organisation, project and environment as names and slugs, plus the token's own name and level. The answer derives from the credential row alone — there is no parameter to lie in. This is how `XECRET_TOKEN=… xecret run` learns its scope without configuration. |

A created token's value appears in exactly one response — the creation's — and is never
retrievable again. No listing function selects `token_hash`. The same rule governs the
invitation link above.

### Audit

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/orgs/{orgSlug}/audit` | `audit.read` (owners and admins). Filters: `actorId`, `action`, `projectSlug` (+`environmentSlug` within it), `outcome`, `from`, `to`. Keyset pagination over `(created_at, id)` behind an opaque cursor — §5's prescription, on the one table where offset pagination would corrupt under its own write load. The response includes the `window` actually scanned, because the range is clamped to 90 days and a UI showing less than it was asked for must say so. |

---

## 5. Pagination

Keyset, not offset:

```
GET …/secrets?limit=50&cursor=<opaque>
→ { "data": [...], "nextCursor": "…" | null }
```

Offset pagination re-scans on every page and shifts under concurrent inserts, so a row can
be skipped or repeated between pages. On the append-only, quarter-partitioned audit table
that degradation is severe. `limit` is clamped to 200.

---

## 6. Rate limits

| Bucket | Applies to | Key |
|---|---|---|
| `RL_LOGIN` | `POST /api/auth/session`, vault create / unlock / passphrase | IP + subject |
| `RL_LOGIN`, `vault_recovery` key | Vault recovery, both steps | user id alone |
| `RL_LOGIN`, `vault_reset` key | Vault reset | user id alone |
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
The zero-knowledge events extend that rather than weakening it: there is no `wrap`, no
`verifier`, no `lookupHash` and no `recoveryCode` field. A vault event records a *shape* —
which kind of wrap, how many codes — never the material.

The vault's own events are `vault.created`, `vault.unlocked`, `vault.unlock_failed`,
`vault.passphrase_changed`, `vault.recovery_used`, `vault.recovery_codes_regenerated` and
`vault.reset`. `vault.recovery_used` is the line an incident review looks for first: it is
the only path that opens a vault with neither the passphrase nor an enrolled passkey.
`vault.reset` is the only record that an account's existing ciphertext became permanently
unreadable at a particular moment, which is what makes an otherwise inexplicable "I cannot
see any of my secrets" answerable.

The environment-key events are `envkey.created`, `envkey.rotated`, `envkey.granted`,
`envkey.grant_revoked` and `envkey.grant_pending`. Two of them are worth reading together:

- `envkey.grant_revoked` records that somebody's key was taken away, and **not** that the
  environment became safe again — they read what they read while they held it, and the sealed
  blob may still be in a browser or a token string.
- `envkey.rotated` is what closes that: it carries `keyVersion` and `grantCount`, so "the
  production key was rotated and re-sealed to 9 principals" is checkable against the roster, and
  a count that drops without a matching removal is the shape of a rotation that quietly lost
  somebody.

An environment where the first appears and the second never does has been revoked on paper only,
which is exactly what `needsRotation` reports until it lands.

`envkey.grant_pending` is the honest record of a partial act: access changed and the member
still cannot read anything. That state looks like a bug from every screen in the product, and
without this event the audit log would show the access grant with no explanation of the gap
that followed it.

These events extend the metadata allowlist by `principalKind` and `grantCount` — a kind and a
count, never a recipient's key and never a sealed blob, following the same rule `wrapKind`
does. A grant placed in an audit record would put ciphertext into the one table the product is
built to keep readable, and the type system refuses it for the same reason it refuses a secret
value.
