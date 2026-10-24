/**
 * Audit event types.
 *
 * The builder lands in Phase 8. The critical design rule is recorded here now:
 * `metadata` accepts an **allowlist of field names only**. Redaction is enforced
 * by the builder's type signature, not by asking developers to remember
 * (Rule 4/5, threat model §1).
 *
 * See docs/architecture/database-schema.md §8.
 */

import type { AccessLevel, Action } from '../authz/types';

export type ActorType = 'user' | 'cli_token' | 'service_token' | 'system';

export type AuditOutcome = 'success' | 'denied' | 'error';

/** Every auditable action. Dot-namespaced to match `Action` where they overlap. */
export type AuditAction =
  | 'auth.login'
  /**
   * A sign-in created the account: nobody held this identity or this address
   * before. Recorded instead of `auth.login` for that one sign-in, so "when did
   * this person join" is a filter rather than a search for their earliest login.
   */
  | 'auth.signup'
  /**
   * A sign-in adopted an existing account by its verified email address and
   * linked the provider identity to it — the step that carries an account across
   * the identity-provider swap. Recorded instead of `auth.login`, and loudly,
   * because it is the one sign-in that changes which identity an account
   * answers to: "who could sign in as this account, and since when" is answered
   * by finding it.
   */
  | 'auth.identity_linked'
  /**
   * An owner of an organisation that requires single sign-on signed in some
   * other way — a password, Google, another organisation's SSO — and was let
   * through by the owner exemption, the deliberate break-glass that keeps a
   * misconfigured identity provider from locking the organisation out of
   * itself. Filed in **each** organisation whose requirement the sign-in was
   * exempted from (the `auth.login` beside it lands in only one), with the
   * method as `signInMethod`, so every such organisation's own log shows each
   * time its identity provider was bypassed.
   */
  | 'auth.sso_exemption_used'
  /**
   * A sign-in the callback held back for the person to confirm — it came back
   * through an organisation the flow did not ask for, or one the account does
   * not belong to, or from a session WorkOS reused without asking — was
   * declined on the confirmation page: "This isn't me". Nothing was issued.
   * `confirmation` says why it was held back, and `signInMethod` how WorkOS
   * signed the person in. Filed in the organisation whose single sign-on it
   * came through when that organisation is here, otherwise in the account's
   * own — a run of these for one account is somebody being worked on. (A sign-in
   * that was confirmed is the ordinary `auth.login` or `auth.signup`, carrying
   * `confirmation` too.)
   */
  | 'auth.sign_in_declined'
  | 'auth.logout'
  | 'auth.login_failed'
  | 'auth.session_revoked'
  /**
   * The session's owner proved themselves twice over for the vault reset — a
   * forced fresh sign-in, then a code emailed to them — and was handed the
   * five-minute proof the reset spends. Its own event because a reset that
   * follows it is the most destructive act in the product, and the record of
   * the proof is what shows the reset was not a stolen cookie alone.
   */
  | 'auth.reauthenticated'
  /**
   * The user vault was created: the moment an account acquires the key
   * hierarchy that every secret it can read is encrypted under.
   *
   * Terminal in one direction — a vault is created once, and re-creating it
   * would abandon everything sealed to the old public key — so this record is
   * the origin of the account's whole cryptographic history.
   */
  | 'vault.created'
  /**
   * A session was unlocked, or an unlock attempt was refused.
   *
   * The retired PIN deliberately did not audit *successful* unlocks, on the
   * reasoning that they happen twice a day and say nothing the surrounding
   * events do not. The vault reverses that call, because what an unlock now
   * marks is the moment key material became reachable on a device. "The vault
   * was opened at 03:00 from an address this account has never used" is a
   * sentence a zero-knowledge product has to be able to say, and no other event
   * says it.
   */
  | 'vault.unlocked'
  | 'vault.unlock_failed'
  /**
   * The master passphrase was changed: the User Key was re-wrapped under a new
   * passphrase-derived key and the unlock verifier replaced.
   *
   * Notably *not* a re-encryption of anything else. The User Key itself is
   * unchanged, so sessions on other devices stay valid and recovery codes keep
   * working — which is why this is worth dating separately from `vault.created`.
   */
  | 'vault.passphrase_changed'
  /**
   * A recovery code was redeemed — somebody got back into a vault without the
   * passphrase.
   *
   * The single most important line in this list for an incident review. It is
   * the only path that opens a vault with something other than the passphrase
   * or an enrolled passkey, it is single-use, and it forces a new passphrase and
   * a fresh set of codes in the same act.
   */
  | 'vault.recovery_used'
  /** The recovery-code set was replaced, invalidating every previous code. */
  | 'vault.recovery_codes_regenerated'
  /**
   * The vault was reset: the account was sent back to the setup ceremony, and
   * its old vault moved into a seven-day retained state (P23).
   *
   * The end of the road for somebody who has lost both their passphrase and
   * every recovery code: there is no key left that opens their old data, and
   * nothing — no support ticket, no operator — can produce one. Until the
   * retained vault is purged, the old passphrase or a recovery code can still
   * bring its environments back (`vault.recovered`); after that, this event is
   * the record that the data still sitting in the database became unreadable to
   * this account at a particular moment.
   */
  | 'vault.reset'
  /**
   * The escape archive — every ciphertext the old vault could open, still
   * sealed — was emailed to the account's address, just before a reset.
   *
   * Its own event, beside `vault.reset`, because it is the one act that puts an
   * offline-attackable copy of an account's vault somewhere this product can
   * never reach again: a mailbox. `partCount`, `environmentCount` and
   * `secretCount` say how much; nothing in the record says what.
   */
  | 'vault.archive_emailed'
  /**
   * A retained vault's environment keys were brought back into the account's
   * current vault, by somebody who proved they hold its User Key — the old
   * passphrase or one of its recovery codes opened it in their browser.
   *
   * Filed in every organisation whose environments were restored, so the
   * teammates who were asked to re-share after the reset can see why the request
   * went away. `grantCount` is how many keys came back there.
   */
  | 'vault.recovered'
  /**
   * A retained vault reached the end of its seven-day window and was deleted by
   * the scheduled purge — the moment the old passphrase and recovery codes stop
   * opening anything this server holds. Recorded with a `system` actor.
   */
  | 'vault.purged'
  /**
   * A **bearer credential** read the account's vault material: the passphrase
   * wrap, the KDF salt and the Argon2 parameters.
   *
   * Not recorded for a browser session, and the asymmetry is the whole point. A
   * session reading its own material is the lock screen doing its job, several
   * times a day, and auditing it would bury this event under page views. A
   * long-lived `xct_…` token reading it is a different fact: that material is
   * offline-grindable, so the read hands whoever holds the token everything they
   * need to attack the passphrase at their leisure — and it discloses the Argon2
   * cost, which tells them how expensive that attack will be.
   *
   * The read is legitimate — it is what makes headless `xecret login
   * --passphrase` possible at all, since a CLI token cannot open a single grant
   * without the user's wrapped private key — and it is not removable without
   * removing the flow. So it is made *visible* instead: `principalKind` names the
   * credential, and "a token in a CI runner pulled my wraps at 04:00" becomes a
   * question somebody can ask. ADR 0009 records it under residual risks.
   */
  | 'vault.material_read'
  /**
   * A browser enrolled a six-digit device PIN, or re-enrolled under a new one.
   *
   * The one event that records an account choosing a *weaker* credential for
   * daily use, and that is exactly why it is here. The PIN is opt-in, the
   * passphrase stays the root, and the honest trade-off — a server colluding
   * with whoever holds the device can enumerate six digits — is stated in the
   * settings screen. An enrolment nobody remembers making is the shape of that
   * trade being taken by somebody else, and no other event marks it.
   */
  | 'vault.pin_enrolled'
  /**
   * A device PIN was turned off: on this browser, on another one, or on all of
   * them at once. `reason` says which, and which browser.
   *
   * Deliberately distinct from {@link 'vault.pin_burned'}. Both end an enrolment
   * and they answer opposite questions in a review: this one was somebody
   * deciding, the other was somebody failing.
   */
  | 'vault.pin_disabled'
  /**
   * A device PIN was destroyed by wrong guesses — the fifth failure in a row.
   *
   * The security event of the whole feature. A PIN's entire budget is five
   * attempts, so this record is the moment that budget was spent, and a burst of
   * them across an account is the shape of somebody working through a stolen
   * laptop. Afterwards that wrap opens for nobody who never saw its pepper.
   */
  | 'vault.pin_burned'
  /** A session was locked without being revoked — the user is still signed in. */
  | 'auth.locked'
  /** The idle auto-lock interval was changed. `reason` carries the new value. */
  | 'auth.autolock_changed'
  /**
   * The account changed its own display name.
   *
   * Worth a record for one reason: this name is what a teammate reading a member
   * list sees, so changing it changes how every other member of every shared
   * organisation identifies this person. `reason` carries the new name — never
   * the old one, which would put a name somebody has deliberately stopped using
   * into a log that cannot be edited. The actor is identified by email
   * throughout the log regardless, so nothing here depends on the name being
   * stable.
   */
  | 'auth.profile_updated'
  /**
   * The account deleted itself: memberships removed, solo organisations
   * soft-deleted, every session and CLI token revoked, the user row
   * soft-deleted. Terminal — the same identity can never sign in to it again.
   * Recorded against the account's primary organisation, whose soft-deleted
   * row keeps the record reachable.
   */
  | 'auth.account_deleted'
  | 'org.created'
  | 'org.updated'
  /**
   * An organisation was soft-deleted, taking every project, environment and
   * secret inside it out of reach in one act.
   *
   * The row it points at survives the deletion — that is what a soft delete is
   * for here — so this record, and every record filed against the organisation
   * before it, stays readable by an operator afterwards. Nobody in the product
   * can read them: the audit route resolves through `organizations` with a
   * `deleted_at is null` filter, so the organisation stops answering the moment
   * this event is written.
   */
  | 'org.deleted'
  /**
   * The organisation turned single sign-on on: xecret created the WorkOS
   * Organization its identity-provider connections will hang off, and linked
   * it. Once only — the link is never re-pointed — so this is the origin of the
   * organisation's SSO history. Nothing about who may sign in changes yet: a
   * connection still has to be set up, and both policies below start off.
   */
  | 'org.sso.enabled'
  /**
   * Somebody was handed a WorkOS Admin Portal link for this organisation's
   * SSO: a short-lived URL that lets whoever opens it connect or change the
   * organisation's identity provider. Recorded every time, because the person
   * who configures the identity provider decides who can sign in as this
   * organisation's members. The link itself is never recorded.
   */
  | 'org.sso.portal_link_created'
  /**
   * `sso_required` was switched on or off — whether members must sign in
   * through the organisation's own identity provider (owners always exempt).
   * `enabled` carries the new value.
   */
  | 'org.sso.required_toggled'
  /**
   * The just-in-time opt-in was switched on or off — whether somebody the
   * organisation's identity provider signs in may join as a viewer without an
   * invitation. `enabled` carries the new value. The admission it governs is
   * `member.jit_joined`.
   */
  | 'org.sso.jit_toggled'
  | 'project.created'
  | 'project.updated'
  | 'project.deleted'
  | 'environment.created'
  | 'environment.updated'
  | 'environment.deleted'
  /**
   * An environment's parent was set, changed or cleared (P19 §1): what its
   * view inherits from now differs. `parentEnvironmentSlug` names the new
   * parent — `null` when it was cleared — and `previousParentEnvironmentSlug`
   * the old one. Its own event rather than an `environment.updated`, because
   * this one changes which values every reader of the environment receives, and
   * a reviewer asking "since when did staging read base's secrets?" should not
   * have to read every rename to find out.
   */
  | 'environment.parent_changed'
  /**
   * A production environment was linked to one that is not production — made
   * to inherit from it, or given a template that reads from it — and the person
   * confirmed it (P19 §1, review round 1). Filed beside the parent change or the
   * secret write that made the link, against the production environment, with
   * `sourceProjectSlug` / `sourceEnvironmentSlug` naming the other one and
   * `reason` saying `inherited` or `referenced`.
   *
   * Its own event because such a link is a write path onto production for
   * everybody who can write the source, and "since when could staging's writers
   * change what production reads?" should be one filter, not a reading of every
   * parent change and template write for the classes of both ends.
   */
  | 'environment.link_crosses_protection'
  /**
   * Values were promoted from one environment into another (P19 §3), as one
   * atomic write. `sourceEnvironmentSlug` names where they came from;
   * `createdCount`, `updatedCount` and `deletedCount` say how much moved. Every
   * secret written also carries its own version row — the history of each value
   * is unchanged by having arrived in a batch.
   */
  | 'environment.promoted'
  /**
   * An environment was restored to how it stood at a moment (P19 §4).
   * `restoredTo` is that moment; the counts say how many secrets were rewritten,
   * recreated and deleted. Restore writes forward — every rewritten value is a
   * new version — so this record and the version rows together are the whole
   * story, and the restore itself can be undone by restoring again.
   */
  | 'environment.restored'
  /**
   * An environment's own policy changed: plaintext export allowed or refused
   * (P19 §9), new-location read alerts switched on, off, or back to the default
   * (P19 §7). `policyName` says which, `enabled` its new state.
   */
  | 'environment.policy_changed'
  /**
   * An organisation-wide policy changed: the token policy (P19 §6) or the secret
   * naming and strength policy (P19 §8). `policyName` says which. Recorded
   * whether it was tightened or loosened — loosening a control is the change a
   * security review most wants to be able to find.
   */
  | 'org.policy_changed'
  /**
   * Somebody set or replaced a personal override (P19 §2). The record names
   * whose and for which secret — never the value, which this server cannot read
   * — because "this developer's machine is running with a different
   * DATABASE_URL" is a fact an administrator is entitled to.
   */
  | 'override.set'
  | 'override.removed'
  /**
   * A webhook endpoint was configured (P19 §5). `endpointHost` is the host it
   * delivers to — never the full URL, because a webhook URL routinely carries a
   * credential in its path or query (a chat integration's incoming-webhook URL
   * *is* its secret).
   */
  | 'webhook.created'
  | 'webhook.updated'
  | 'webhook.deleted'
  /**
   * A webhook's signing secret was replaced. The secret is never recorded; the
   * event is what tells a receiver's operator when theirs stopped verifying.
   */
  | 'webhook.secret_rotated'
  /**
   * A webhook was switched off by the system after sustained delivery failure,
   * with a `system` actor. The owners and admins are emailed when a mailer
   * exists; this record is the fact either way.
   */
  | 'webhook.disabled'
  | 'secret.created'
  | 'secret.updated'
  | 'secret.deleted'
  | 'secret.rotated'
  | 'secret.read'
  | 'secret.revealed'
  | 'secret.imported'
  | 'member.invited'
  | 'member.joined'
  /**
   * Somebody signing in through an organisation's single sign-on was made a
   * member of it on the spot (just-in-time provisioning), at the default role.
   * Distinct from `member.joined`, which records an invitation accepted: here
   * nobody invited them, and what admitted them was the organisation's identity
   * provider vouching for an address in a domain the organisation verified —
   * and an owner or admin having opted the organisation in to admitting people
   * that way (`org.sso.jit_toggled`).
   */
  | 'member.jit_joined'
  /**
   * The same, refused, for one of two reasons, carried as `reason`:
   *
   *  - `quotaExceeded` (`limitName: seats`) — the organisation had no seat
   *    free. The sign-in fails and the person is told to ask an administrator.
   *  - `removed` — they were removed from this organisation and have not been
   *    invited back. Their identity provider still vouching for them does not
   *    undo a removal; the sign-in carries on to whatever else they belong to.
   *
   * Either way this is the record that lets an administrator see who was
   * turned away.
   */
  | 'member.jit_denied'
  | 'member.removed'
  | 'member.role_changed'
  /**
   * A membership was switched off without being deleted, or switched back on.
   *
   * Distinct from `member.removed` because the histories differ in what they
   * imply: a suspension is reversible and keeps the member's grants intact,
   * which is exactly what an incident review needs to know when asking "could
   * this person still act during the window?" (they could not — a suspended
   * member resolves to `none` everywhere).
   */
  | 'member.suspended'
  | 'member.reinstated'
  /**
   * A member was given a custom role, moved from one to another, or had theirs
   * taken off.
   *
   * Its own event rather than a `member.role_changed`, because the built-in
   * role did not change and a reviewer filtering on that event is asking "who
   * became an admin?", not "who became a Deployer?". `customRoleId` and
   * `customRoleName` name the role the member holds afterwards — absent when
   * the change removed it — and `previousCustomRoleId` and
   * `previousCustomRoleName` the one they held before, absent when they held
   * none. Removing one is the change worth finding later: it returns the
   * member to the whole of their built-in role.
   */
  | 'member.custom_role_changed'
  /**
   * An organisation defined a custom role.
   *
   * The definition is recorded whole — base, action list, ceiling — because it
   * is what the event *is*: every later `member.custom_role_changed` naming
   * this role means "narrowed to exactly this", and the role row itself can be
   * edited afterwards.
   */
  | 'role.created'
  /**
   * A custom role's definition changed: its name, its base, its action list or
   * its ceiling.
   *
   * Carries the definition before and after, not a description of the
   * difference — a reviewer asking "when did Deployers gain production?" reads
   * `previousAccessCeiling` against `accessCeiling`, and a summary somebody
   * computed at write time could only ever answer the questions its author
   * thought of. `holderCount` says how many members the edit reached.
   */
  | 'role.updated'
  /**
   * A custom role was deleted. Only ever one nobody held — the foreign key
   * refuses the rest — so this changed nobody's access, and says so by
   * carrying no `holderCount`.
   */
  | 'role.deleted'
  /**
   * A pending invitation was withdrawn before anyone accepted it.
   *
   * `member.invited` records the offer and `member.joined` records the
   * acceptance; this records the third ending. An invitation that is neither
   * accepted nor revoked merely expires, which no event marks — expiry is the
   * absence of action, and inventing an actor for it would put a name on
   * something nobody did.
   */
  | 'invitation.revoked'
  | 'access.granted'
  | 'access.revoked'
  /**
   * A person approved CLI access for a named device on the consent screen.
   *
   * Distinct from `token.created`, which is recorded when the credential is
   * actually minted at exchange. The two happen from different network
   * positions — the browser and the CLI — and an incident review needs both:
   * an approval that was never exchanged is itself a signal.
   */
  | 'token.authorized'
  | 'token.created'
  | 'token.revoked'
  | 'token.used'
  | 'key.rotated'
  /**
   * An environment acquired the key hierarchy its values are encrypted under:
   * version 1 of its EDK, its EHK, and the creator's own grant.
   *
   * Terminal in one direction, like `vault.created`: an environment is keyed
   * once, and re-keying it would abandon everything encrypted under the old key.
   * This record is therefore the origin of that environment's whole
   * cryptographic history, and the only event that can precede a secret in it.
   */
  | 'envkey.created'
  /**
   * The Environment Data Key was replaced and re-sealed to every remaining
   * principal.
   *
   * Distinct from `key.rotated`, which belongs to the server envelope and
   * records an operator rotating material this deployment holds. This one
   * records something a *member's browser* did with a key the server never saw,
   * and it is the event that closes a revocation: deleting somebody's grant
   * stops them being handed the key again, and only a rotation stops the key
   * they already have from opening what is written next. `keyVersion` carries
   * the new version and `grantCount` how many principals it reached.
   */
  | 'envkey.rotated'
  /**
   * A principal was handed an environment's keys — a member gaining access, a
   * service token at creation, an invitation being prepared.
   *
   * Worth its own event rather than folding into `access.granted`, because the
   * two answer different questions and routinely happen at different times: the
   * first says somebody is *allowed* to read an environment, this says somebody
   * *can*. Under a zero-knowledge model those come apart, and the gap between
   * them is exactly what the pending queue exists to track.
   */
  | 'envkey.granted'
  /**
   * A principal's grant was deleted — the bookkeeping half of a revocation.
   *
   * Deliberately *not* the moment the environment became safe again. The
   * principal read what they read while they held the grant, and the sealed key
   * may still be in a browser or a token string. What follows this record is an
   * `envkey.rotated`, and an environment where the second never arrives is one
   * where the revocation is on paper only — which is why both are recorded and
   * why the API reports `needsRotation` until it lands.
   */
  | 'envkey.grant_revoked'
  /**
   * Somebody was given access to an environment by a person who could not seal
   * its key, so the key share was queued.
   *
   * The honest record of a partial act. Access changed and the member still
   * cannot read anything, which is a state that looks like a bug from every
   * screen in the product; without this event, the audit log would show the
   * access grant and no explanation of the gap that followed it.
   */
  | 'envkey.grant_pending'
  | 'access.denied'
  /**
   * An organisation's plan, add-ons or limit overrides changed.
   *
   * Written by the operator tool today and by the payment webhooks later, and
   * deliberately the same event for both: what a reviewer needs to answer is
   * "when did this organisation gain SAML", and splitting that across two
   * action names by provenance makes the question take two queries. The
   * `operator` field is what distinguishes a hand-made change, and its absence
   * is what marks an automated one.
   */
  | 'plan.changed'
  /**
   * A control-plane write was refused because the organisation was at a plan
   * ceiling.
   *
   * Recorded as `denied`, like every other refusal. It is the only evidence
   * that a customer tried to do something their plan would not allow, which is
   * both a support signal and the most honest input to a pricing decision —
   * a ceiling nobody ever hits is a ceiling nobody is buying past.
   *
   * There is no matching event for a *fair-use* ceiling, because crossing one
   * refuses nothing; that path warns and continues.
   */
  | 'limit.exceeded'
  /*
   * ── Payments (P12) ──
   *
   * What the payment provider did, and what an owner asked it to do. The
   * *effect* of a billing change on what the organisation may do is always
   * `plan.changed` — written by the webhook with no `operator`, so it stays
   * one query to answer "when did this organisation gain Team" whichever way
   * it got there. The events below are the rest of the story: the requests,
   * the money that moved, and the alerts a human has to read.
   *
   * None of them carries an amount, a card detail, a customer id or a
   * payment-provider identifier of any kind. `AuditMetadata` has no field that
   * could hold one, and the redaction below recognises the provider's customer
   * ids and webhook secrets in the free-text fields that remain.
   */
  /**
   * An owner was sent to the payment provider's hosted checkout for a plan.
   * Records the request, never the outcome: the return from checkout grants
   * nothing, and only the provider's webhook — `plan.changed` — does.
   */
  | 'billing.checkout_started'
  /**
   * An owner moved an existing subscription to another plan or interval. Like
   * the checkout, the record of a request: the change itself lands as
   * `plan.changed` when the provider confirms it.
   */
  | 'billing.plan_change_requested'
  /**
   * An owner was handed a link to the payment provider's customer portal —
   * where the card is changed, invoices are read and the plan is cancelled.
   * The link itself is never recorded.
   */
  | 'billing.portal_opened'
  /**
   * The billed seat count was pushed to the payment provider after membership
   * changed — `seatCount` after, `previousSeatCount` before. Recorded as
   * `error` (reason `upstreamUnavailable`) when the push failed and was queued
   * for the hourly retry; the membership change it followed stands either way.
   */
  | 'billing.seats_synced'
  /**
   * A payment for the organisation's subscription failed. Nothing is removed
   * from the data path; the owners are emailed and the dashboard says so.
   */
  | 'billing.payment_failed'
  /**
   * The payment provider refunded a payment. An alert for a human, never a
   * reason to change access: a refund is somebody's decision, already made.
   */
  | 'billing.refunded'
  /**
   * A cardholder opened a dispute (a chargeback). An alert for a human, and
   * deliberately not a signal to lock anybody out — a dispute is often a
   * misunderstanding, and refusing a team its secrets over one would turn a
   * $30 fee into a lost customer.
   */
  | 'billing.dispute_opened'
  /**
   * The purchasing-power guardrail (pricing-plan §4): the billing country the
   * provider reported is not the country that issued the card that paid. An
   * alert for a human; nothing is changed automatically, because a traveller
   * and an arbitrageur look the same to a webhook.
   */
  | 'billing.region_mismatch'
  /**
   * A second live subscription arrived for an organisation that already has
   * one — two checkouts completed. Not applied: the existing subscription
   * stays the one access follows, and a human refunds the other.
   */
  | 'billing.duplicate_subscription'
  /**
   * The nightly reconciler found this organisation's subscription row
   * disagreeing with the payment provider. `driftFields` names what differs.
   * Alert-only: nothing is corrected automatically, because silent correction
   * hides the bug that caused the drift.
   */
  | 'billing.drift_detected'
  /**
   * Metered overage units — one per thousand secret fetches past the plan's
   * allowance — were reported to the payment provider. `unitCount` is how
   * many this report added. Our own count was written first; it is the
   * figure an invoice dispute is settled with.
   */
  | 'billing.usage_reported';

/**
 * A subscription status as the audit log records it — the same closed set as
 * `SubscriptionStatus` in `@xecret/core/entitlements`, restated here so this
 * module keeps no dependency on that one.
 */
export type AuditSubscriptionStatus =
  'active' | 'trialing' | 'past_due' | 'on_hold' | 'cancelled' | 'expired';

/** Which part of a subscription row the reconciler found disagreeing with the provider. */
export type BillingDriftField =
  | 'plan'
  | 'interval'
  | 'status'
  | 'seats'
  | 'periodEnd'
  | 'cancelAtPeriodEnd'
  | 'product'
  | 'addon'
  | 'missing';

/**
 * Fields permitted in `metadata`.
 *
 * There is deliberately no `value`, no `plaintext`, and no index signature. A
 * secret value cannot be placed in an audit record because the type system does
 * not allow it.
 *
 * The zero-knowledge events extend that guarantee rather than weakening it:
 * there is no `wrap`, no `verifier`, no `publicKey`, no `lookupHash`, and no
 * `recoveryCode`. Everything a vault event records is a *shape* — which kind of
 * wrap, how many codes — never the material itself. A wrap placed in an audit
 * record would put an offline attack surface into the one table the product is
 * built to keep readable, and the type system refuses it for the same reason it
 * refuses a secret value.
 */
export interface AuditMetadata {
  secretName?: string;
  /** The name a secret held before a rename; `secretName` carries the new one. */
  previousSecretName?: string;
  secretCount?: number;
  environmentSlug?: string;
  projectSlug?: string;
  targetEmail?: string;
  previousRole?: string;
  newRole?: string;
  /**
   * The custom role a member held before a role change removed it, by id and
   * by name.
   *
   * Only a promotion to `owner` does that today: an owner cannot hold a custom
   * role, so the repository clears it in the same write. Without these the
   * trail would show a narrowed member becoming an owner and say nothing about
   * the narrowing that went with it. The id survives a rename; the name is what
   * a reviewer reads. The role's definition — its actions, its ceiling — is not
   * copied: it lives on the role, and it is not what changed.
   */
  previousCustomRoleId?: string;
  previousCustomRoleName?: string;
  /**
   * The custom role an event is about, by id and by name: the role defined,
   * edited or deleted, or the one a member was moved onto.
   *
   * The name is the organisation's own words, so it is as attacker-influenced
   * as a secret name and cleaned the same way.
   */
  customRoleId?: string;
  customRoleName?: string;
  /**
   * The built-in role a custom role narrows, after and before an edit. Role
   * names, from a closed set.
   */
  baseRole?: string;
  previousBaseRole?: string;
  /**
   * A custom role's action list, after and before an edit.
   *
   * Action names and nothing else: the builder keeps only entries that are an
   * `Action`, so the field cannot carry a free string however it is called.
   */
  allowedActions?: readonly Action[];
  previousAllowedActions?: readonly Action[];
  /**
   * A custom role's access ceiling, after and before an edit. `null` records
   * "no ceiling" — which is a statement, not an omission: lifting a ceiling is
   * the edit most worth finding.
   */
  accessCeiling?: AuditAccessCeiling | null;
  previousAccessCeiling?: AuditAccessCeiling | null;
  /** How many members held a custom role when its definition changed. A count, never a list. */
  holderCount?: number;
  /**
   * The access level a grant held before and after a change, e.g. `read`.
   *
   * Level names, never values. `access.granted` without them says a grant
   * changed; with them it says what the change *was*, which is the difference
   * between an audit line and a useful one when reviewing how someone came to
   * hold production access.
   */
  previousAccessLevel?: string;
  newAccessLevel?: string;
  tokenPrefix?: string;
  /**
   * Which device an event concerned: a hostname for a CLI approval, the
   * browser's own uuid for a device PIN.
   *
   * A name the device gave or an id it minted — never a fingerprint this server
   * derived, and never a `User-Agent`. Both kinds are already known to the
   * account that owns them, which is what makes the field safe to keep and
   * useful to read: "which browser burned its PIN" is unanswerable without it.
   */
  deviceName?: string;
  keyVersion?: number;
  /**
   * Which kind of principal a key grant addressed: `member`, `token` or
   * `invite`.
   *
   * The kind, never the recipient's key and never the sealed blob — the same
   * rule `wrapKind` follows. It is recorded because the three have very
   * different implications in a review: a grant to a member is a person gaining
   * reach, a grant to a token is a credential in a CI provider gaining it, and a
   * grant to an invitation is a key sitting in a row waiting for somebody who
   * has not signed in yet.
   */
  principalKind?: 'member' | 'token' | 'invite';
  /**
   * How many principals a key operation covered. A count, never a list of them.
   *
   * On a rotation this is the whole point of the record: "the production key was
   * rotated and re-sealed to 9 principals" is checkable against the roster, and
   * a number that drops without a matching removal is the shape of a rotation
   * that quietly lost somebody.
   */
  grantCount?: number;
  /**
   * Which wrap of the User Key an unlock or an enrolment used, e.g. `passkey`.
   *
   * The kind, never the wrap. Recording it is what lets a review distinguish
   * "they typed the passphrase" from "a passkey on some device did it" from
   * "a recovery code was burned" — three quite different stories that would
   * otherwise share one event.
   */
  wrapKind?: 'passphrase' | 'recovery' | 'prf';
  /**
   * How a session was unlocked.
   *
   * Narrower than `wrapKind` and pointed at a different question. `wrapKind`
   * names which ciphertext was opened, which matters when reasoning about the
   * key hierarchy; this names what the person did, which is what somebody
   * reading an unlock trail is actually asking. "Every unlock on this account
   * last week was a passkey and then one was not" is the shape of a story, and
   * it is unreadable if the two paths are only distinguishable by wrap type.
   *
   * `pin` is the third, and the one most worth being able to count: it is the
   * weakest of the three by design, and "every unlock on this laptop for a month
   * was a PIN" is a posture somebody may want to notice.
   */
  method?: 'passphrase' | 'passkey' | 'pin';
  /**
   * How many parts an emailed vault archive was split into, and how many
   * environments it covered. Counts, never names: the archive itself carries
   * the names, and the audit trail has no business repeating them.
   */
  partCount?: number;
  environmentCount?: number;
  /** How many recovery codes a regeneration issued. A count, never a code. */
  recoveryCodeCount?: number;
  /** How many sessions one act affected — "lock everywhere", "sign out everywhere". */
  sessionCount?: number;
  /**
   * The declared shape of a secret's value, e.g. `int` or `url`.
   *
   * A type name, never a value. It is recorded because changing it changes what
   * future writes will be refused, which is a policy change worth being able to
   * date.
   */
  valueType?: string;
  reason?: string;
  /**
   * The plan an organisation moved to, and the one it held before.
   *
   * Plan names, never prices and never a payment identifier. What a review
   * needs from a billing change is which capabilities moved and when; the
   * amount charged lives with the payment provider, and copying it here would
   * put a second, staler answer in the table people trust most.
   */
  plan?: string;
  previousPlan?: string;
  /**
   * Which separately-purchased add-on changed, e.g. `saml`.
   *
   * Worth its own field rather than folding into `plan`, because an add-on is
   * the one change that costs us money the moment it is switched on — each is a
   * $125/month WorkOS connection — and "when was SAML enabled for this
   * organisation" needs to be answerable without reading every plan change.
   */
  addonName?: string;
  /** Which ceiling was raised or reached, e.g. `projects`. A field name, never a value. */
  limitName?: string;
  /** Seats billed after the change. A count, never an amount of money. */
  seatCount?: number;
  /** Seats billed before a seat change. A count, never an amount of money. */
  previousSeatCount?: number;
  /**
   * The billing interval a subscription moved to, and the one it held before.
   * A closed set; the sanitiser drops anything else.
   */
  billingInterval?: 'monthly' | 'yearly';
  previousBillingInterval?: 'monthly' | 'yearly';
  /**
   * The subscription status after a billing change, and before it — the
   * fact behind "the card failed on the 3rd", which is a status and not a
   * plan. A closed set, checked rather than copied.
   */
  subscriptionStatus?: AuditSubscriptionStatus;
  previousSubscriptionStatus?: AuditSubscriptionStatus;
  /**
   * The ISO-4217 currency the subscription is billed in, e.g. `INR`. A
   * currency, never an amount: three capital letters or nothing.
   */
  currency?: string;
  /**
   * The payment provider's event that caused the record, e.g.
   * `subscription.renewed`. A dotted lower-case name or nothing, so the
   * field cannot carry a payload however it is called.
   */
  billingEvent?: string;
  /** What the reconciler found disagreeing (`billing.drift_detected`). A closed list. */
  driftFields?: readonly BillingDriftField[];
  /** How many metered units a usage report added (`billing.usage_reported`). */
  unitCount?: number;
  /**
   * The person who ran an operator script, as they named themselves.
   *
   * A label and plainly a label — `actor_type` is `system` on these rows,
   * because an operator at a shell is not a user and not a token, and minting a
   * synthetic user id would put a lie in the one table this product promises is
   * truthful. Absent on anything a webhook wrote, which is what distinguishes
   * an automated plan change from a hand-made one.
   */
  operator?: string;
  source?: 'dashboard' | 'cli' | 'ci' | 'api';
  /**
   * The value an on/off setting holds after the change an event records — an
   * organisation's `sso_required`, its just-in-time opt-in.
   *
   * A boolean and only a boolean: the sanitiser drops anything else rather than
   * coercing it, so "switched on" can never be read from a string that merely
   * looks like one. The previous value is the opposite by construction — a
   * toggle is only recorded when it moved — so it is not stored twice.
   */
  enabled?: boolean;
  /**
   * How a person authenticated to the identity provider for a sign-in.
   *
   * A closed set, coarser than the provider's own vocabulary on purpose: a
   * review asks "was this a password, a Google account or the company's SSO",
   * not which of nineteen OAuth providers. `other` is a method the provider
   * named that this list does not know, recorded as such rather than guessed at.
   */
  signInMethod?: SignInMethod;
  /**
   * Why a sign-in was held back for the person to confirm before any session
   * was issued — on the `auth.login` / `auth.signup` of one they confirmed, and
   * on `auth.sign_in_declined` for one they did not. Absent from a sign-in that
   * needed no confirmation.
   *
   *  - `organization` — it came back through an organisation the flow did not
   *    ask for (the planted-session login CSRF's own signature).
   *  - `not-member` — through the organisation's single sign-on, for an account
   *    that was not yet a member of it.
   *  - `reused-session` — WorkOS answered from an authentication that predates
   *    the flow, for an account other than the last one on that browser.
   *
   * A closed set, checked against itself by the sanitiser.
   */
  confirmation?: SignInConfirmationKind;
  /**
   * An environment's parent after and before a change (P19 §1), by slug. `null`
   * is a statement — "inherits from nothing" — not an omission, like a cleared
   * ceiling.
   */
  parentEnvironmentSlug?: string | null;
  previousParentEnvironmentSlug?: string | null;
  /**
   * On a `secret.read` of a secret reached through a reference or an inherited
   * layer (P19 §1): the environment that was actually being read, and — for a
   * reference — the secret whose template pointed here. "Audit records the
   * referenced secret as read, with the referring secret as context": without
   * these, a pull of staging that resolved a reference into production would
   * leave production's log silent about the read.
   */
  contextEnvironmentSlug?: string;
  referringSecretName?: string;
  /**
   * Where a promotion's values came from (P19 §3), or the non-production end of
   * an `environment.link_crosses_protection`.
   */
  sourceEnvironmentSlug?: string;
  /** The project of `sourceEnvironmentSlug`, where it can be another one (a reference). */
  sourceProjectSlug?: string;
  /** How many secrets a promotion or a restore created, rewrote and deleted. Counts, never names. */
  createdCount?: number;
  updatedCount?: number;
  deletedCount?: number;
  /** The moment a restore returned an environment to, ISO 8601 (P19 §4). */
  restoredTo?: string;
  /**
   * The host a webhook delivers to — never the URL. Paths and query strings of
   * webhook URLs routinely carry credentials.
   */
  endpointHost?: string;
  /**
   * Which events a webhook is subscribed to. Event type names from a closed
   * set, checked against it by the sanitiser.
   */
  eventTypes?: readonly string[];
  /** Which policy an `org.policy_changed` or `environment.policy_changed` was about. */
  policyName?: 'tokens' | 'secrets' | 'plaintextExport' | 'readAlerts';
}

/** See `AuditMetadata.signInMethod`. */
export type SignInMethod = 'password' | 'oauth' | 'sso' | 'magic_auth' | 'passkey' | 'other';

/** See `AuditMetadata.confirmation`. */
export type SignInConfirmationKind = 'organization' | 'not-member' | 'reused-session';

/** A custom role's ceiling as an audit record carries it: two level names. */
export interface AuditAccessCeiling {
  nonProduction: AccessLevel;
  production: AccessLevel;
}

export interface AuditEvent {
  orgId: string;
  actorType: ActorType;
  actorId: string | null;
  /** Denormalised so the record still reads correctly after the actor is deleted. */
  actorLabel: string | null;
  action: AuditAction;
  resourceType: string | null;
  resourceId: string | null;
  projectId: string | null;
  environmentId: string | null;
  outcome: AuditOutcome;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  metadata: AuditMetadata;
}
