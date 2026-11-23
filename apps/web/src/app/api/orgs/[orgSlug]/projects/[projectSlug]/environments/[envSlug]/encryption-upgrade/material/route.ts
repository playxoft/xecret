import { auditingDenials } from '@xecret/core/authz';
import type { Denial } from '@xecret/core/authz';
import {
  authorizeUpgrade,
  encryptionUpgradeMaterial,
  exportPolicyBlocks,
  exportPolicyRefusal,
} from '@/server/encryption-upgrade';
import { json } from '@/server/http';
import { noteEnvironmentRead } from '@/server/read-alerts';
import { authenticatedRoute } from '@/server/route';
import { auditSource, enforceSecretRateLimit } from '@/server/secrets-service';
import { resolveEnvironmentPath } from '@/server/tenancy';

/**
 * Every version of every live secret of a `server`-mode environment, decrypted,
 * with every note — handed to the browser that is about to re-encrypt them for
 * the environment's upgrade to end-to-end encryption (ADR 0009, Phase 5).
 *
 * ── Gated like the strongest read there is ──
 * This is more than any other route returns: not the current values but the
 * whole history. So it asks everything the upgrade asks (`environment.update`,
 * which is `admin` on the environment, plus the three secret actions), only of a
 * person in an unlocked browser session — a token, which could not complete the
 * upgrade, is refused before anything is decrypted — and only while the
 * environment is still `server`-mode, which is the only state in which there is
 * anything here to decrypt. Metered on `RL_SECRET_READ` like a reveal.
 *
 * ── Plaintext export disabled ──
 * Where the environment's policy disables plaintext export, this read is
 * reserved for an owner or admin of the organisation — see
 * `server/encryption-upgrade.ts` and `export-policy.ts` — and the record says
 * the policy was in force.
 *
 * ── Audited as the bulk read it is ──
 * `secret.read` with reason `encryption-upgrade`, the number of secrets and of
 * versions, recorded before the values leave — the same record `pull` and
 * `export` write, so "who read production on Tuesday" still finds it. A read
 * from an address the environment has not seen before raises the same alert a
 * pull would.
 */

interface Params {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
}

export const GET = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    const builder = audit(scope.organization.id);
    const resource = {
      type: 'environment' as const,
      id: scope.environment.id,
      projectId: scope.project.id,
      environmentId: scope.environment.id,
    };

    await enforceSecretRateLimit(services, principal, 'read');
    auditingDenials(
      (decision: Denial) => record(builder.denied('secret.read', resource, decision)),
      () => authorizeUpgrade(scope),
    );

    const context = {
      projectSlug: scope.project.slug,
      environmentSlug: scope.environment.slug,
      reason: 'encryption-upgrade',
      source: auditSource(principal),
      // The policy's state, whenever it applies — "this was read while plaintext
      // export was switched off" is the fact a reviewer of that policy needs.
      ...(scope.environment.plaintextExportDisabled
        ? { policyName: 'plaintextExport' as const, enabled: false }
        : {}),
    };

    // Plaintext export disabled: this read is the organisation's owners' and
    // admins' to make, not every environment admin's. Recorded as the policy
    // refusal every other export path files.
    if (scope.environment.encryptionMode === 'server' && exportPolicyBlocks(scope)) {
      record(builder.error('secret.read', resource, 'policyRefused', context));
      throw exportPolicyRefusal(scope);
    }

    const material = await encryptionUpgradeMaterial(scope, services, principal);

    record(
      builder.success('secret.read', resource, {
        ...context,
        secretCount: material.secrets.length,
        versionCount: material.secrets.reduce((total, secret) => total + secret.versions.length, 0),
      }),
    );
    noteEnvironmentRead(scope, services, principal);

    return json({ material });
  },
);
