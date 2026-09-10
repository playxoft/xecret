import { can, roleDefaultAccessLevel } from '@xecret/core/authz';
import type { Action, Membership, ResolvedGrant } from '@xecret/core/authz';
import {
  addEnvKeyGrants,
  canClaimInvitationGrants,
  findGrantForPrincipal,
  findPendingInvitationForGrant,
  hasVault,
  initializeEnvironmentKeys,
  listGrantsForEnvironment,
  listMemberSealingKeys,
  listPendingKeyGrants,
  listSealableServiceTokens,
  loadAuthorizationContext,
  loadEnvironmentKeyState,
  loadOrganizationAuthorizationContexts,
  queuePendingKeyGrant,
  removeEnvKeyGrant,
  removeMemberGrantsForEnvironment,
  removePendingKeyGrant,
  rotateEnvDataKey,
  RepositoryError,
  toBytes,
} from '@xecret/db/repositories';
import type {
  EnvKeyGrantRecord,
  Executor,
  PendingInvitationForGrant,
} from '@xecret/db/repositories';
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
  MissingGrantPayload,
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
 * ── The query budget, stated honestly ──
 * Four reads for an ordinary caller: the key state (three statements) and their
 * own grant. Every one of them is constant in the size of the organisation.
 *
 * An **administrator** pays for the key-hygiene answer on top — the pending
 * queue, the environment's grants, the active roster and its access grants: four
 * more statements, and still constant in the roster, because
 * `loadOrganizationAuthorizationContexts` reads members and grants in bulk
 * rather than a context per member. That distinction is the whole point: a
 * per-member loop had to paginate, and a paginated roster produces a "complete"
 * grant set missing everybody past the first page.
 *
 * The hygiene fields are computed **only for a caller who may act on them**, and
 * that is a cost decision as much as a disclosure one: `POST …/pull` reaches this
 * function on the hottest path in the product, always as a non-administrator, and
 * it has no use for "somebody needs to rotate this". `needsRotation` and
 * `missingGrants` are therefore `null` rather than `false` for them — an
 * uncomputed answer said out loud, instead of a reassuring one nobody checked.
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

  const hygiene =
    isAdmin && state.activeKey !== null
      ? await keyHygiene(services.db, scope, state.activeKey.id)
      : null;

  return {
    encryptionMode: scope.environment.encryptionMode === 'e2ee' ? 'e2ee' : 'server',
    environmentId: scope.environment.id,
    activeEdk: state.activeKey === null ? null : toActiveKey(state.activeKey),
    myGrant: grant === null ? null : stripRecipient(toGrant(grant)),
    ehkExists: state.ehkExists,
    pendingGrants: pending === null ? null : pending.map(toPendingGrant),
    // `false` when there is no key at all and this caller could have seen one:
    // an environment with nothing to rotate is not owed a rotation. `null` means
    // "not computed for you" — see the header.
    needsRotation: isAdmin ? (hygiene?.needsRotation ?? false) : null,
    missingGrants: isAdmin ? (hygiene?.missingGrants ?? []) : null,
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
 * ── The completeness check runs *inside* the rotation's transaction ──
 * It used to run before it, and that was a hole rather than an ordering
 * preference. Between a check that passed and a commit that landed, a concurrent
 * member removal could revoke somebody — and the rotation, working from the set
 * it had already validated, would seal the brand-new key **to the person it was
 * meant to cut off**. Silently: a 200, an `envkey.rotated` audit record, and an
 * environment the removed member can still read.
 *
 * So `assertGrantSet` is handed to the repository and re-derives the required set
 * from *this* transaction's view, under the organisation lock that membership and
 * access-grant changes already take. A drift is an abort, not a warning.
 *
 * ── Invitation grants are checked here rather than only in `addGrants` ──
 * `assertCompleteGrantSet` permits an `invite:` entry without demanding one,
 * because nobody rotating can re-seal to an invitation's one-off keypair. Permit
 * is not the same as accept: without an eligibility check, this endpoint would
 * hand an invitation of another organisation — or one whose selected access never
 * included this environment — a working copy of the key. Every invite grant in a
 * rotation goes through the same `assertRecipientEligible` the grant endpoint
 * uses.
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

  try {
    const key = await rotateEnvDataKey(services.db, {
      orgId: scope.organization.id,
      environmentId: scope.environment.id,
      createdBy: userId,
      version: body.newVersion,
      grants: body.grants.map(toGrantSeed),
      assertGrantSet: async (tx) => {
        await assertCompleteGrantSet(tx, scope, body.grants);

        for (const grant of body.grants) {
          if (grant.recipientKind !== 'invite') continue;
          await assertRecipientEligible(tx, scope, grant);
        }
      },
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
 *
 * ── The third question, asked only when `claimInvitationId` is present ──
 * A write that consumes an invitation's grants must prove it is entitled to
 * consume *that* invitation's: it has to belong to this organisation and this
 * account has to be the person who accepted it. Without that, any member holding
 * a key could name a colleague's invitation and destroy grants they had not
 * claimed — a denial nobody would notice, because the pending-share fallback
 * would silently cover for it. The check is a 403 rather than a silent no-op, so
 * a client that got it wrong learns it did.
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
    await assertRecipientEligible(services.db, scope, grant);
  }

  if (body.claimInvitationId !== undefined) {
    const permitted = await canClaimInvitationGrants(services.db, {
      orgId: scope.organization.id,
      invitationId: body.claimInvitationId,
      userId,
    });

    if (!permitted) {
      throw errors.forbidden(
        'That invitation was not accepted by this account, so its keys are not yours to claim.',
      );
    }
  }

  try {
    const added = await addEnvKeyGrants(services.db, {
      orgId: scope.organization.id,
      environmentId: scope.environment.id,
      envDataKeyId: body.envDataKeyId,
      signedByUserId: userId,
      grants: body.grants.map(toGrantSeed),
      claimInvitationId: body.claimInvitationId ?? null,
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
 *
 * ── Takes an executor, not a service context ──
 * Because the two statements are one act. Run separately they can half-happen:
 * the grants go, the process dies, and the queued row survives as an instruction
 * to re-seal a key to somebody who was just cut off. The caller passes the
 * transaction it is already inside — `reconcileMemberKeyAccess` runs the whole
 * reconciliation in one — so the pair commits together or not at all.
 */
export async function revokeMemberAccess(
  exec: Executor,
  params: { orgId: string; environmentId: string; userId: string },
): Promise<number> {
  const removed = await removeMemberGrantsForEnvironment(exec, params);

  await removePendingKeyGrant(exec, {
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
  exec: Executor,
  params: { environmentId: string; targetUserId: string; requestedBy: string },
): Promise<boolean> {
  return queuePendingKeyGrant(exec, params);
}

/** The two directions in which an environment's grants can be out of step. */
interface KeyHygiene {
  /**
   * Somebody holds the active key who should not — a grant was deleted, a token
   * was revoked or expired, and no rotation has followed.
   */
  needsRotation: boolean;
  /**
   * Somebody may read the environment and holds no key for it. The opposite
   * direction, and until now nothing anywhere reported it.
   */
  missingGrants: MissingGrantPayload[];
}

/**
 * Compares who holds the active key against who the authorization model says
 * should — **in both directions**.
 *
 * ── Why one direction was not enough ──
 * `needsRotation` asked only "is there a holder the model does not name?", which
 * catches a revocation waiting for its rotation and nothing else. The opposite
 * asymmetry is just as real and was invisible from every screen in the product: a
 * member who is entitled to an environment and holds no grant can list every
 * secret name and decrypt none of them. A vault reset produces exactly that state
 * for every environment at once, and so does an acceptance whose re-seal never
 * completed. Nobody was told — not the person, not an administrator, not the
 * audit log.
 *
 * `missingGrants` is that answer. It is not a duplicate of `pendingGrants`: the
 * queue records that somebody *asked* for a share, and this is derived from the
 * rows themselves, so it is still right when the request was never recorded or
 * was deleted by a path that should not have deleted it. The queue is an intent;
 * this is the state.
 *
 * Derived rather than stored, both of them, for the reason a stored flag always
 * fails: it is a second source of truth about something the rows already
 * determine, and it can be left set by a failed write or cleared by one that
 * rotated nothing.
 */
async function keyHygiene(
  exec: Executor,
  scope: EnvironmentScope,
  activeKeyId: string,
): Promise<KeyHygiene> {
  const holders = await listGrantsForEnvironment(exec, scope.organization.id, scope.environment.id);

  const entitled = await entitledPrincipals(exec, scope);
  const required = toPrincipalKeys(entitled);

  const held = new Set(
    holders
      .filter((grant) => grant.envDataKeyId === activeKeyId)
      .map((grant) => principalKey(grant.recipientKind, grant.recipientId)),
  );

  const needsRotation = holders.some(
    (grant) =>
      grant.envDataKeyId === activeKeyId &&
      // An invitation grant is not held by anybody yet — it is a key waiting for
      // somebody who has not signed in. It is deleted at acceptance rather than
      // rotated away, so counting it as a stale holder would report every
      // outstanding invitation as a pending revocation.
      grant.recipientKind !== 'invite' &&
      !required.has(principalKey(grant.recipientKind, grant.recipientId)),
  );

  const missingGrants: MissingGrantPayload[] = [
    ...entitled.memberUserIds
      .filter((userId) => !held.has(principalKey('member', userId)))
      .map((userId) => ({ kind: 'member' as const, id: userId })),
    ...entitled.tokens
      .filter((token) => !held.has(principalKey('token', token.id)))
      .map((token) => ({ kind: 'token' as const, id: token.id })),
  ];

  return { needsRotation, missingGrants };
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
 * **Service tokens** are those pinned to this environment that are live and still
 * have a public key. Revoked, expired and keyless tokens are all excluded by
 * `listSealableServiceTokens`, because none of them can be sealed to and
 * demanding a grant for one blocks every rotation of the environment for ever.
 *
 * **Invitations** are not required. An invitation's grants are sealed to a
 * one-off keypair whose private half exists only in a fragment the server has
 * never seen, so nobody rotating a key can re-seal to it. The correct handling is
 * that the invitation's grants become stale and its holder re-runs the flow,
 * which is why they are permitted in a set but never demanded.
 */
function toPrincipalKeys(entitled: EntitledPrincipals): Set<string> {
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

/**
 * Everyone entitled to this environment, exhaustively, in three statements.
 *
 * ── What was wrong with the loop this replaces ──
 * It read one page of the roster — two hundred members, the clamp's ceiling, with
 * `hasMore` discarded — and then issued two queries per member. Both halves were
 * faults, and the first was the dangerous one. At two hundred and one members the
 * answer stopped being *the set* and became *a page of it*: everybody past the
 * boundary was absent from `requiredPrincipals`, so a rotation either refused
 * (they were classified surplus) or, through `sealingRecipients`, quietly dropped
 * them from the list a client seals to. A silent revocation produced by the very
 * check that exists to prevent silent revocations.
 *
 * There is no pagination here now, and that is not an oversight to be tidied
 * later: an incomplete answer to this question is worse than a slow one by a
 * margin that is not close. `loadOrganizationAuthorizationContexts` reads the
 * active roster and its access grants in two bulk statements — narrowed to this
 * project, because `resolveAccessLevel` consults no other — and `can()` then runs
 * in memory, per member, with no round trip. Same decision procedure as every
 * request in the system; the only thing that changed is where the rows come from.
 */
async function entitledPrincipals(
  exec: Executor,
  scope: EnvironmentScope,
): Promise<EntitledPrincipals> {
  const contexts = await loadOrganizationAuthorizationContexts(exec, {
    orgId: scope.organization.id,
    projectId: scope.environment.projectId,
  });

  const memberUserIds: string[] = [];

  for (const context of contexts) {
    const decision = can(
      { kind: 'user', userId: context.userId, orgId: scope.organization.id },
      READ_KEYS,
      {
        kind: 'environment',
        orgId: scope.organization.id,
        projectId: scope.environment.projectId,
        environmentId: scope.environment.id,
      },
      { membership: toGrantContext(context), isProduction: scope.environment.isProduction },
    );

    if (decision.allowed) memberUserIds.push(context.userId);
  }

  const tokens = await listSealableServiceTokens(exec, scope.organization.id, scope.environment.id);

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

  const entitled = await entitledPrincipals(services.db, scope);

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
  exec: Executor,
  scope: EnvironmentScope,
  grants: readonly GrantRequest[],
): Promise<void> {
  const required = toPrincipalKeys(await entitledPrincipals(exec, scope));

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
 * The recipient-side check `addGrants` describes, and — since a rotation may
 * carry invite grants — the one `rotateKeys` runs over its own set.
 */
async function assertRecipientEligible(
  exec: Executor,
  scope: EnvironmentScope,
  grant: GrantRequest,
): Promise<void> {
  if (grant.recipientKind === 'invite') {
    // Two questions, and until now only the first was asked.
    //
    // **Is this invitation ours and still open?** Without it, a member of one
    // organisation could seal their environment's key to an invitation belonging
    // to another and the invitee would decrypt it on acceptance somewhere else
    // entirely. An expired or revoked invitation is refused for the plainer
    // reason that nobody will ever open the grant: acceptance is what consumes
    // it, and a closed invitation is never accepted.
    //
    // **Will the invitee actually be allowed in here?** This is the one that was
    // missing, and its absence was a privilege escalation dressed as
    // convenience: any member with `secret.read` on an environment could seal its
    // key to *any* open invitation, and the invitee would arrive holding key
    // bytes for an environment the role and selection they were invited under
    // never entitled them to. They would be denied by every route that reads
    // secrets and would hold the key anyway — which is the wrong way round, since
    // the key is the thing routes cannot take back.
    const invitation = await findPendingInvitationForGrant(
      exec,
      scope.organization.id,
      grant.recipientId,
    );
    if (invitation === null || !invitationReaches(invitation, scope)) {
      throw errors.badRequest('That invitation cannot hold a key for this environment.');
    }
    return;
  }

  if (grant.recipientKind === 'token') {
    const tokens = await listSealableServiceTokens(
      exec,
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
        'That service token cannot hold a key for this environment. It may be revoked, expired, scoped elsewhere, or created before token keypairs existed.',
      );
    }
    return;
  }

  const context = await loadAuthorizationContext(exec, {
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
 * Whether accepting this invitation would let its holder read the environment.
 *
 * ── Why this can be decided before anybody joins ──
 * Because acceptance is deterministic. `applyInitialGrants` turns the invitation
 * into `access_grants` rows by a rule that is fixed at invitation time, so the
 * membership the invitee *will* have is computable now — and running the real
 * `can()` over it means this check and the one the invitee meets on their first
 * request are the same decision, rather than two rules that will drift.
 *
 * The rule, mirrored from `applyInitialGrants`:
 *
 *  - `initialGrants === null` is the pre-selection shape: role defaults
 *    everywhere, so the answer is `can()` with no grants at all.
 *  - otherwise it is **deny-by-default**. Every project gets an explicit `none`
 *    unless it was selected; a selected project or environment gets the invited
 *    role's *non-production* level. Production is therefore reachable only by
 *    having been ticked explicitly, which is the conscious act the schema comment
 *    demands — and the reason this check matters most on exactly the environments
 *    where handing out a key is worst.
 *
 * `memberStatus: 'active'` because that is what `addMember` writes. An
 * invitation cannot produce a suspended member.
 */
function invitationReaches(
  invitation: PendingInvitationForGrant,
  scope: EnvironmentScope,
): boolean {
  const projectId = scope.environment.projectId;
  const environmentId = scope.environment.id;

  const grants: ResolvedGrant[] = [];

  if (invitation.initialGrants !== null) {
    // The level a selection confers. Deliberately the non-production default:
    // `applyInitialGrants` writes exactly this, so an invitation that ticked a
    // production environment grants a level chosen without regard to the flag —
    // and `can()` still applies the production rule on top.
    const level = roleDefaultAccessLevel(invitation.role, false);

    const selectedEnvironment = invitation.initialGrants.some(
      (seed) => seed.projectId === projectId && seed.environmentId === environmentId,
    );
    const selectedProject = invitation.initialGrants.some(
      (seed) => seed.projectId === projectId && seed.environmentId === null,
    );

    if (selectedEnvironment) grants.push({ projectId, environmentId, accessLevel: level });
    grants.push({
      projectId,
      environmentId: null,
      accessLevel: selectedProject ? level : 'none',
    });
  }

  const membership: Membership = {
    role: invitation.role,
    memberStatus: 'active',
    grants,
  };

  return can(
    // The invitee has no user id yet, and `can()` does not consult one for a
    // membership decision — the id in the actor is there for the service-token
    // branch and for callers that log it.
    { kind: 'user', userId: invitation.id, orgId: scope.organization.id },
    READ_KEYS,
    {
      kind: 'environment',
      orgId: scope.organization.id,
      projectId,
      environmentId,
    },
    { membership, isProduction: scope.environment.isProduction },
  ).allowed;
}

/**
 * Refuses an initialisation whose grant is addressed to somebody else.
 *
 * At creation the only principal whose key could have sealed this blob is the
 * creator's own, so a grant naming anybody else was either fabricated or sealed
 * to a public key the creator had no business using. Neither is a state to store.
 *
 * Exported because environment *creation* writes a first grant too, through a
 * different route and a different repository function, and it needs the identical
 * rule. It did not have one: `POST …/environments` accepted a first grant
 * addressed to an arbitrary principal — any kind, any 36-character id — with the
 * foreign keys checking existence rather than tenancy. One assertion, used twice,
 * is the only shape in which the two cannot disagree.
 */
export function assertSelfGrant(grant: GrantRequest, userId: string): void {
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
