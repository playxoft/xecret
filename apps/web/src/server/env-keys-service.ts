import { can } from '@xecret/core/authz';
import type { Action } from '@xecret/core/authz';
import {
  addEnvKeyGrants,
  findGrantForPrincipal,
  findPendingInvitationForGrant,
  hasVault,
  initializeEnvironmentKeys,
  listGrantsForEnvironment,
  listMemberSealingKeys,
  listMembers,
  listPendingKeyGrants,
  listSealableServiceTokens,
  loadAuthorizationContext,
  loadEnvironmentKeyState,
  queuePendingKeyGrant,
  removeEnvKeyGrant,
  removeMemberGrantsForEnvironment,
  removePendingKeyGrant,
  rotateEnvDataKey,
  RepositoryError,
  toBytes,
} from '@xecret/db/repositories';
import type { EnvKeyGrantRecord } from '@xecret/db/repositories';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { errors } from './errors';
import {
  encodePublicKey,
  toActiveKey,
  toGrant,
  toGrantSeed,
  toPendingGrant,
} from './schemas/env-keys';
import type {
  EnvironmentKeyGrantsRequest,
  EnvironmentKeyInitRequest,
  EnvironmentKeyRotateRequest,
  EnvironmentKeysPayload,
  GrantRequest,
  RecipientPayload,
  RecipientsPayload,
  UnsealablePayload,
} from './schemas/env-keys';
import { authorize, toGrantContext } from './tenancy';
import type { EnvironmentScope } from './tenancy';

/**
 * Environment keys: reading a grant, initialising a hierarchy, rotating it, and
 * handing it to a new principal.
 *
 * ── What this module is, and what it deliberately is not ──
 * It is the **policy** layer over `env_key_grants`: who may ask for a grant, who
 * must appear in a rotation, and what an environment's key state means. It is
 * not, and cannot become, a crypto layer. Every value that passes through is a
 * blob the API boundary has checked the shape of and nothing here has opened —
 * there is no key in this process with which it could be opened, which is what
 * makes that a structural property rather than a discipline.
 *
 * ── The one genuinely load-bearing decision in this file ──
 * `assertCompleteGrantSet`. A rotation is a *revocation* mechanism: it replaces
 * the key a removed principal still holds. The client generates the new key and
 * seals it, because only the client can — but that means the client also chooses
 * who receives it, and a client that quietly omitted somebody would produce a
 * request that succeeds and silently revokes a colleague. Worse, it would do so
 * invisibly: the omitted person keeps read access, keeps seeing every secret
 * name, and simply cannot decrypt anything written after that moment.
 *
 * So the server recomputes the set from the authorization model and requires an
 * exact match — no missing principals, no extra ones. It is the one thing about a
 * rotation the server *can* check, because it is a question about `can()` and
 * membership rather than about bytes, and the error names precisely who is
 * missing and who is surplus so a client can correct it rather than guess.
 *
 * ── Why no new `Action` was introduced ──
 * Key management maps onto the capabilities that already exist, and a parallel
 * permission system would be a second answer to "may this person act on this
 * environment" that could disagree with the first:
 *
 *  - **reading your own grant** is `secret.read` — you can only open a key you
 *    are allowed to use the values of, and any narrower gate would let somebody
 *    hold a key for an environment they may not read.
 *  - **initialising and rotating** are `environment.update`, which already
 *    requires `admin` on the environment and is already the gate on the other
 *    change that alters who can reach an environment's contents (`isProduction`).
 *  - **granting to another principal** is `secret.read` as well, and that is not
 *    a laxer rule than it looks: sealing a key requires *holding* it, and holding
 *    it requires a grant, which requires read access. The authorization check and
 *    the cryptographic one agree by construction. Whether the *recipient* should
 *    have access is checked separately, against their own resolved level.
 *  - **revoking a grant** is `environment.update`, matching rotation: the two are
 *    halves of one act, and only together do they mean anything.
 */

/** Reading a grant needs the same authority as reading what it decrypts. */
const READ_KEYS: Action = 'secret.read';

/** Changing who holds an environment's keys is an administrative act on it. */
const MANAGE_KEYS: Action = 'environment.update';

/**
 * Refuses an operation on an environment that is not end-to-end encrypted.
 *
 * A `server`-mode environment has no EDK, no EHK and no grants — its values are
 * encrypted under `env_keys`, which the Worker unwraps. Asking it for a key
 * grant is not a permission failure and not a missing row; it is a category
 * error, and 409 says that: the resource exists, the caller may see it, and the
 * request does not apply to it in its current state.
 */
export function requireE2ee(scope: EnvironmentScope): void {
  if (scope.environment.encryptionMode !== 'e2ee') {
    throw errors.conflict(
      'This environment still uses server-side encryption and has no client-held keys.',
    );
  }
}

/**
 * The principal a grant is addressed to, for the current caller.
 *
 * A CLI token resolves to its **user**, deliberately: the token is a delivery
 * mechanism for a person's identity and carries no key material of its own, so
 * the grant it opens is that person's grant. A service token resolves to itself,
 * because it genuinely is its own principal with its own keypair (spec §4.1).
 */
export function grantRecipient(principal: Principal): { kind: 'member' | 'token'; id: string } {
  switch (principal.kind) {
    case 'user':
      return { kind: 'member', id: principal.user.id };
    case 'cliToken':
      return { kind: 'member', id: principal.userId };
    case 'serviceToken':
      return { kind: 'token', id: principal.tokenId };
  }
}

/**
 * The user whose vault signs and seals, or a refusal.
 *
 * Producing a grant means opening the environment's key with a private key and
 * signing the result with another — both of which live in an unlocked browser
 * and in nothing else. A bearer token has neither, so it cannot create a grant,
 * and saying so plainly is better than letting it send a body that could only
 * ever have been fabricated.
 */
export function requireSealingUser(principal: Principal): string {
  if (principal.kind !== 'user') {
    throw errors.forbidden(
      'Sealing an environment key requires an unlocked browser session, not a token.',
    );
  }
  return principal.user.id;
}

/**
 * Everything `GET …/keys` answers.
 *
 * Four reads at most, and the two administrative ones are skipped entirely for a
 * caller who may not see them — so the common case (a developer opening an
 * environment) costs the key state and their own grant, and nothing else.
 */
export async function environmentKeyState(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
): Promise<EnvironmentKeysPayload> {
  // Authorised here rather than only in the route, matching every other function
  // in this module. `authorizeSecretAction` makes the same argument for the
  // secret paths: a gate a route has to remember is a gate a new route will
  // forget, and this one is what stops a caller holding a key for an environment
  // they may not read.
  authorizeKeyAction(scope, principal, READ_KEYS);

  const state = await loadEnvironmentKeyState(
    services.db,
    scope.organization.id,
    scope.environment.id,
  );

  const recipient = grantRecipient(principal);
  const grant =
    state.activeKey === null
      ? null
      : await findGrantForPrincipal(services.db, {
          orgId: scope.organization.id,
          environmentId: scope.environment.id,
          recipientKind: recipient.kind,
          recipientId: recipient.id,
        });

  const isAdmin = mayManageKeys(scope, principal);

  const pending = isAdmin
    ? await listPendingKeyGrants(services.db, scope.organization.id, scope.environment.id)
    : null;

  return {
    encryptionMode: scope.environment.encryptionMode === 'e2ee' ? 'e2ee' : 'server',
    environmentId: scope.environment.id,
    activeEdk: state.activeKey === null ? null : toActiveKey(state.activeKey),
    myGrant: grant === null ? null : stripRecipient(toGrant(grant)),
    ehkExists: state.ehkExists,
    pendingGrants: pending === null ? null : pending.map(toPendingGrant),
    needsRotation:
      state.activeKey === null ? false : await needsRotation(scope, services, state.activeKey.id),
    currentMaxSecretVersion: state.currentMaxSecretVersion,
  };
}

/**
 * Initialises an environment's key hierarchy, for an `e2ee` environment that
 * somehow has none.
 *
 * ── When this is reachable at all ──
 * Not on the ordinary path: `POST …/environments` creates the environment and
 * its keys in one transaction, precisely so a keyless `e2ee` environment cannot
 * exist. This endpoint is the repair for the case that transaction never covered
 * — an environment that predates the creation flow, or one whose creation was
 * interrupted in a way the transaction could not roll back. It is a repair rather
 * than a step, and the 409 below is what keeps it one.
 *
 * A second call is a **409, never an overwrite**, for the reason `POST
 * /api/auth/vault` gives: the existing key has values encrypted under it, and
 * replacing it silently would make every one of them unreadable while reporting
 * success. The check is inside the repository's transaction; this translates it.
 */
export async function initializeKeys(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
  body: EnvironmentKeyInitRequest,
): Promise<{ id: string; version: number }> {
  requireE2ee(scope);
  authorizeKeyAction(scope, principal, MANAGE_KEYS);

  const userId = requireSealingUser(principal);
  assertSelfGrant(body.grant, userId);

  try {
    const key = await initializeEnvironmentKeys(services.db, {
      orgId: scope.organization.id,
      environmentId: scope.environment.id,
      createdBy: userId,
      grant: toGrantSeed(body.grant),
    });

    return { id: key.id, version: key.version };
  } catch (cause) {
    throw mapKeyError(cause);
  }
}

/**
 * Rotates the environment's data key, after checking the grant set is complete.
 *
 * The completeness check runs **before** the write and is the whole value this
 * endpoint adds over "insert what you were given" — see `assertCompleteGrantSet`.
 */
export async function rotateKeys(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
  body: EnvironmentKeyRotateRequest,
): Promise<{ id: string; version: number; grantCount: number }> {
  requireE2ee(scope);
  authorizeKeyAction(scope, principal, MANAGE_KEYS);

  const userId = requireSealingUser(principal);

  await assertCompleteGrantSet(scope, services, body.grants);

  try {
    const key = await rotateEnvDataKey(services.db, {
      orgId: scope.organization.id,
      environmentId: scope.environment.id,
      createdBy: userId,
      version: body.newVersion,
      grants: body.grants.map(toGrantSeed),
    });

    return { id: key.id, version: key.version, grantCount: body.grants.length };
  } catch (cause) {
    throw mapKeyError(cause);
  }
}

/**
 * Adds grants for principals that did not have one.
 *
 * ── Two independent questions, both asked ──
 * The *granter* must hold the key, which `secret.read` on the environment is the
 * observable proxy for — you cannot seal what you cannot open, so the
 * authorization check and the cryptographic reality agree by construction.
 *
 * The *recipient* must be entitled to it, which is checked separately in
 * `assertRecipientEligible`. Without that second check this endpoint would be a
 * privilege escalation with extra steps: any developer holding a production key
 * could hand it to anybody in the organisation, and the access model — which
 * makes production deny-by-default even for developers — would be enforced only
 * on the routes that read secrets, while the key itself circulated freely.
 */
export async function addGrants(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
  body: EnvironmentKeyGrantsRequest,
): Promise<{ added: number }> {
  requireE2ee(scope);
  authorizeKeyAction(scope, principal, READ_KEYS);

  const userId = requireSealingUser(principal);

  for (const grant of body.grants) {
    await assertRecipientEligible(scope, services, grant);
  }

  try {
    const added = await addEnvKeyGrants(services.db, {
      orgId: scope.organization.id,
      environmentId: scope.environment.id,
      envDataKeyId: body.envDataKeyId,
      signedByUserId: userId,
      grants: body.grants.map(toGrantSeed),
    });

    return { added };
  } catch (cause) {
    throw mapKeyError(cause);
  }
}

/**
 * Deletes one grant.
 *
 * **This does not make anything unreadable**, and the API says so rather than
 * implying otherwise: the principal read what they read while they held it, and
 * the sealed key may still be in a browser or in a token string. Removing the row
 * stops them being handed the key *again*; the rotation that must follow is what
 * stops the key they already have from opening what is written next. Until it
 * lands, `GET …/keys` reports `needsRotation: true`.
 */
export async function revokeGrant(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
  grantId: string,
): Promise<EnvKeyGrantRecord> {
  requireE2ee(scope);
  authorizeKeyAction(scope, principal, MANAGE_KEYS);

  const removed = await removeEnvKeyGrant(services.db, {
    orgId: scope.organization.id,
    environmentId: scope.environment.id,
    grantId,
  });

  // The same 404 whether the id belongs to another tenant or to nobody: the
  // repository scopes by environment, so the two are indistinguishable here by
  // construction (threat T2).
  if (!removed) throw errors.notFound('no such key grant in environment');

  return removed;
}

/**
 * Deletes a member's grants on one environment, and clears any queued debt.
 *
 * Called by the member-management paths when access is narrowed or removed. The
 * queued debt goes too: a pending row asks somebody to seal a key to a person
 * who is no longer entitled to it, and leaving it would put an item in the admin
 * banner whose only correct resolution is to dismiss it.
 *
 * Returns whether anything was removed, so the caller records an audit event for
 * a revocation that happened rather than one that was merely requested.
 */
export async function revokeMemberAccess(
  services: ServiceContext,
  params: { orgId: string; environmentId: string; userId: string },
): Promise<number> {
  const removed = await removeMemberGrantsForEnvironment(services.db, params);

  await removePendingKeyGrant(services.db, {
    environmentId: params.environmentId,
    targetUserId: params.userId,
  });

  return removed;
}

/**
 * Records that a member is owed a key on an environment.
 *
 * The queue exists because access is decided by people who may not hold the key:
 * an owner can grant a developer production access without ever having opened
 * production themselves, and if they hold no grant their browser has no EDK to
 * seal. Refusing the access change would make authorization depend on who happens
 * to hold which key; granting it with no key would leave somebody who can list
 * every secret name and decrypt none of them, with nothing saying why.
 *
 * Idempotent: widening access twice before anybody fulfils the first request
 * owes the same single key.
 */
export async function queueKeyShare(
  services: ServiceContext,
  params: { environmentId: string; targetUserId: string; requestedBy: string },
): Promise<boolean> {
  return queuePendingKeyGrant(services.db, params);
}

/**
 * Whether an environment has a principal whose grant was deleted but whose key
 * has not been replaced.
 *
 * Derived rather than stored, and that is deliberate. A stored flag would be a
 * second source of truth about a state that is fully determined by the rows:
 * somebody who should not hold the active key still can, because a grant was
 * removed and no rotation followed. Deriving it means the answer cannot drift
 * from the grants it describes, and it cannot be left set by a failed write or
 * cleared by one that did not actually rotate anything.
 *
 * The comparison is between **who holds a grant on the active key** and **who the
 * authorization model says should** — the same computation `assertCompleteGrantSet`
 * performs, which is why they share `requiredPrincipals`. A holder the model does
 * not name is a revocation waiting for its rotation.
 */
async function needsRotation(
  scope: EnvironmentScope,
  services: ServiceContext,
  activeKeyId: string,
): Promise<boolean> {
  const holders = await listGrantsForEnvironment(
    services.db,
    scope.organization.id,
    scope.environment.id,
  );

  const entitled = await requiredPrincipals(scope, services);

  return holders.some(
    (grant) =>
      grant.envDataKeyId === activeKeyId &&
      // An invitation grant is not held by anybody yet — it is a key waiting for
      // somebody who has not signed in. It is deleted at acceptance rather than
      // rotated away, so counting it as a stale holder would report every
      // outstanding invitation as a pending revocation.
      grant.recipientKind !== 'invite' &&
      !entitled.has(principalKey(grant.recipientKind, grant.recipientId)),
  );
}

/**
 * Every principal that must hold a grant on this environment's active key.
 *
 * Computed from the authorization model, never from the existing grants — which
 * is the point: comparing the grants against themselves would prove nothing, and
 * a rotation set derived from the current holders would faithfully preserve
 * whoever was wrongly included.
 *
 * **Members** are every active member whose resolved level on this environment is
 * at least `read`, decided by `can()` — the same function every request goes
 * through, so the key set and the access model cannot disagree.
 *
 * **Service tokens** are those pinned to this environment that still have a
 * public key. A token minted before the Phase 4 creation flow has no keypair, so
 * there is nothing to seal to; excluding it is what stops a rotation being
 * blocked for ever by a legacy credential nobody can re-key.
 *
 * **Invitations** are not required. An invitation's grants are sealed to a
 * one-off keypair whose private half exists only in a fragment the server has
 * never seen, so nobody rotating a key can re-seal to it. The correct handling is
 * that the invitation's grants become stale and its holder re-runs the flow,
 * which is why they are permitted in a set but never demanded.
 */
async function requiredPrincipals(
  scope: EnvironmentScope,
  services: ServiceContext,
): Promise<Set<string>> {
  const entitled = await entitledPrincipals(scope, services);

  const required = new Set<string>();
  for (const userId of entitled.memberUserIds) required.add(principalKey('member', userId));
  for (const token of entitled.tokens) required.add(principalKey('token', token.id));
  return required;
}

/** The same computation, before it is flattened into comparison keys. */
interface EntitledPrincipals {
  memberUserIds: string[];
  tokens: { id: string; publicKey: Uint8Array }[];
}

async function entitledPrincipals(
  scope: EnvironmentScope,
  services: ServiceContext,
): Promise<EntitledPrincipals> {
  const memberUserIds: string[] = [];

  // Unpaginated on purpose: a partial roster would produce a "complete" grant
  // set missing everybody past the first page, which is precisely the silent
  // revocation this whole check exists to prevent. `listMembers` clamps its page
  // size, so the ceiling is asked for explicitly.
  const roster = await listMembers(services.db, scope.organization.id, { pageSize: 200 });

  for (const member of roster.members) {
    if (member.status !== 'active') continue;

    const context = await loadAuthorizationContext(services.db, {
      orgId: scope.organization.id,
      userId: member.userId,
    });
    if (!context) continue;

    const decision = can(
      { kind: 'user', userId: member.userId, orgId: scope.organization.id },
      READ_KEYS,
      {
        kind: 'environment',
        orgId: scope.organization.id,
        projectId: scope.environment.projectId,
        environmentId: scope.environment.id,
      },
      { membership: toGrantContext(context), isProduction: scope.environment.isProduction },
    );

    if (decision.allowed) memberUserIds.push(member.userId);
  }

  const tokens = await listSealableServiceTokens(
    services.db,
    scope.organization.id,
    scope.environment.id,
  );

  return { memberUserIds, tokens };
}

/**
 * Who a client may seal this environment's key to, and who already holds it.
 *
 * ── The gap this closes ──
 * Phase 3a defined every endpoint that *consumes* a grant set and none that can
 * produce one. Sealing is asymmetric: a grant for somebody is built from **their**
 * public key, and a browser has no other way to learn one. Without this, rotation
 * and the pending-share queue are not awkward, they are impossible to attempt.
 *
 * ── Why `secret.read` and not `environment.update` ──
 * The same gate as `POST …/keys/grants`, because this returns exactly the set of
 * principals that endpoint will accept a grant for. A directory gated more
 * tightly than the write it feeds would leave the queued shares unfulfillable by
 * the very people who hold the key — the queue exists precisely because the
 * person who *changed* the access often does not.
 *
 * What it discloses is "who may read this environment", to somebody who already
 * may read it. `pendingGrants` on `GET …/keys` stays admin-only on its own terms:
 * it names people who are *waiting*, which is a statement about an act somebody
 * else performed.
 */
export async function sealingRecipients(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
): Promise<RecipientsPayload> {
  requireE2ee(scope);
  authorizeKeyAction(scope, principal, READ_KEYS);

  const state = await loadEnvironmentKeyState(
    services.db,
    scope.organization.id,
    scope.environment.id,
  );

  const entitled = await entitledPrincipals(scope, services);

  const holders =
    state.activeKey === null
      ? []
      : await listGrantsForEnvironment(services.db, scope.organization.id, scope.environment.id);

  const activeKeyId = state.activeKey?.id ?? null;
  const held = new Set(
    holders
      .filter((grant) => grant.envDataKeyId === activeKeyId)
      .map((grant) => principalKey(grant.recipientKind, grant.recipientId)),
  );

  const memberKeys = await listMemberSealingKeys(services.db, entitled.memberUserIds);
  const byUser = new Map(memberKeys.map((entry) => [entry.userId, entry]));

  const recipients: RecipientPayload[] = [];
  const unsealable: UnsealablePayload[] = [];

  for (const userId of entitled.memberUserIds) {
    const keys = byUser.get(userId);
    // No vault, no public key, nothing to seal to. Named rather than dropped, so
    // a rotation can say "ask Dana to finish setting up her vault" instead of
    // being refused later by the completeness check with a bare uuid.
    if (keys === undefined) {
      unsealable.push({ kind: 'member', id: userId });
      continue;
    }

    recipients.push({
      kind: 'member',
      id: userId,
      publicKey: encodePublicKey(toBytes(keys.encPublicKey)),
      holdsGrant: held.has(principalKey('member', userId)),
    });
  }

  for (const token of entitled.tokens) {
    recipients.push({
      kind: 'token',
      id: token.id,
      publicKey: encodePublicKey(toBytes(token.publicKey)),
      holdsGrant: held.has(principalKey('token', token.id)),
    });
  }

  return {
    activeEdk: state.activeKey === null ? null : toActiveKey(state.activeKey),
    environmentId: scope.environment.id,
    recipients,
    unsealable,
  };
}

/**
 * Refuses a rotation whose grant set does not match the authorization model.
 *
 * ── Why both directions are refused ──
 * A **missing** principal is a silent revocation: they keep read access, keep
 * seeing every secret name, and simply cannot decrypt anything written after
 * this moment — a failure with no error, no screen, and no audit record beyond a
 * successful rotation.
 *
 * An **extra** principal is the opposite failure and the more dangerous one: it
 * is a grant to somebody the access model does not permit, minted through the one
 * endpoint whose job is to write grants in bulk. A rotation that accepted extras
 * would be a way to hand production keys to a viewer while the audit log recorded
 * a routine key rotation.
 *
 * ── Why the error names names ──
 * Contrary to the usual rule that this API does not echo request content, the
 * message lists the principal ids that are missing or surplus. They are ids the
 * caller already holds — they are in the request body, or they are members of an
 * organisation the caller administers — so nothing is disclosed. And the
 * alternative is unusable: "your grant set is wrong" against a set of forty
 * gives a client no way to correct it except to re-derive the whole thing and
 * hope, which is exactly how a client ends up looping.
 */
async function assertCompleteGrantSet(
  scope: EnvironmentScope,
  services: ServiceContext,
  grants: readonly GrantRequest[],
): Promise<void> {
  const required = await requiredPrincipals(scope, services);

  const supplied = new Set(
    grants.map((grant) => principalKey(grant.recipientKind, grant.recipientId)),
  );

  // A duplicate would satisfy the set comparison while writing two grants for
  // one principal, which the unique index would then reject mid-transaction —
  // after the completeness check had reported success.
  if (supplied.size !== grants.length) {
    throw errors.badRequest('A rotation must name each principal exactly once.');
  }

  const missing = [...required].filter((entry) => !supplied.has(entry));
  const extra = [...supplied].filter(
    (entry) => !required.has(entry) && !entry.startsWith('invite:'),
  );

  if (missing.length === 0 && extra.length === 0) return;

  throw errors.validation([
    ...missing.map((entry) => ({
      field: 'grants',
      message: `Missing a grant for ${entry}, which has access to this environment.`,
    })),
    ...extra.map((entry) => ({
      field: 'grants',
      message: `Unexpected grant for ${entry}, which has no access to this environment.`,
    })),
  ]);
}

/**
 * Refuses a grant to a principal that is not entitled to the environment.
 *
 * The recipient-side check `addGrants` describes. An invitation is exempt: it has
 * no membership to resolve yet, and its entitlement was decided when the
 * invitation's `initial_grants` were chosen — re-deciding it here would need a
 * member row that does not exist.
 */
async function assertRecipientEligible(
  scope: EnvironmentScope,
  services: ServiceContext,
  grant: GrantRequest,
): Promise<void> {
  if (grant.recipientKind === 'invite') {
    // No membership to resolve — the invitee has not joined and may not have an
    // account. What is checked instead is that the invitation is **this
    // organisation's and still open**: without it, a member of one organisation
    // could seal their environment's key to an invitation belonging to another,
    // and the invitee would decrypt it on acceptance somewhere else entirely.
    //
    // An expired or revoked invitation is refused for the plainer reason that
    // nobody will ever open the grant: acceptance is what consumes it, and a
    // closed invitation is never accepted.
    const invitation = await findPendingInvitationForGrant(
      services.db,
      scope.organization.id,
      grant.recipientId,
    );
    if (invitation === null) {
      throw errors.badRequest('That invitation cannot hold a key for this environment.');
    }
    return;
  }

  if (grant.recipientKind === 'token') {
    const tokens = await listSealableServiceTokens(
      services.db,
      scope.organization.id,
      scope.environment.id,
    );
    if (!tokens.some((token) => token.id === grant.recipientId)) {
      // One message for "no such token", "a token in another environment" and "a
      // token with no public key". The first two are the usual non-disclosure
      // rule; the third is genuinely the same answer, because a token with no
      // keypair cannot be sealed to and there is nothing the caller can do about
      // it from here.
      throw errors.badRequest(
        'That service token cannot hold a key for this environment. It may be revoked, scoped elsewhere, or created before token keypairs existed.',
      );
    }
    return;
  }

  const context = await loadAuthorizationContext(services.db, {
    orgId: scope.organization.id,
    userId: grant.recipientId,
  });

  const decision =
    context === null
      ? { allowed: false as const }
      : can(
          { kind: 'user', userId: grant.recipientId, orgId: scope.organization.id },
          READ_KEYS,
          {
            kind: 'environment',
            orgId: scope.organization.id,
            projectId: scope.environment.projectId,
            environmentId: scope.environment.id,
          },
          { membership: toGrantContext(context), isProduction: scope.environment.isProduction },
        );

  if (!decision.allowed) {
    throw errors.badRequest(
      'That member has no access to this environment, so they must not hold its key.',
    );
  }
}

/**
 * Refuses an initialisation whose grant is addressed to somebody else.
 *
 * At creation the only principal whose key could have sealed this blob is the
 * creator's own, so a grant naming anybody else was either fabricated or sealed
 * to a public key the creator had no business using. Neither is a state to store.
 */
function assertSelfGrant(grant: GrantRequest, userId: string): void {
  if (grant.recipientKind !== 'member' || grant.recipientId !== userId) {
    throw errors.badRequest("An environment's first key grant must be the creator's own.");
  }
}

/** Whether the caller may see and act on the administrative half of `GET …/keys`. */
function mayManageKeys(scope: EnvironmentScope, principal: Principal): boolean {
  const decision = can(
    scope.actor,
    MANAGE_KEYS,
    {
      kind: 'environment',
      orgId: scope.organization.id,
      projectId: scope.environment.projectId,
      environmentId: scope.environment.id,
    },
    {
      membership: scope.membership ? toGrantContext(scope.membership) : undefined,
      serviceToken:
        principal.kind === 'serviceToken' ? { accessLevel: principal.accessLevel } : undefined,
      isProduction: scope.environment.isProduction,
    },
  );

  return decision.allowed;
}

/**
 * Authorises a key action, supplying a service token's own access level.
 *
 * The same shape as `authorizeSecretAction`, and for the same reason: `can()` is
 * deny-closed when a service token arrives without its context, so threading it
 * through one function means no route can forget it — and there is still exactly
 * one decision procedure underneath.
 */
function authorizeKeyAction(scope: EnvironmentScope, principal: Principal, action: Action): void {
  authorize(scope, action, {
    serviceTokenAccessLevel: principal.kind === 'serviceToken' ? principal.accessLevel : undefined,
  });
}

/** The identity of a principal in a set comparison. Kind included — ids alone could collide. */
function principalKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function stripRecipient(grant: ReturnType<typeof toGrant>) {
  return {
    // The recipient's key stays: it is the caller's own, it is part of the
    // signed payload, and a client that wants to check its grant was sealed to
    // the key it actually holds needs it in the same answer.
    recipientPublicKey: grant.recipientPublicKey,
    edkSealed: grant.edkSealed,
    ehkSealed: grant.ehkSealed,
    signature: grant.signature,
    signedByUserId: grant.signedByUserId,
  };
}

/**
 * Whether an account has the vault material an e2ee environment needs.
 *
 * Used by the environment-creation route to refuse before anything is written: a
 * user with no vault has no public key to seal to and no signing key to sign
 * with, so a creation payload from them could not have been produced honestly.
 */
export async function callerHasVault(
  services: ServiceContext,
  principal: Principal,
): Promise<boolean> {
  if (principal.kind !== 'user') return false;
  return hasVault(services.db, principal.user.id);
}

/**
 * Maps a repository invariant failure onto the API's vocabulary.
 *
 * `conflict` is the interesting one here, and it covers three genuinely
 * different races that are all the caller's to resolve by re-reading: an
 * environment keyed in another tab, a rotation that lost to another rotation, and
 * a grant sealed against a key that has since been retired. None is a 500, and
 * all three have the same remedy.
 */
function mapKeyError(cause: unknown): unknown {
  if (!(cause instanceof RepositoryError)) return cause;

  switch (cause.code) {
    case 'conflict':
      return errors.conflict(cause.message);
    case 'notFound':
      return errors.notFound(cause.message);
    default:
      return errors.badRequest(cause.message);
  }
}
