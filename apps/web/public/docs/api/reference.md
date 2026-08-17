---
title: API endpoint reference
navTitle: Endpoint reference
description: Every HTTP endpoint — auth, organisations, projects, environments, secrets, bulk read, import and export, members, tokens and the audit log.
keywords: [xecret api endpoints, secrets rest endpoints, pull endpoint, audit api, members api, api reference]
updated: 2026-08-17
---

Every route, grouped the way you will look for them. Paths are relative to
`/api`, and `{…}` segments are slugs.

Read [the API overview](../api.md) first for authentication, errors and
pagination — none of it is repeated here.

## Version

| Method | Path | Notes |
|---|---|---|
| `GET` | `/version` | What is deployed. No credential required. |

```json
{
  "name": "xecret",
  "version": "0.1.0",
  "commit": "a1b2c3d",
  "builtAt": "2026-08-17T12:00:00Z"
}
```

The only unauthenticated endpoint that answers a `GET`, and the only one that
touches no database. Use it to check what a deployment is running before
reporting a bug against it, and to watch a deploy roll out.

`commit` is `git describe --always --dirty`, so a build made from a modified
tree says `a1b2c3d-dirty`. Both `commit` and `builtAt` read `unknown` on a build
that did not come from `scripts/deploy-web.sh` — a local `next build`, or CI.

It reports the build, never the install: no environment name, no bindings, no
dependency versions, no Firebase or database detail. Those describe how one
deployment is configured, which is not public.

## Auth

| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/session` | Body `{ idToken }`. Verifies with the identity provider, creates the user on first sign-in, bootstraps a personal organisation, sets the session and CSRF cookies. |
| `DELETE` | `/auth/session` | Signs out. Idempotent. |
| `GET` | `/auth/me` | You, your organisations, your role in each, and the PIN state. |
| `GET` `POST` | `/auth/pin` | Read the PIN state; set or change the PIN. Changing requires the current one. |
| `POST` | `/auth/pin/unlock` | Body `{ pin }`. Unlocks this session for 8 hours. |
| `POST` | `/auth/pin/lock` | Locks this session, or all of them with `{ everywhere: true }`. Does not sign you out. |
| `POST` | `/auth/pin/reset` | Emails a single-use reset link to your own address. Returns `{ sent, reason? }` — read the flag, not the status. |
| `POST` | `/auth/pin/reset/confirm` | Body `{ token, pin }`. Needs the emailed token **and** a session for the same account. |
| `GET` | `/auth/sessions` | Your active sessions. Never returns a token hash. |
| `DELETE` | `/auth/sessions` | Sign out everywhere. Optional `?except=current`. |
| `DELETE` | `/auth/account` | Deletes your account. Body `{ confirm: "<your email>" }`. Browser sessions only, PIN-gated. **409** if you are the only active owner of an organisation other people are in. |

A failed `POST /auth/session` returns 401 with a **fixed** message for every
cause — expired, wrong audience, bad signature, unverified email. The specific
reason is logged and never returned: telling a caller which part of a forged
token to fix is a gift.

## CLI authorization

How `xecret login` obtains a token. An RFC 8252-style loopback flow with PKCE,
against this server rather than the identity provider.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/cli/authorize` | Session + CSRF only. Body `{ orgSlug, deviceName, codeChallenge }`. Mints a single-use code, 10-minute TTL, hashed at rest. |
| `POST` | `/cli/token` | Public — the caller holds no credential yet. Body `{ code, codeVerifier }`. Returns the `xct_` token exactly once. Every failure is the same fixed 401. |
| `DELETE` | `/cli/token` | The token revokes itself — this is `xecret logout`. Idempotent. |

The code is consumed **before** the PKCE check, so a failed binding kills it
rather than leaving it guessable.

## Organisations

| Method | Path | Notes |
|---|---|---|
| `GET` | `/orgs` | Your memberships. Refused for a service token, which is pinned to one organisation. |
| `GET` | `/orgs/availability?slug=` | `{ slug, available, reason?: invalid\|reserved\|taken }`. A snapshot, not a reservation. |
| `POST` | `/orgs` | Body `{ name, slug? }`. Name is 25 characters at most. Session + CSRF only. Creates the organisation's key, a default project, its environments and each environment's key in one transaction. |
| `GET` | `/orgs/{orgSlug}` | Any active member. |
| `PATCH` | `/orgs/{orgSlug}` | The name only. A slug change is refused with an explanation rather than ignored. |
| `DELETE` | `/orgs/{orgSlug}` | Soft delete. Owners only, browser session only, body `{ confirm: "<orgSlug>" }`. |

## Projects and environments

| Method | Path |
|---|---|
| `GET` `POST` | `/orgs/{orgSlug}/projects` |
| `GET` `PATCH` `DELETE` | `/orgs/{orgSlug}/projects/{projectSlug}` |
| `GET` `POST` | `…/projects/{projectSlug}/environments` |
| `GET` `PATCH` `DELETE` | `…/environments/{envSlug}` |

Both deletes are soft. A hard delete would orphan the audit records saying the
thing existed and who removed it.

Creating an environment also creates its encryption key, in the same
transaction. An environment without a key cannot hold a secret and cannot be
repaired without an operator.

## Secrets

| Method | Path | Notes |
|---|---|---|
| `GET` | `…/environments/{envSlug}/secrets` | **Masked.** Names, versions, timestamps, who updated. No ciphertext leaves the database. |
| `POST` | `…/secrets` | Create. Body `{ name, value, note?, valueType? }`. |
| `GET` | `…/secrets/{name}` | **Reveal.** Decrypts one value. Audited as `secret.revealed` every time. |
| `PATCH` | `…/secrets/{name}` | Appends a new version. Body `{ value, valueType? }`. A value identical to the current one is a no-op, detected without decrypting. |
| `PUT` | `…/secrets/{name}` | Metadata only — `{ name?, note?, valueType? }`. Appends no version: declaring a type is not a rotation, and neither is a rename. |
| `DELETE` | `…/secrets/{name}` | Soft delete. |
| `GET` | `…/secrets/{name}/versions` | History. Metadata only. |
| `GET` | `…/secrets/{name}/versions/{version}` | Reveal one historical version. Audited, with the version recorded. |
| `POST` | `…/secrets/{name}/restore` | Body `{ version }`. Re-appends an earlier value as a new version; never rewrites history. |

The masked listing and the reveal endpoint are **separate routes on purpose**.
Decryption happens in exactly one handler, so "where can a plaintext secret be
produced?" has a one-line answer a reviewer can verify by searching the code.

## Bulk read

The path `xecret run` depends on.

| Method | Path |
|---|---|
| `GET` | `…/environments/{envSlug}/pull?format=env\|json\|yaml\|shell\|docker` |

One environment, every current secret, decrypted server-side. Its budget is at
most three database queries and **zero** outgoing network calls, constant in
the number of secrets.

Audited **once per call** as `secret.read` with a count — not once per secret,
which would make a 200-secret pull write 200 audit rows and turn the audit
table into a denial-of-service surface against itself.

## Import and export

| Method | Path | Notes |
|---|---|---|
| `POST` | `…/environments/{envSlug}/import` | Body `{ content, format?, strategy, dryRun }`. `dryRun: true` returns the plan and writes nothing. |
| `GET` | `…/environments/{envSlug}/export?format=…` | The same data as `pull`, as a file download. |

The dry run and the real import call the same planning function, so the preview
cannot disagree with the outcome.

## Members, invitations and grants

| Method | Path | Notes |
|---|---|---|
| `GET` | `/orgs/{orgSlug}/members` | Names, emails, roles, status, join dates, seat count. Never access grants — those are per-project and belong on a member's own page. |
| `POST` | `/orgs/{orgSlug}/members` | Invite by email. Session + CSRF only. Enforces the role hierarchy and the seat limit. Returns the acceptance link **once**. |
| `PATCH` | `/orgs/{orgSlug}/members/{memberId}` | Exactly one of `{ role }` or `{ status }` per request — they are different acts with different audit records. Refuses self-changes; last-owner guarded. |
| `DELETE` | `/orgs/{orgSlug}/members/{memberId}` | Refuses self-removal; last-owner guarded. Grants cascade. |
| `PUT` `DELETE` | `…/members/{memberId}/grants` | One grant, addressed by `{ projectSlug, environmentSlug?, accessLevel }`. Absent or null `environmentSlug` means the whole project. |
| `GET` | `…/members/{memberId}/access` | The effective-permission preview: every project and environment with the resolved level and the rule that produced it. Computed by the same function enforcement calls. |
| `GET` | `/orgs/{orgSlug}/invitations` | Open invitations, expired ones included. |
| `DELETE` | `/orgs/{orgSlug}/invitations/{invitationId}` | Withdraws one; the emailed link stops working at commit. |
| `POST` | `/invitations/lookup` | Public — the holder may have no account. Body `{ token }`. Returns the organisation name, invited address, role, state and expiry, and nothing else. |
| `POST` | `/invitations/accept` | Session + CSRF. Body `{ token }`. The session's address must match the invited one. |

## Tokens

| Method | Path | Notes |
|---|---|---|
| `GET` `POST` | `/orgs/{orgSlug}/tokens/service` | Body `{ name, projectSlug, environmentSlug, accessLevel?: read\|write, expiresAt?, ipAllowlist? }`. `read` by default; `admin` is unrepresentable. Returned **once**. |
| `GET` | `/orgs/{orgSlug}/tokens/cli` | "Your devices" — your own CLI tokens only, revoked ones included. |
| `DELETE` | `/orgs/{orgSlug}/tokens/{kind}/{tokenId}` | `kind` is `cli` or `service`. Your own CLI token: always. Anyone else's, or any service token: needs the revoke permission. |
| `GET` | `/tokens/self` | Service-token introspection: the pinned organisation, project and environment, plus the token's name and level. Derived from the credential row alone — there is no parameter to lie in. |

A created token's value appears in exactly one response and is never
retrievable again. No listing function selects the stored hash.

## Audit

| Method | Path | Notes |
|---|---|---|
| `GET` | `/orgs/{orgSlug}/audit` | Owners and admins. Filters: `actorId`, `action`, `projectSlug` (+ `environmentSlug`), `outcome`, `from`, `to`. Keyset pagination behind an opaque cursor. |

The response includes the `window` actually scanned, because the range is
clamped to 90 days and a caller that asked for more must be told it got less.

## Next

- [Tokens](tokens.md) — obtaining and scoping a credential.
- [The API overview](../api.md) — errors, CSRF, rate limits.
- [The audit log](../security/audit-log.md) — what each event means.
