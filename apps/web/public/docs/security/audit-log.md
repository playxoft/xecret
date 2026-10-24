---
title: The audit log
navTitle: Audit log
description: Every event xecret records, what each one means, how to filter the log, and how to use it during an incident when a credential has leaked.
keywords: [secret audit log, who read secret, security audit trail, incident response, compliance logging]
updated: 2026-10-20
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
| `auth.login` | Somebody signed in. When the sign-in was held back for them to confirm first, `confirmation` says why: `organization` (it came back through an organisation the sign-in did not ask for), `not-member` (through the single sign-on of an organisation the account was not yet in) or `reused-session` (answered from an earlier sign-in at WorkOS, for an account other than the last one on that browser) |
| `auth.signup` | A sign-in created a new account — recorded instead of `auth.login` for that one sign-in, so "when did this person join" is a filter. Carries `confirmation` the same way |
| `auth.sign_in_declined` | A sign-in held back for confirmation was declined — "This isn't me" — and nothing was signed in. `confirmation` says why it was held back, `signInMethod` how the person was signed in. Recorded in the organisation whose single sign-on it came through when that organisation is on xecret, otherwise in the account's own. One is somebody choosing the wrong account; a run of them for one account is somebody trying to sign people in to theirs |
| `auth.identity_linked` | A sign-in adopted an existing account by its verified email address and linked the sign-in identity to it — the one sign-in that changes which identity an account answers to. Written at the moment the link is made, even if that sign-in is then refused (single sign-on required, or no seat free); a linked sign-in that completes records `auth.login` as well |
| `auth.sso_exemption_used` | An owner signed in without the organisation's required single sign-on, through the owner exemption — see *Single sign-on* below |
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

A pull that reads beyond its own environment — values it [inherits, or a
template refers to](../features/references.md) — writes a `secret.read` against
**each** environment it read, naming the environment being pulled as context and,
for a referenced secret, the secret that referred to it. Production's own log
therefore shows a read of production that a template in staging caused.

### Organisations, projects, environments

`org.created` · `org.updated` · `org.deleted` · `project.created` ·
`project.updated` · `project.deleted` · `environment.created` ·
`environment.updated` · `environment.deleted`

| Action | Recorded when |
|---|---|
| `environment.parent_changed` | An environment started or stopped inheriting from another, naming both parents |
| `environment.link_crosses_protection` | A person confirmed a [production environment reading from one that is not](../features/references.md#production-reading-from-elsewhere) — by inheriting from it (reason `inherited`) or through a template (reason `referenced`, naming the secret). Filed against production, naming the source; the inheritance change or the secret write is recorded beside it |
| `environment.promoted` | A [promotion](../features/promotion-and-restore.md#promotion) landed, with counts and the source; each secret it wrote has its own `secret.created`, `secret.updated` or `secret.deleted`, with reason `promoted` |
| `environment.restored` | A [point-in-time restore](../features/promotion-and-restore.md#point-in-time-restore) landed, with the instant and counts, and per-secret records with reason `restored`. Its preview is a `secret.read` with reason `restore-preview` |
| `environment.policy_changed` | An environment's plaintext-export or read-alert switch changed |
| `org.policy_changed` | The token policy or the secret policy changed |
| `override.set` `override.removed` | A member set or removed one of their own [personal overrides](../features/overrides.md) — the name, never the value |
| `webhook.created` `webhook.updated` `webhook.deleted` `webhook.secret_rotated` | A [webhook](../features/webhooks.md) endpoint changed, with its host and events — never its full URL, whose path may hold a credential |
| `webhook.disabled` | An endpoint was switched off by the system after sustained failure |

A refusal by one of your own policies is an `error` with reason `policyRefused`
and the policy's name; a refusal by the plan is `quotaExceeded` with the feature
or limit that refused it.

### Single sign-on

| Action | Recorded when |
|---|---|
| `org.sso.enabled` | Single sign-on was turned on by an owner: the organisation's account at WorkOS was created and linked. Once only — of two owners enabling it at the same moment, only the one whose request linked it is recorded |
| `org.sso.portal_link_created` | An owner who had just signed in again was handed a link to the WorkOS setup portal, where the identity provider is connected and domains verified. Every time — whoever opens one decides who can sign in as the organisation's members. The link itself is never recorded |
| `org.sso.required_toggled` | "Require single sign-on" was switched on (by an owner) or off. `enabled` is the new value. It applies to every request from then on; owners are always exempt from it |
| `org.sso.jit_toggled` | "Let people join through single sign-on" was switched on (by an owner) or off. `enabled` is the new value. Off, nobody joins by single sign-on alone, and no `member.jit_*` row is written |
| `auth.sso_exemption_used` | An owner got past this organisation's required single sign-on some other way — a password, Google, another organisation's SSO — through the owner exemption, the break-glass that keeps a broken identity provider from locking the organisation out. Recorded when a credential is made that way: at sign-in, in **every** organisation whose requirement it bypassed; when such an owner approves a CLI device (it reaches the organisation the same way for as long as it lives); and when an owner's invitation is accepted that way. With `signInMethod` |

A refused attempt at any of these is recorded too: `denied` for somebody without
the role (an admin, for anything that switches something on), `error` for a
missing add-on, a precondition (no active connection or verified domain, SSO not
on yet, a link made in another WorkOS environment, a deployment whose WorkOS
environment the database does not belong to, no recent sign-in before the setup
portal) or WorkOS being unreachable.

### People and access

| Action | Recorded when |
|---|---|
| `member.invited` | An invitation was sent |
| `member.joined` | It was accepted |
| `member.jit_joined` | Somebody signing in through an organisation's single sign-on was made a member on the spot, as a `viewer`. Nobody invited them: the organisation's identity provider vouched for an address in a domain the organisation verified, and the organisation had opted in to admitting people that way (`org.sso.jit_toggled`). Written only once the person confirmed the sign-in, which a first join by single sign-on always asks them to; any invitation still open for their address is withdrawn. Carries `signInMethod: sso` |
| `member.jit_denied` | The same, refused. Outcome `error`, with a reason: `quotaExceeded` (`limitName` `seats`) when the organisation had no seat free — the sign-in fails — or `removed` for somebody the organisation removed and has not invited back, whose identity provider still vouched for them — they are signed in to whatever else they belong to, not back in here. Either way, the record of who was turned away |
| `invitation.revoked` | It was withdrawn before acceptance |
| `member.role_changed` | Somebody's role changed |
| `member.suspended` `member.reinstated` | A membership was switched off, or back on |
| `member.removed` | Somebody was removed. Their organisation's single sign-on does not bring them back, and any invitation still open for them is withdrawn with the removal; a new invitation does |
| `member.custom_role_changed` | Somebody was put on a custom role, moved between two, or had theirs taken off — naming the role before and after |
| `role.created` `role.updated` `role.deleted` | A custom role was defined, edited or deleted, with its whole definition — and, for an edit, the one it replaced and how many members held it. A `role.updated` **error** naming a member is an edit that was saved but whose follow-up for that holder — bringing their environment keys in line — did not finish; the environment's key page shows what they are still owed |
| `access.granted` `access.revoked` | A grant was created or removed, with the previous and new levels |

Suspension and removal are separate events because the histories imply
different things. During a review, "could this person still act during the
window?" has a different answer for each — a suspended member resolves to
`none` everywhere while keeping their grants.

### Plans and billing

Written by the system for what the payment provider, the seat sync and the billing jobs did,
and by an owner for what they asked for. The actor of a system row says which: `Dodo webhook`,
`seat sync`, `billing job` or `billing reconciler`. No row carries an amount, a card detail,
or any identifier of the payment provider's — only plans, statuses, counts and the name of the
event that caused it.

| Action | Recorded when |
|---|---|
| `plan.changed` | What the organisation may do changed: a subscription started, changed plan or period, changed status, gained or lost seats, was cancelled for the period end, or ended. With the plan, interval, status and seats before and after, and the provider event (`billingEvent`) or the job's `reason` — a cancellation that reached its period end, or a subscription fourteen days on hold without a payment. An operator's change by hand carries `operator` |
| `billing.checkout_started` | An owner was sent to checkout, for the plan, period and seat count recorded. Nothing is bought until the payment provider says so |
| `billing.plan_change_requested` | An owner asked for a plan or period change — `takes effect now` or `takes effect at renewal` |
| `billing.portal_opened` | An owner was handed a link to the payment provider's customer portal. The link itself is never recorded |
| `billing.seats_synced` | The seat count billed followed the membership — or, as an `error`, could not reach the payment provider and is being retried |
| `billing.payment_failed` | A payment was declined |
| `billing.refunded` `billing.dispute_opened` | Money moved back, or a chargeback was opened. Access is unchanged by either |
| `billing.usage_reported` | Metered secret fetches past the allowance were reported, with `unitCount` (a unit is a thousand fetches) |
| `billing.region_mismatch` | The payment provider reported a billing country or currency other than the one the organisation is priced in, or a card from another country. Outcome `error`; nothing changed |
| `billing.duplicate_subscription` | A subscription or a checkout payment was not applied: a second one beside the one the organisation has (or is still waiting to activate), one bought over a plan set by hand, or one that did not come from a checkout of this organisation's. Outcome `error` |
| `billing.drift_detected` | The nightly comparison found our record and the payment provider's disagreeing — `driftFields` names what (`seats` includes the membership no longer matching what is billed). Nothing is corrected automatically |

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
