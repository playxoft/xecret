import type { Action } from '@xecret/core/authz';
import { fromBase64Url } from '@xecret/core/crypto';
import {
  EncryptionUpgradeConflict,
  isTransactionRace,
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
  countOtherEntitledPrincipals,
  queueSharesForEntitledMembers,
  requireSealingUser,
} from './env-keys-service';
import { errors } from './errors';
import { mayActOn } from './references-service';
import { toGrantSeed } from './schemas/env-keys';
import {
  estimateUpgradeBodyBytes,
  MAX_UPGRADE_BODY_BYTES,
  MAX_UPGRADE_VERSIONS,
} from './schemas/encryption-upgrade';
import type {
  EncryptionUpgradeBody,
  EncryptionUpgradeMaterial,
  EncryptionUpgradePreview,
  EncryptionUpgradeResult,
  UpgradeBlocker,
} from './schemas/encryption-upgrade';
import { encodeBlob } from './schemas/vault';
import { decryptEnvironmentHistory } from './secrets-service';
import { authorize } from './tenancy';
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
 * functions every end-to-end encrypted write uses, and opens everything it
 * produced before it sends any of it.
 *
 * ── The three requests ──
 *  - `GET …/encryption-upgrade` — whether this caller can upgrade, and if they
 *    may, what it would do: how much it re-encrypts, which deleted secrets it
 *    erases, which CI tokens stop working, how many others need the key. No
 *    value, no refusal, no audit record and no rate-limit spend: the dashboard
 *    asks it on every view of a `server`-mode environment, and a member who
 *    lacks some permission is answered `canUpgrade: false` with the reasons.
 *  - `GET …/encryption-upgrade/material` — every version of every live secret,
 *    decrypted, and every note: the strongest read there is, gated as one,
 *    metered as one, and audited as a bulk read with reason `encryption-upgrade`.
 *  - `POST …/encryption-upgrade` — the re-encrypted environment, committed in
 *    one transaction or not at all (`upgradeEnvironmentEncryption`).
 *
 * ── Who may ──
 * A **person, in a browser session** (the route wrapper refuses a locked one)
 * **with a vault**: the key is generated in their browser, sealed to their
 * vault's public key and signed with its signing key, none of which a bearer
 * token holds. They need `environment.update` — `admin` on the environment, the
 * gate key initialisation and rotation already use — and the three secret
 * actions an upgrade performs: `secret.read` (it reads every value),
 * `secret.update` (it rewrites every one) and `secret.delete` (it erases the
 * deleted ones). A custom role that kept `environment.update` and dropped any of
 * those is refused. Revoking CI tokens is `token.revoke`, an organisation-level
 * act, asked only when there are tokens to revoke: an environment admin who
 * could not otherwise revoke a token must not be able to through this door.
 *
 * ── Plaintext export disabled ──
 * The material read hands a browser every value an environment has ever held,
 * in plaintext — more than `xecret pull` would. It is **not** refused where the
 * environment's policy disables plaintext export, and no stricter gate is put
 * in front of it there either: the policy is switched by `environment.update`,
 * which everybody who may upgrade already holds, so any such gate would be a
 * switch the person it stops could turn off, upgrade, and turn back on. What
 * the policy does change is what is recorded and who is told: both records of
 * the upgrade carry the policy's state, and the read raises the environment's
 * new-address read alert even where alerts were left at their default. The
 * values go into the upgrading browser's memory and leave it only as
 * ciphertext, never as a file. See `export-policy.ts`.
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

/**
 * The export policy's state, as both upgrade records carry it: `enabled` is
 * whether plaintext export is allowed here — `false` where the policy disables
 * it, which is the case a reviewer of that policy is looking for.
 */
export function exportPolicyState(scope: EnvironmentScope) {
  return {
    policyName: 'plaintextExport' as const,
    enabled: !scope.environment.plaintextExportDisabled,
  };
}

/**
 * Whether this caller can upgrade the environment, and — only if they hold the
 * permissions an upgrade needs — what it would do.
 *
 * Never throws for a missing permission, never audits, never meters: see the
 * header. The obligations (token names, deleted secret names) are returned only
 * to a caller who could act on them, because they name things the caller may
 * otherwise not see.
 */
export async function encryptionUpgradePreview(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
): Promise<EncryptionUpgradePreview> {
  const base = {
    encryptionMode: scope.environment.encryptionMode === 'e2ee' ? 'e2ee' : 'server',
    environmentId: scope.environment.id,
  } as const;

  if (scope.environment.encryptionMode !== 'server') {
    return { ...base, canUpgrade: false, reasons: ['already-e2ee'], details: null };
  }
  if (principal.kind !== 'user') {
    return { ...base, canUpgrade: false, reasons: ['not-a-person'], details: null };
  }
  const permitted = UPGRADE_ACTIONS.every((action) =>
    mayActOn(scope, principal, scope.environment, action),
  );
  if (!permitted) {
    return { ...base, canUpgrade: false, reasons: ['not-permitted'], details: null };
  }

  const obligations = await loadEncryptionUpgradeObligations(
    services.db,
    scope.organization.id,
    scope.environment.id,
  );
  const otherEntitledCount = await countOtherEntitledPrincipals(
    services.db,
    scope,
    principal.user.id,
  );

  const reasons: UpgradeBlocker[] = [];
  if (!(await callerHasVault(services, principal))) reasons.push('no-vault');
  if (
    obligations.keylessTokens.length > 0 &&
    !mayActOn(scope, principal, scope.environment, 'token.revoke')
  ) {
    reasons.push('token-revoke');
  }

  return {
    ...base,
    canUpgrade: reasons.length === 0,
    reasons,
    details: {
      liveSecretCount: obligations.liveSecretCount,
      versionCount: obligations.versionCount,
      noteCount: obligations.noteCount,
      deletedSecrets: obligations.deletedSecrets,
      keylessTokens: obligations.keylessTokens,
      otherEntitledCount,
    },
  };
}

/**
 * Every value the upgrading browser has to re-encrypt, decrypted.
 *
 * The caller is authorised, the mode checked, the vault required and the
 * export policy applied *before* anything is decrypted, so the decryption
 * happens only for somebody who may perform the upgrade it feeds. The route
 * applies the policy first, so a refusal is recorded; this applies it again.
 * `decryptEnvironmentHistory` is the server half of `secrets-service.ts` doing
 * its last job for this environment.
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

  // Measured before anything is decrypted: a history the POST would refuse as
  // too large — by count, or by the bytes its re-encrypted form would take — is
  // not worth handing to a browser in plaintext first.
  const obligations = await loadEncryptionUpgradeObligations(
    services.db,
    scope.organization.id,
    scope.environment.id,
  );
  if (
    obligations.versionCount > MAX_UPGRADE_VERSIONS ||
    estimateUpgradeBodyBytes(obligations) > MAX_UPGRADE_BODY_BYTES
  ) {
    throw errors.tooLarge(
      'This environment holds more history than one upgrade can carry ' +
        `(${MAX_UPGRADE_VERSIONS} secret versions, or ${MAX_UPGRADE_BODY_BYTES / (1024 * 1024)} MB ` +
        're-encrypted). Nothing was read. Contact support.',
    );
  }

  const history = await decryptEnvironmentHistory(scope, services);

  return {
    // The organisation id is the first component of every AAD the browser is
    // about to build. Stated here so it can be compared with the organisation
    // the browser resolved for itself — a material read answered for another
    // organisation's environment would otherwise be re-encrypted, faithfully,
    // under the wrong one.
    orgId: scope.organization.id,
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
 * property of the stored world — that the set is complete and current, that
 * every note crossed, that the grant is sealed to the caller's current vault
 * key — is checked inside the transaction, under its locks, where it cannot go
 * stale.
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
    throw errors.tooLarge(
      `One upgrade cannot rewrite more than ${MAX_UPGRADE_VERSIONS} versions. Contact support.`,
    );
  }
}

const RETRY =
  'version_conflict: this environment changed while it was being upgraded. Nothing was ' +
  'changed — start the upgrade again to re-encrypt what it holds now.';

const REFUSALS: Readonly<Record<EncryptionUpgradeRefusal, string>> = {
  'already-e2ee': 'already_e2ee: this environment is already end-to-end encrypted.',
  stale: RETRY,
  'deleted-changed':
    'version_conflict: a secret in this environment was deleted or restored while it was being ' +
    'upgraded. Nothing was changed — start the upgrade again.',
  'tokens-changed':
    'version_conflict: the CI tokens of this environment changed while it was being upgraded. ' +
    'Nothing was changed — start the upgrade again.',
  inconsistent:
    'upgrade_unsupported: this environment holds rows this upgrade cannot vouch for. Nothing ' +
    'was changed. Contact support.',
  'grant-key':
    'grant_key_mismatch: the new key was not sealed to your vault’s current public key — a ' +
    'vault reset in another tab, or a page out of date. Nothing was changed. Reload and try again.',
  notes:
    'notes_mismatch: a note was missing from the upgrade, or one was sent for a secret that has ' +
    'none. Nothing was changed. Reload and try again.',
};

/**
 * A repository refusal as the API says it: fixed strings, keyed by a stable
 * word, never the repository's own message.
 */
function mapUpgradeError(cause: unknown): unknown {
  if (cause instanceof EncryptionUpgradeConflict) return errors.conflict(REFUSALS[cause.refusal]);
  // PostgreSQL broke a deadlock or a serialisation conflict by abandoning this
  // transaction. Nothing was written, and the same upgrade again is correct.
  if (isTransactionRace(cause)) return errors.conflict(RETRY);
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
