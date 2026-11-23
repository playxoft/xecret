import { can } from '@xecret/core/authz';
import type { Action } from '@xecret/core/authz';
import { fromBase64Url } from '@xecret/core/crypto';
import {
  EncryptionUpgradeConflict,
  loadEncryptionUpgradeObligations,
  RepositoryError,
  upgradeEnvironmentEncryption,
} from '@xecret/db/repositories';
import type { EncryptionUpgradeRefusal, UpgradeEnvironmentResult } from '@xecret/db/repositories';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import {
  assertSelfGrant,
  callerHasVault,
  queueSharesForEntitledMembers,
  requireSealingUser,
} from './env-keys-service';
import { errors } from './errors';
import { toGrantSeed } from './schemas/env-keys';
import { MAX_UPGRADE_VERSIONS } from './schemas/encryption-upgrade';
import type {
  EncryptionUpgradeBody,
  EncryptionUpgradeMaterial,
  EncryptionUpgradePreview,
  EncryptionUpgradeResult,
} from './schemas/encryption-upgrade';
import { encodeBlob } from './schemas/vault';
import { decryptEnvironmentHistory } from './secrets-service';
import { authorize, toGrantContext } from './tenancy';
import type { EnvironmentScope } from './tenancy';

/**
 * Upgrading a `server`-mode environment to end-to-end encryption, in place —
 * Phase 5 of ADR 0009, the step that ends the one exception to "we cannot read
 * your secrets".
 *
 * ── Why the browser does it, and the server cannot ──
 * The new key has to be born on a member's device (ADR 0009), and the first
 * grant has to carry that member's Ed25519 signature (`env_key_grants.signature`
 * is NOT NULL). A server-side script could do neither honestly: it would be
 * generating a key it then held, and signing a grant in somebody's name. So the
 * server does the two things only it can — hand over the values it can still
 * decrypt, once, to somebody entitled to them, and then check and commit what
 * comes back — and the browser does the cryptography in between, with the same
 * functions every end-to-end encrypted write uses.
 *
 * ── The three requests ──
 *  - `GET …/encryption-upgrade` — what an upgrade would do: how much it
 *    re-encrypts, which deleted secrets it erases, which CI tokens stop working.
 *    No value. What the dialog shows, and what decides whether an empty
 *    environment can be upgraded without asking anybody.
 *  - `GET …/encryption-upgrade/material` — every version of every live secret,
 *    decrypted, and every note: the strongest read there is, gated as one and
 *    audited as a bulk read with reason `encryption-upgrade`.
 *  - `POST …/encryption-upgrade` — the re-encrypted environment, committed in
 *    one transaction or not at all (`upgradeEnvironmentEncryption`).
 *
 * ── Who may ──
 * A **person, in a browser session** (the route wrapper refuses a locked one):
 * the key is generated in their browser, sealed to their vault's public key and
 * signed with its signing key, none of which a bearer token holds. They need
 * `environment.update` — `admin` on the environment, the gate key initialisation
 * and rotation already use — and the three secret actions an upgrade performs:
 * `secret.read` (it reads every value), `secret.update` (it rewrites every one)
 * and `secret.delete` (it erases the deleted ones). A custom role that kept
 * `environment.update` and dropped any of those is refused. Revoking CI tokens
 * is `token.revoke`, an organisation-level act, and is asked only when there are
 * tokens to revoke: an environment admin who could not otherwise revoke a
 * token must not be able to through this door.
 */

const UPGRADE_ACTIONS: readonly Action[] = [
  'environment.update',
  'secret.read',
  'secret.update',
  'secret.delete',
];

/**
 * Refuses a caller who may not upgrade this environment, as the route's audit
 * wrapper expects: by throwing the `AuthorizationError` `authorize` throws.
 *
 * Called by the routes inside `auditingDenials`, so a refusal is recorded, and
 * again by every function below, so a route that forgot it would still be
 * refused — the rule `env-keys-service.ts` keeps for the same reason.
 */
export function authorizeUpgrade(
  scope: EnvironmentScope,
  options: { revokesTokens: boolean } = { revokesTokens: false },
): void {
  for (const action of UPGRADE_ACTIONS) authorize(scope, action);
  if (options.revokesTokens) authorize(scope, 'token.revoke');
}

/** The person upgrading, or a 403 for a token — see the header. */
export function requireUpgradingPerson(principal: Principal): string {
  return requireSealingUser(principal);
}

/** Refuses a person whose account has no vault: there is no public key to seal the new key to. */
async function requireVault(services: ServiceContext, principal: Principal): Promise<void> {
  if (!(await callerHasVault(services, principal))) {
    throw errors.badRequest(
      'Set up your vault before upgrading an environment: its new key is sealed to your public key.',
    );
  }
}

/** Refuses an environment that is already end-to-end encrypted. */
export function requireServerMode(scope: EnvironmentScope): void {
  if (scope.environment.encryptionMode !== 'server') {
    throw errors.conflict('already_e2ee: this environment is already end-to-end encrypted.');
  }
}

/** Whether the caller holds `action` here, without throwing. */
function allowed(scope: EnvironmentScope, action: Action): boolean {
  return can(
    scope.actor,
    action,
    {
      kind: 'environment',
      orgId: scope.organization.id,
      projectId: scope.environment.projectId,
      environmentId: scope.environment.id,
    },
    {
      membership: scope.membership ? toGrantContext(scope.membership) : undefined,
      isProduction: scope.environment.isProduction,
    },
  ).allowed;
}

/**
 * What an upgrade would do here, and whether this caller may do it.
 *
 * Authorised like the upgrade itself, because the answer names the CI tokens
 * pinned to the environment and the secrets deleted from it. Returns no value
 * and no note, so it is not audited as a read — the material endpoint is.
 */
export async function encryptionUpgradePreview(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
): Promise<EncryptionUpgradePreview> {
  requireUpgradingPerson(principal);
  authorizeUpgrade(scope);
  requireServerMode(scope);

  const obligations = await loadEncryptionUpgradeObligations(
    services.db,
    scope.organization.id,
    scope.environment.id,
  );
  const hasVault = await callerHasVault(services, principal);
  const mayRevoke = obligations.keylessTokens.length === 0 || allowed(scope, 'token.revoke');

  return {
    encryptionMode: 'server',
    environmentId: scope.environment.id,
    liveSecretCount: obligations.liveSecretCount,
    versionCount: obligations.versionCount,
    noteCount: obligations.noteCount,
    deletedSecrets: obligations.deletedSecrets,
    keylessTokens: obligations.keylessTokens,
    mayUpgrade: hasVault && mayRevoke,
    blockedBy: !hasVault ? 'no-vault' : !mayRevoke ? 'token-revoke' : null,
  };
}

/**
 * Every value the upgrading browser has to re-encrypt, decrypted.
 *
 * The caller is authorised and the environment's mode checked *before*
 * anything is decrypted, so the decryption happens only for somebody who may
 * perform the upgrade it feeds. `decryptEnvironmentHistory` is the server half
 * of `secrets-service.ts` doing its last job for this environment.
 */
export async function encryptionUpgradeMaterial(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
): Promise<EncryptionUpgradeMaterial> {
  requireUpgradingPerson(principal);
  authorizeUpgrade(scope);
  requireServerMode(scope);
  // Somebody with no vault could not complete the upgrade this read feeds —
  // there is nothing to seal the new key to — so nothing is decrypted for them.
  await requireVault(services, principal);

  const history = await decryptEnvironmentHistory(scope, services);
  const obligations = await loadEncryptionUpgradeObligations(
    services.db,
    scope.organization.id,
    scope.environment.id,
  );

  return {
    environmentId: scope.environment.id,
    secrets: history.map((secret) => ({
      id: secret.secretId,
      name: secret.name,
      valueType: secret.valueType,
      note: secret.note,
      revision: secret.revision,
      versions: secret.versions.map((version) => ({
        id: version.versionId,
        version: version.version,
        value: version.value,
      })),
    })),
    deletedSecrets: obligations.deletedSecrets,
    keylessTokens: obligations.keylessTokens,
  };
}

/**
 * Checks the re-encrypted environment and commits it.
 *
 * What is checked here, before the transaction, is everything that is a
 * property of the request alone: the grant is the caller's own (the rule
 * creation and the repair endpoint apply), every value names the key this
 * request is creating, and no secret or version is listed twice. What is a
 * property of the stored world — that the set is complete and current — is
 * checked inside the transaction, under its locks, where it cannot go stale.
 */
export async function upgradeEncryption(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
  body: EncryptionUpgradeBody,
): Promise<{ result: EncryptionUpgradeResult; outcome: UpgradeEnvironmentResult }> {
  const userId = requireUpgradingPerson(principal);
  authorizeUpgrade(scope, { revokesTokens: body.revokeTokenIds.length > 0 });
  requireServerMode(scope);

  await requireVault(services, principal);

  assertSelfGrant(body.keys.grant, userId);
  assertWellFormedSet(body);

  try {
    const outcome = await upgradeEnvironmentEncryption(services.db, {
      orgId: scope.organization.id,
      environmentId: scope.environment.id,
      createdBy: userId,
      dataKeyId: body.envDataKeyId,
      grant: toGrantSeed(body.keys.grant),
      secrets: body.secrets.map((secret) => ({
        id: secret.id,
        revision: secret.revision,
        encNote: secret.encNote === null ? null : encodeBlob(secret.encNote),
        versions: secret.versions.map((version) => ({
          id: version.id,
          version: version.version,
          ciphertext: encodeBlob(version.value.ciphertext),
          clientAlgorithm: version.value.clientAlgorithm,
          valueHmac: fromBase64Url(version.value.valueHmac),
        })),
      })),
      eraseSecretIds: body.eraseSecretIds,
      revokeTokenIds: body.revokeTokenIds,
      // Inside the transaction, after the mode has flipped: everybody else who
      // may read the environment is owed the key the upgrader alone now holds.
      afterUpgrade: async (tx) => {
        await queueSharesForEntitledMembers(tx, scope, userId);
      },
    });

    return {
      outcome,
      result: {
        activeEdk: { id: outcome.dataKey.id, version: outcome.dataKey.version },
        secretCount: outcome.secretCount,
        versionCount: outcome.versionCount,
        noteCount: outcome.noteCount,
        erasedSecretCount: outcome.erased.length,
        revokedTokenCount: outcome.revoked.length,
      },
    };
  } catch (cause) {
    throw mapUpgradeError(cause);
  }
}

/**
 * The checks a request can fail on its own, before any row is read.
 *
 * Each is a 422 rather than a 409: nothing raced, the body is simply not a
 * coherent upgrade. A value sealed against a key other than the one this
 * request creates would be stored looking like a working row and open for
 * nobody — the failure `prepareClientWrite` guards on the ordinary path — and a
 * secret or version listed twice would make the completeness check meaningless.
 */
function assertWellFormedSet(body: EncryptionUpgradeBody): void {
  const secretIds = new Set<string>();
  let versionTotal = 0;

  for (const secret of body.secrets) {
    if (secretIds.has(secret.id)) {
      throw errors.validation([{ field: 'secrets', message: 'A secret is listed twice.' }]);
    }
    secretIds.add(secret.id);

    const versionIds = new Set<string>();
    const versionNumbers = new Set<number>();
    for (const version of secret.versions) {
      if (versionIds.has(version.id) || versionNumbers.has(version.version)) {
        throw errors.validation([
          { field: 'secrets', message: 'A version of a secret is listed twice.' },
        ]);
      }
      versionIds.add(version.id);
      versionNumbers.add(version.version);

      if (version.value.envDataKeyId !== body.envDataKeyId) {
        throw errors.validation([
          {
            field: 'secrets',
            message: 'Every value must be sealed against the key this upgrade creates.',
          },
        ]);
      }
    }
    versionTotal += secret.versions.length;
  }

  if (versionTotal > MAX_UPGRADE_VERSIONS) {
    throw errors.tooLarge(`One upgrade cannot rewrite more than ${MAX_UPGRADE_VERSIONS} versions.`);
  }
}

const REFUSALS: Readonly<Record<EncryptionUpgradeRefusal, string>> = {
  'already-e2ee': 'already_e2ee: this environment is already end-to-end encrypted.',
  stale:
    'version_conflict: this environment changed while it was being upgraded. Nothing was ' +
    'changed — start the upgrade again to re-encrypt what it holds now.',
  'deleted-changed':
    'version_conflict: a secret in this environment was deleted or restored while it was being ' +
    'upgraded. Nothing was changed — start the upgrade again.',
  'tokens-changed':
    'version_conflict: the CI tokens of this environment changed while it was being upgraded. ' +
    'Nothing was changed — start the upgrade again.',
  inconsistent:
    'upgrade_unsupported: this environment holds rows this upgrade cannot vouch for. Nothing ' +
    'was changed. Contact support.',
};

/**
 * A repository refusal as the API says it: fixed strings, keyed by a stable
 * word, never the repository's own message.
 */
function mapUpgradeError(cause: unknown): unknown {
  if (cause instanceof EncryptionUpgradeConflict) return errors.conflict(REFUSALS[cause.refusal]);
  if (!(cause instanceof RepositoryError)) return cause;

  switch (cause.code) {
    case 'notFound':
      return errors.notFound('environment not found for upgrade');
    case 'conflict':
      // A data key that already exists, or a client-chosen key id already
      // taken: both are "somebody got here first", and both mean nothing was
      // written.
      return errors.conflict(
        'version_conflict: this environment was changed by another request while it was being ' +
          'upgraded. Nothing was changed — start the upgrade again.',
      );
    default:
      return errors.badRequest('The upgrade could not be applied to this environment.');
  }
}
