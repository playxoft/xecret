import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { recoveryCompleteSchema } from '@/server/schemas/vault';
import {
  completeRecovery,
  primaryOrgId,
  requireUserPrincipal,
  vaultMaterial,
  vaultStatus,
} from '@/server/vault-service';

/**
 * Completing a recovery: redeem the code, set a new passphrase, and reissue the
 * whole kit — one request, one transaction.
 *
 * ── Why all three happen together ──
 * They are inseparable, and the UI cannot be allowed to skip a step. Somebody
 * here has lost control of their passphrase, so stopping at "you are in" would
 * leave an account whose only credential is a piece of paper. Reissuing every
 * code follows from a fact about the design rather than a policy choice: all
 * five wraps hold the same User Key, so a kit with one code spent is a kit that
 * four other pieces of paper still open.
 *
 * The redeemed code is marked used inside the same transaction, under a
 * `used_at IS NULL` guard — which is the concurrency boundary. Two requests
 * redeeming the same code race on that row and exactly one wins; a
 * read-then-write would let both through, and both would then reissue a set,
 * leaving whichever finished second holding the only live codes.
 *
 * `allowLocked`, because a locked session is the only kind that ever arrives
 * here. The current passphrase is deliberately *not* required: the recovery code
 * is the proof, and demanding the passphrase would defeat the entire purpose.
 *
 * Rate limited on the same `vault_recovery` counter as the begin step — the two
 * halves are one flow and one budget describes it. Still limited rather than
 * exempted: the single-use code is not a rate limit, since every call reaches a
 * digest comparison and a database lookup before anything decides the code is
 * unknown.
 */
export const POST = authenticatedRoute(
  async ({ request, principal, services, audit, record }) => {
    const user = requireUserPrincipal(principal);

    await enforce(services.env, 'RL_LOGIN', rateLimitKey(['vault_recovery', user.user.id]));

    const body = await parseJsonBody(request, recoveryCompleteSchema);
    await completeRecovery(services, user, body);

    const orgId = await primaryOrgId(services, user.user.id);
    if (orgId !== null) {
      // Two records, not one, because two things happened and an incident review
      // asks about them separately: "was a recovery code used on this account?"
      // and "when was this kit last replaced?". Collapsing them into one event
      // would make the second question unanswerable for every account that has
      // ever recovered.
      record(
        audit(orgId).success(
          'vault.recovery_used',
          { type: 'user', id: user.user.id },
          { source: 'dashboard', wrapKind: 'recovery' },
        ),
        audit(orgId).success(
          'vault.recovery_codes_regenerated',
          { type: 'user', id: user.user.id },
          {
            source: 'dashboard',
            reason: 'forced by recovery',
            recoveryCodeCount: body.recoveryWraps.length,
          },
        ),
      );
    }

    const now = new Date();
    return json({
      vault: await vaultStatus(services, { ...user, vaultUnlockedAt: now }, now),
      material: await vaultMaterial(services, user),
    });
  },
  { allowLocked: true },
);
