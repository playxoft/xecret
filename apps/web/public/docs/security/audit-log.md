---
title: The audit log
navTitle: Audit log
description: Every event xecret records, what each one means, how to filter the log, and how to use it during an incident when a credential has leaked.
keywords: [secret audit log, who read secret, security audit trail, incident response, compliance logging]
updated: 2026-10-12
---

Every mutation, every decryption, and **every denial** is recorded. A system
that records only what succeeded cannot detect an attack in progress.

Owners and admins can read the log. It is append-only, enforced by database
grants rather than by convention — the application's own credentials cannot
alter it.

## What a record contains

| Field | Meaning |
|---|---|
| **Actor** | A person, a CLI token, a service token, or the system |
| **Action** | What was attempted — see the table below |
| **Outcome** | `success`, `denied`, or `error` |
| **Resource** | The organisation, project, environment or secret involved |
| **When** | Timestamp |
| **Reason** | Extra context — a version number, a previous value of a setting |

There is no field that could hold a secret value. The type describing the
metadata is a fixed allowlist of field names with no catch-all, so a value
cannot be placed in a record: the compiler rejects it rather than a reviewer
having to spot it.

### Attribution is precise

A write made by CI is recorded as the act of **that service token**, by name —
never as the act of whoever minted it. Two separate columns hold the two kinds
of actor, with a database constraint requiring exactly one of them to be set.

This matters in the one log a company reaches for during an incident: putting a
person's name on a write they did not make is worse than useless.

## The events

### Authentication

| Action | Recorded when |
|---|---|
| `auth.login` | Somebody signed in |
| `auth.signup` | A sign-in created a new account — recorded instead of `auth.login` for that one sign-in, so "when did this person join" is a filter |
| `auth.identity_linked` | A sign-in adopted an existing account by its verified email address and linked the sign-in identity to it — the one sign-in that changes which identity an account answers to. Written at the moment the link is made, even if that sign-in is then refused (single sign-on required, or no seat free); a linked sign-in that completes records `auth.login` as well |
| `auth.login_failed` | A sign-in was rejected |
| `auth.logout` | Somebody signed out |
| `auth.session_revoked` | A session was revoked |
| `auth.locked` | A session was PIN-locked without being signed out |
| `auth.pin_set` `auth.pin_changed` | The unlock PIN was created or replaced |
| `auth.pin_reset` | The PIN was reset through an emailed link — somebody proved control of the mailbox rather than knowledge of the PIN |
| `auth.autolock_changed` | The idle auto-lock interval changed |
| `auth.account_deleted` | An account deleted itself. Terminal. |
| `auth.reauthenticated` | The account proved itself again for a vault reset — signed in again, then entered the emailed code (and its authenticator code, if one is enrolled) — and was given the five-minute proof the reset spends. A reset that follows it was not a stolen session alone |

### Vault reset and recovery

| Action | Recorded when |
|---|---|
| `vault.archive_emailed` | Before a reset, the encrypted archive of the vault was emailed to the account's address — with how many parts, environments and secrets, never which. Recorded as an error when no archive could be sent (no email set up, or the vault was too large) |
| `vault.reset` | A vault was reset. The old one is kept for seven days, recoverable and undeletable |
| `vault.recovered` | A reset vault's environment keys were brought back into the account's current vault, with its old passphrase or a recovery code. Recorded in each organisation that got keys back, with how many |
| `vault.purged` | A reset vault's seven days ended and it was deleted. Recorded by the system, not a person |

See [Resetting your vault](/docs/security/vault-archive) for what each of these means.

The sign-in events — `auth.login`, `auth.signup` and `auth.identity_linked` —
carry `signInMethod`: how the person authenticated, as one of a closed set:
`password`, `oauth`, `sso`, `magic_auth` (a code sent by email), `passkey`, or
`other` for a method the identity provider named that this list does not know.
It is coarser than the provider's own vocabulary on purpose: a review asks
whether this was a password, a Google account or the company's single sign-on,
not which of many OAuth providers.

### Secrets

| Action | Recorded when |
|---|---|
| `secret.created` | A new name appeared |
| `secret.updated` | A new version was appended |
| `secret.deleted` | A secret was soft-deleted |
| `secret.rotated` | A value was rotated |
| `secret.imported` | A bulk import ran |
| `secret.read` | A **bulk** read — one row per `xecret run` or `pull`, with a count |
| `secret.revealed` | A **single** value was decrypted and returned |

`secret.read` and `secret.revealed` are the two rows that mean a plaintext left
the server, and the distinction is deliberate. A 200-secret pull writes **one**
`secret.read` row with a count, not 200 rows — otherwise the audit table
becomes a denial-of-service surface against itself.

`secret.revealed` is the one to watch. It means a person or token asked for one
specific value, which is what curiosity and exfiltration both look like.

### Organisations, projects, environments

`org.created` · `org.updated` · `org.deleted` · `project.created` ·
`project.updated` · `project.deleted` · `environment.created` ·
`environment.updated` · `environment.deleted`

### Single sign-on

| Action | Recorded when |
|---|---|
| `org.sso.enabled` | Single sign-on was turned on: the organisation's account at WorkOS was created and linked. Once only |
| `org.sso.portal_link_created` | An owner or admin was handed a link to the WorkOS setup portal, where the identity provider is connected and domains verified. Every time — whoever opens one decides who can sign in as the organisation's members. The link itself is never recorded |
| `org.sso.required_toggled` | "Require single sign-on" was switched on or off. `enabled` is the new value. Owners are always exempt from it |
| `org.sso.jit_toggled` | "Let people join through single sign-on" was switched on or off. `enabled` is the new value. Off, nobody joins by single sign-on alone, and no `member.jit_*` row is written |

A refused attempt at any of these is recorded too: `denied` for somebody without
the role, `error` for a missing add-on, a precondition (no active connection, SSO
not on yet) or WorkOS being unreachable.

### People and access

| Action | Recorded when |
|---|---|
| `member.invited` | An invitation was sent |
| `member.joined` | It was accepted |
| `member.jit_joined` | Somebody signing in through an organisation's single sign-on was made a member on the spot, as a `viewer`. Nobody invited them: the organisation's identity provider vouched for an address in a domain the organisation verified, and the organisation had opted in to admitting people that way (`org.sso.jit_toggled`). Carries `signInMethod: sso` |
| `member.jit_denied` | The same, refused because the organisation had no seat free. Outcome `error`, reason `quotaExceeded`, `limitName` `seats`. The sign-in fails; this is the record of who was turned away |
| `invitation.revoked` | It was withdrawn before acceptance |
| `member.role_changed` | Somebody's role changed |
| `member.suspended` `member.reinstated` | A membership was switched off, or back on |
| `member.removed` | Somebody was removed |
| `member.custom_role_changed` | Somebody was put on a custom role, moved between two, or had theirs taken off — naming the role before and after |
| `role.created` `role.updated` `role.deleted` | A custom role was defined, edited or deleted, with its whole definition — and, for an edit, the one it replaced and how many members held it. A `role.updated` **error** naming a member is an edit that was saved but whose follow-up for that holder — bringing their environment keys in line — did not finish; the environment's key page shows what they are still owed |
| `access.granted` `access.revoked` | A grant was created or removed, with the previous and new levels |

Suspension and removal are separate events because the histories imply
different things. During a review, "could this person still act during the
window?" has a different answer for each — a suspended member resolves to
`none` everywhere while keeping their grants.

### Credentials

| Action | Recorded when |
|---|---|
| `token.authorized` | A CLI login was approved on the consent screen |
| `token.created` | A token was minted |
| `token.used` | A token authenticated a request |
| `token.revoked` | A token was revoked — written by the call that actually did it, so a repeat revoke adds no noise |
| `key.rotated` | An encryption key was rotated |

### Denials

| Action | Recorded when |
|---|---|
| `access.denied` | Any attempt that was refused |

Plus: any of the actions above can carry `outcome: denied`. Filtering on
outcome rather than on this single action is usually what you want.

## Reading it

*Audit* in the dashboard, or `GET /api/orgs/{orgSlug}/audit`.

Filters: actor, action, project (and environment within it), outcome, and a
date range. Results are paginated with an opaque cursor.

The range is clamped to **90 days**, and the response states the window it
actually scanned — a view showing less than it was asked for must say so rather
than quietly returning a shorter answer.

```bash
curl "https://xecret.playxoft.com/api/orgs/acme/audit?action=secret.revealed&from=2026-08-01" \
  -H "Authorization: Bearer $XCT_TOKEN"
```

## Using it during an incident

A laptop is stolen, or a CI token leaks. The sequence:

1. **Revoke first.** The device under *Tokens → Your devices*, or the service
   token under *Tokens → Service tokens*. Revocation is immediate, and is
   never softened by the CLI's offline cache — a rejection is a decision, and
   decisions are not overridden by a local file.

2. **Find what it did.** Filter the log by that actor. `secret.read` rows tell
   you which environments were pulled and when; `secret.revealed` rows name
   individual secrets.

3. **Rotate what it touched**, at the source. Change the database password at
   the database, the API key at the provider, then write the new value into
   xecret. Revoking the token does not un-leak a value it already read — this
   is the step people skip.

4. **Check for denials.** A run of `outcome: denied` around the same time is
   somebody probing for what else the credential could reach.

5. **Write down what you found.** Filter by date range and export before the
   90-day window moves.

## What to review routinely

Worth a look once a month, or after anyone leaves:

- `access.granted` on production environments — is each still needed?
- `token.created` — is every standing service token still in use?
- `secret.revealed` — is anybody reading production values by hand who should
  be using `xecret run`?
- `member.role_changed` — did every promotion have a reason?
- `role.updated` and `member.custom_role_changed` — did a custom role widen, or
  come off somebody, and was that meant?

## Next

- [Trust model](trust-model.md) — what the log is protecting.
- [Tokens](../api/tokens.md) — revocation and rotation.
- [Teams and access](../guides/teams.md) — the grants these events describe.
