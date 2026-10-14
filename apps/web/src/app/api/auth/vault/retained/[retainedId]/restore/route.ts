import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { restoreRetained } from '@/server/retained-vault-service';
import { authenticatedRoute } from '@/server/route';
import { retainedRestoreSchema } from '@/server/schemas/retained-vaults';
import { requireUserPrincipal } from '@/server/vault-service';

/**
 * Recovers a reset vault: writes its environment keys, re-sealed by the browser
 * to the current vault, as the account's member grants.
 *
 * Requires the proof that the retained vault's User Key was opened
 * (`ukUnlockVerifier`), counted against that vault's lockout. Skips — and says
 * so — keys the account already holds again, environments deleted since, and
 * environments it may no longer read.
 *
 * One `vault.recovered` record in each organisation that got keys back, so the
 * teammates who were asked to re-share can see why the request went away.
 */
export const POST = authenticatedRoute<{ retainedId: string }>(
  async ({ request, params, principal, services, audit, record }) => {
    const user = requireUserPrincipal(principal);
    await enforce(services.env, 'RL_LOGIN', rateLimitKey(['vault_retained', user.user.id]));

    const body = await parseJsonBody(request, retainedRestoreSchema);
    const result = await restoreRetained(services, user, params.retainedId, body);

    const byOrg = new Map<string, number>();
    for (const restored of result.restored) {
      byOrg.set(restored.orgId, (byOrg.get(restored.orgId) ?? 0) + 1);
    }
    for (const [orgId, grantCount] of byOrg) {
      record(
        audit(orgId).success(
          'vault.recovered',
          { type: 'user', id: user.user.id },
          { source: 'dashboard', grantCount },
        ),
      );
    }

    return json({
      restored: result.restored.length,
      skipped: result.skipped,
    });
  },
);
