---
title: API endpoint reference
navTitle: Endpoint reference
description: Every HTTP endpoint — auth, organisations, projects, environments, secrets, bulk read, import and export, members, tokens and the audit log.
keywords: [xecret api endpoints, secrets rest endpoints, pull endpoint, audit api, members api, api reference]
updated: 2026-10-14
---

Every route, grouped the way you will look for them. Paths are relative to
`/api`, and `{…}` segments are slugs.

Read [the API overview](../api.md) first for authentication, errors and
pagination — none of it is repeated here.

## Version

| Method | Path | Notes |
|---|---|---|
| `GET` | `/version` | What is deployed. No credential required. |

Answered at **both** `https://<host>/api/version` and `https://<host>/version` —
the same body, no redirect between them. The second is there because a version
check is the one request made by someone holding a hostname and nothing else.

```json
{
  "name": "xecret",
  "version": "0.1.0",
  "commit": "a1b2c3d",
  "builtAt": "2026-08-17T12:00:00Z"
}
```

The only unauthenticated `GET` that answers with data rather than a sign-in
redirect, and the only endpoint that touches no database. Use it to check what a deployment is running before
reporting a bug against it, and to watch a deploy roll out.

`commit` is `git describe --always --dirty`, so a build made from a modified
tree says `a1b2c3d-dirty`. Both `commit` and `builtAt` read `unknown` on a build
that did not come from `scripts/deploy-web.sh` — a local `next build`, or CI.

It reports the build, never the install: no environment name, no bindings, no
dependency versions, no identity-provider or database detail. Those describe how one
deployment is configured, which is not public.

## Auth

| Method | Path | Notes |
|---|---|---|
| `GET` | `/auth/login` | Starts a sign-in: sets a short-lived signed cookie and redirects (**307**) to the identity provider's hosted sign-in page. Optional `?next=` (a path on this site to land on afterwards), `?hint=sign-up`, `?org=<slug>` (start that organisation's single sign-on directly, if it has one). A link, not an API call. |
| `GET` | `/auth/callback` | Where the identity provider sends the browser back. Checks the flow belongs to this browser, verifies the sign-in with the provider, creates the account on first sign-in, bootstraps a personal organisation, sets the session and CSRF cookies, and redirects (**303**) to `next`. |
| `DELETE` | `/auth/session` | Signs out. Idempotent. Answers `{ logoutUrl }`: the sign-in provider's logout address for the session you signed in with, which the dashboard opens so that you are signed out there too — or `null` when there is none to end. |
| `GET` | `/auth/me` | You, your organisations, your role in each — with `sso: { required, blocked }`, whether the organisation requires single sign-on and whether that refuses the credential you are using — and the PIN state. |
| `GET` `POST` | `/auth/pin` | Read the PIN state; set or change the PIN. Changing requires the current one. |
| `POST` | `/auth/pin/unlock` | Body `{ pin }`. Unlocks this session for 8 hours. |
| `POST` | `/auth/pin/lock` | Locks this session, or all of them with `{ everywhere: true }`. Does not sign you out. |
| `POST` | `/auth/pin/reset` | Emails a single-use reset link to your own address. Returns `{ sent, reason? }` — read the flag, not the status. |
| `POST` | `/auth/pin/reset/confirm` | Body `{ token, pin }`. Needs the emailed token **and** a session for the same account. |
| `GET` | `/auth/sessions` | Your active sessions. Never returns a token hash. |
| `DELETE` | `/auth/sessions` | Sign out everywhere. Optional `?except=current`. |
| `DELETE` | `/auth/account` | Deletes your account. Body `{ confirm: "<your email>" }`. Browser sessions only, PIN-gated. **409** if you are the only active owner of an organisation other people are in. |

Signing in is a sequence of browser navigations, not an API call: nothing on
this server accepts an identity-provider token, and there is no endpoint to post
a password to. A refused sign-in redirects to `/sign-in?error=<code>`, which
shows a fixed sentence for that code. The specific reason is logged and never
shown: telling a caller which part of a forged request to fix is a gift.

### Re-authentication for a vault reset

Resetting a vault ends access to everything it held — the old vault is kept,
recoverable, for seven days, then deleted for good — so it asks for proof twice,
in order: a fresh sign-in (`/auth/login?reauth=1`, which makes the provider ask
for a credential even if it remembers you), then a one-time code emailed to you.
Browser sessions only, and usable while the vault is locked — which is the
point. A refused re-authentication is a **403**, never a 401, so it does not
sign you out.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/auth/reauth` | Where this session's attempt stands: `{ signedIn, signedInUntil, codeSent, email }`. Sends nothing. |
| `POST` | `/auth/reauth/start` | Emails the code. Only within 10 minutes of the fresh sign-in, and at most three times per sign-in (then **403**: sign in again). **204**. |
| `POST` | `/auth/reauth/verify` | Body `{ code }` (six digits, from the email) — or, after a `{ mfaRequired: true, mfaToken }` answer, `{ totp, mfaToken }` with the code from your authenticator app. Returns `{ reauthProof, expiresAt }` — single-use, five minutes, good for this session only. Every guess counts: five per attempt, ten per account per day; past the daily limit, **429**. |
| `GET` | `/auth/vault/reset/preflight` | What a reset would do with the vault's escape archive, asked before you confirm: `{ resettable, archive: { deliverable, reason } }`. `reason` is `null`, `too-large` (the archive is over 8 MiB, and then `estimatedBytes` and `maxBytes` are included) or `mail-not-configured`. `resettable` is `false` on a production deployment with no email set up: it resets no vault. An unlocked session also gets the size and the counts of environments and secrets. **404** with no vault. Usable while locked. |
| `POST` | `/auth/vault/reset` | Body `{ confirm: "reset my vault", reauthProof, proceedWithoutArchive? }`. First, before the proof is spent: **503** on a production deployment with no email set up, whatever the body says; **409** when the archive cannot be emailed (too large, or no email outside production) and `proceedWithoutArchive` is not `true`. Then it spends the proof, emails the escape archive to your address (at most two parts; a notice instead when you chose to go without), and resets the vault — keeping the old one, recoverable, for seven days. **503** if an email cannot be sent, **409** if your vault changed in between; nothing is reset in either case, and a retry needs a new proof. **404** with no vault. Returns `{ vault, archive, retained }`: `archive` is `{ emailed: true, parts, to }` or `{ emailed: false, reason }`; `retained` is `{ id, retainedUntil, grantCount }`. **This is not recovery** — nothing is decrypted or restored. |

### Recovering a reset vault

Inside its seven days, a reset vault can be brought back into the vault you
have now, in the browser, with its old passphrase or one of its recovery codes
(see [Vault reset and archive](/docs/security/vault-archive)). These endpoints
need an **unlocked** session — re-sealing the old keys into the current vault
needs it open — and answer only the vault's owner, only inside the window: the
same **404** for anything else, a malformed id included.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/auth/vault/retained` | Your reset vaults still inside their window: `{ retained: [{ id, retainedAt, retainedUntil, recoveredAt, grantCount, environmentCount, recoveryCodesRemaining }] }`. |
| `GET` | `/auth/vault/retained/{id}` | What the browser needs to open one: its passphrase wrap, salt and parameters, encrypted private key, and the grants of environments you may still read. Never its recovery wraps. |
| `POST` | `/auth/vault/retained/{id}/recovery-wrap` | Body `{ lookupHash }` → `{ wrap }`: the recovery wrap one of its codes opens. Every miss is one **400**, counted against the retained vault's own lockout; **429** while locked out. |
| `POST` | `/auth/vault/retained/{id}/restore` | Body `{ ukUnlockVerifier, grants }`: its keys, re-sealed in the browser to your current vault and signed by it, with proof the old vault was opened. A wrong proof is **403** and counted; **429** while locked out. Returns `{ restored, skipped }`. There is no endpoint that deletes a reset vault. |

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
| `POST` | `/orgs` | Body `{ name, slug? }`. Name is 25 characters at most. Session + CSRF only. Creates the organisation, your owner membership and the organisation's key in one transaction. No project is seeded — create the first one from the dashboard, which generates its environment keys in your browser. |
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

Creating a project or an environment also creates the encryption keys, in the
same transaction. A project arrives with `development`, `staging` and
`production`, so `POST /orgs/{orgSlug}/projects` carries the keys for all three:
`{ name, slug?, description?, environments: [{ slug, id, keys: { grant } }] }`,
where each `slug` names which of the three defaults the entry is for. Both
creates need a browser session with an unlocked vault — the keys are generated
there and sealed to you — and are refused for a CLI or service token. An
environment without a key cannot hold a secret and cannot be repaired.

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
| `GET` | `/orgs/{orgSlug}/members` | Names, emails, roles (with any custom role, by name), status, join dates, seat count. Never access grants — those are per-project and belong on a member's own page. |
| `POST` | `/orgs/{orgSlug}/members` | Invite by email. Session + CSRF only. Enforces the role hierarchy and the seat limit. Returns the acceptance link **once**. |
| `PATCH` | `/orgs/{orgSlug}/members/{memberId}` | Exactly one of `{ role }`, `{ status }` or `{ customRoleId }` per request — they are different acts with different audit records. `customRoleId: null` takes a custom role off. Refuses self-changes; last-owner guarded. Putting somebody on a custom role needs the Enterprise plan; taking one off never does. An owner cannot hold one (**409**). |
| `DELETE` | `/orgs/{orgSlug}/members/{memberId}` | Refuses self-removal; last-owner guarded. Grants cascade. |
| `PUT` `DELETE` | `…/members/{memberId}/grants` | One grant, addressed by `{ projectSlug, environmentSlug?, accessLevel }`. Absent or null `environmentSlug` means the whole project. |
| `GET` | `…/members/{memberId}/access` | The effective-permission preview: every project and environment with the resolved level and the rule that produced it. Computed by the same function enforcement calls. |
| `GET` | `/orgs/{orgSlug}/authority` | What *you* could grant: per environment, the highest level a grant you write there may carry. The dashboard caps its level controls with it. |
| `GET` | `/orgs/{orgSlug}/invitations` | Open invitations, expired ones included. |
| `DELETE` | `/orgs/{orgSlug}/invitations/{invitationId}` | Withdraws one; the emailed link stops working at commit. |
| `POST` | `/invitations/lookup` | Public — the holder may have no account. Body `{ token }`. Returns the organisation name, invited address, role, state and expiry, and nothing else. |
| `POST` | `/invitations/accept` | Session + CSRF. Body `{ token }`. The session's address must match the invited one. |

## Custom roles

Enterprise only. A custom role narrows a built-in role — it can never give
anybody more than the role it is based on. See
[Teams and access](../guides/teams.md#custom-roles).

| Method | Path | Notes |
|---|---|---|
| `GET` | `/orgs/{orgSlug}/roles` | Every role with how many members hold it, and whether the plan lets you define and assign them. Needs the manage-members permission. Never plan-gated. |
| `POST` | `/orgs/{orgSlug}/roles` | Body `{ name, baseRole: admin\|developer\|viewer, allowedActions, accessCeiling?: { nonProduction, production } \| null }`. Names are unique per organisation as a reader sees them — two names that differ only in case, letter width, spacing or lookalike letters are one name (**409**) — and may not be, or imitate, a built-in role's. Invisible characters, and Latin letters mixed with Cyrillic or Greek ones, are refused (**422**), as is a list naming an action the base cannot perform. |
| `PATCH` | `/orgs/{orgSlug}/roles/{roleId}` | Any of the fields above. Refused if anybody holding the role is beyond your authority, or holds access grants beyond yours that the change would switch on. A change that changes nothing writes nothing. |
| `DELETE` | `/orgs/{orgSlug}/roles/{roleId}` | Only a role nobody holds — otherwise **409**: move its members to another role, or to none, first. Never plan-gated. |

## Single sign-on

SAML and OIDC single sign-on through WorkOS, set up by your IT admin in WorkOS's
setup portal. From a browser session only (a CLI token is refused). Owners and
admins can read the status and switch a policy off; only **owners** can turn SSO
on, open the setup portal, or switch a policy on — whoever does those decides
which identity provider vouches for every member. Turning anything **on** also
needs the single sign-on add-on. Every route answers with the same `sso` status:
whether SSO is on, `ssoRequired`, `jitJoinEnabled`, the seat limit, whether the
add-on is held, and — once on — the connections and domains WorkOS reports
(`null`, with `providerReachable: false`, if WorkOS cannot be reached) and
`membersOutsideVerifiedDomains`, how many members your identity provider cannot
sign in.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/orgs/{orgSlug}/sso` | The status. |
| `POST` | `/orgs/{orgSlug}/sso` | Owners. Turns SSO on: creates the organisation's account at WorkOS, with no domains — domains are added and verified in the setup portal. **201** the first time; **200** and nothing created once on. |
| `POST` | `/orgs/{orgSlug}/sso/portal` | Owners, within ten minutes of signing in again (**403** `reauth_required` otherwise) — by password, passkey, Google, single sign-on or an emailed code. `{ link }` — a WorkOS setup-portal link, valid for a few minutes, that returns to the organisation's settings. **409** before SSO is on. Every link is audited. |
| `PATCH` | `/orgs/{orgSlug}/sso` | Body `{ ssoRequired?: boolean, jitJoinEnabled?: boolean }`. Switching either on is for owners; switching off, for owners and admins. Requiring SSO needs an active connection and a verified domain (**409** otherwise), and takes effect **immediately**: from then on, members who did not sign in through your identity provider — and CLI devices approved from such a sign-in — get **403** `sso_required` for this organisation, and keep every other. The response's `nonSsoAccess` says how many sessions and CLI tokens that affected. Members who get `sso_required` sign in again through the organisation's single sign-on (the dashboard offers the link; the CLI says to run `xecret login` through it). Owners are always exempt, so a misconfigured identity provider cannot lock the organisation out; every time an owner signs in, approves a CLI device or accepts an invitation that way, the audit log says so. `jitJoinEnabled` lets anybody your identity provider signs in, at a verified domain, join as a viewer while seats last — never somebody you removed; off, they need an invitation. |

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
