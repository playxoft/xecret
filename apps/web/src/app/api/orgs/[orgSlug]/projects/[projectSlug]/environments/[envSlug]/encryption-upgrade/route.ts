import { auditingDenials } from '@xecret/core/authz';
import type { Denial } from '@xecret/core/authz';
import {
  authorizeUpgrade,
  encryptionUpgradePreview,
  requireServerMode,
  requireUpgradingPerson,
  upgradeEncryption,
} from '@/server/encryption-upgrade';
import { json, parseJsonBody } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { encryptionUpgradeBody, MAX_UPGRADE_BODY_BYTES } from '@/server/schemas/encryption-upgrade';
import { enforceSecretRateLimit } from '@/server/secrets-service';
import { resolveEnvironmentPath } from '@/server/tenancy';
import type { EnvironmentScope } from '@/server/tenancy';

/**
 * Upgrading a `server`-mode environment to end-to-end encryption (ADR 0009,
 * Phase 5). `server/encryption-upgrade.ts` says why the browser does the work
 * and who may ask; this file is the two ends of it.
 *
 * `GET` is what the upgrade would do — counts, and the names of the deleted
 * secrets it erases and the CI tokens it revokes — so a person can decide, and
 * so the dashboard can tell an empty environment it may upgrade without asking
 * anybody. No value, no note: not audited as a read, and metered like one.
 *
 * `POST` is the upgrade: the re-encrypted environment, committed in one
 * transaction or not at all. Audited as `environment.encryption_upgraded` with
 * counts, `envkey.created` for the key it starts, and one record per secret it
 * erased and per token it revoked.
 */

interface Params {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
}

function environmentResource(scope: EnvironmentScope) {
  return {
    type: 'environment' as const,
    id: scope.environment.id,
    projectId: scope.project.id,
    environmentId: scope.environment.id,
  };
}

export const GET = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    await enforceSecretRateLimit(services, principal, 'read');

    auditingDenials(
      (decision: Denial) =>
        record(
          audit(scope.organization.id).denied(
            'environment.encryption_upgraded',
            environmentResource(scope),
            decision,
          ),
        ),
      () => authorizeUpgrade(scope),
    );

    return json({ upgrade: await encryptionUpgradePreview(scope, services, principal) });
  },
);

export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    const builder = audit(scope.organization.id);
    const resource = environmentResource(scope);
    await enforceSecretRateLimit(services, principal, 'write');

    const fileDenial = (decision: Denial) =>
      record(builder.denied('environment.encryption_upgraded', resource, decision));

    // Everything that does not depend on the body is refused before the body —
    // up to eight megabytes of it — is read at all.
    auditingDenials(fileDenial, () => authorizeUpgrade(scope));
    requireUpgradingPerson(principal);
    requireServerMode(scope);

    const body = await parseJsonBody(request, encryptionUpgradeBody, MAX_UPGRADE_BODY_BYTES);

    // Revoking CI tokens is an organisation-level act, asked only when the
    // upgrade has tokens to revoke. The transaction then checks the tokens named
    // are exactly the live keyless ones, so naming none cannot dodge it.
    auditingDenials(fileDenial, () =>
      authorizeUpgrade(scope, { revokesTokens: body.revokeTokenIds.length > 0 }),
    );

    const { result, outcome } = await upgradeEncryption(scope, services, principal, body);

    const context = {
      projectSlug: scope.project.slug,
      environmentSlug: scope.environment.slug,
      source: 'dashboard' as const,
    };

    record(
      builder.success('environment.encryption_upgraded', resource, {
        ...context,
        secretCount: outcome.secretCount,
        versionCount: outcome.versionCount,
        noteCount: outcome.noteCount,
        purgedSecretCount: outcome.erased.length,
        revokedTokenCount: outcome.revoked.length,
        keyVersion: outcome.dataKey.version,
      }),
      // The key's own origin, exactly as creation and the repair endpoint record
      // it: a key-history review starts from `envkey.created`, and an upgraded
      // environment's history starts here.
      builder.success('envkey.created', resource, {
        ...context,
        keyVersion: outcome.dataKey.version,
        grantCount: 1,
      }),
      ...outcome.erased.map((secret) =>
        builder.success(
          'secret.purged',
          {
            type: 'secret',
            id: secret.id,
            projectId: scope.project.id,
            environmentId: scope.environment.id,
          },
          { ...context, secretName: secret.name, reason: 'encryption-upgrade' },
        ),
      ),
      ...outcome.revoked.map((token) =>
        builder.success(
          'token.revoked',
          {
            type: 'token',
            id: token.id,
            projectId: scope.project.id,
            environmentId: scope.environment.id,
          },
          { ...context, tokenPrefix: token.tokenPrefix, reason: 'encryption-upgrade' },
        ),
      ),
    );

    return json({ upgraded: result });
  },
);
