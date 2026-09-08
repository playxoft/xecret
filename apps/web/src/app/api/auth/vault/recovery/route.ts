import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { recoveryBeginSchema, recoveryRegenerateSchema } from '@/server/schemas/vault';
import {
  beginRecovery,
  primaryOrgId,
  regenerateRecoveryCodes,
  requireUserPrincipal,
  vaultStatus,
} from '@/server/vault-service';

/**
 * Recovery codes: redeeming one, and replacing the whole kit.
 *
 * ── Why this requires a session ──
 * It does not accept an email address, and that removes a whole category of
 * problem a public "forgot my passphrase" endpoint would have: no account
 * enumeration oracle, no way to probe whether a stranger has a vault, and no
 * need for the usual "we have sent a link if that address exists" evasion. The
 * person asking is already signed in — they are locked, not signed out. A
 * recovery code proves possession of the kit; the session cookie proves which
 * account. Both are required, which is what stops a leaked kit from being
 * redeemable by whoever finds it.
 */

/**
 * Step one: turn a code's lookup hash into the wrap it opens.
 *
 * Every failure — unknown hash, already-redeemed code, a code belonging to
 * another account — is the same refusal with the same message. Distinguishing
 * them would tell somebody probing the endpoint which part of their guess was
 * right.
 *
 * Rate limited under a `vault_recovery` key on the user alone, in a counter of
 * its own. The address and the IP are deliberately absent: every source address
 * having its own counter would hand an attacker a fresh allowance per proxy, and
 * the per-account counter it would be combined with already bounds the same
 * traffic. Its own key rather than the unlock counter, so the failed unlock
 * attempts that sent somebody here in the first place cannot leave nothing for
 * the step that gets them back in.
 *
 * The durable per-account recovery lockout in `user_keys` applies underneath it,
 * counted separately from the passphrase one so a mistyped code cannot spend the
 * budget protecting the passphrase.
 */
export const POST = authenticatedRoute(
  async ({ request, principal, services }) => {
    const user = requireUserPrincipal(principal);

    await enforce(services.env, 'RL_LOGIN', rateLimitKey(['vault_recovery', user.user.id]));

    const body = await parseJsonBody(request, recoveryBeginSchema);
    const { wrap, material } = await beginRecovery(services, user, body.lookupHash);

    // Not audited here. Resolving a lookup hash proves only that a code exists;
    // whether its holder can open the wrap is decided in the browser, and
    // `vault.recovery_used` is written when they prove it by completing. An
    // event on this step would report a recovery that may never have happened.
    return json({ wrap, material });
  },
  { allowLocked: true },
);

/**
 * Replaces the whole recovery kit from an unlocked session.
 *
 * `PUT`, because that is what it is: the set of live codes is replaced wholesale
 * rather than added to. Previously redeemed codes keep their tombstones; every
 * live code is revoked in the same transaction that writes the new five.
 *
 * Requires an unlocked session *and* the passphrase re-entered — the sudo-mode
 * pattern. Printing a fresh set of codes at somebody's unattended desk is
 * precisely the act a re-entry requirement exists to stop, and it is one of the
 * few acts that would hand an attacker durable access surviving a passphrase
 * change.
 */
export const PUT = authenticatedRoute(async ({ request, principal, services, audit, record }) => {
  const user = requireUserPrincipal(principal);

  await enforce(services.env, 'RL_LOGIN', rateLimitKey(['vault_recovery', user.user.id]));

  const body = await parseJsonBody(request, recoveryRegenerateSchema);
  const issued = await regenerateRecoveryCodes(services, user, body);

  const orgId = await primaryOrgId(services, user.user.id);
  if (orgId !== null) {
    record(
      audit(orgId).success(
        'vault.recovery_codes_regenerated',
        { type: 'user', id: user.user.id },
        { source: 'dashboard', recoveryCodeCount: issued },
      ),
    );
  }

  return json({ vault: await vaultStatus(services, principal), recoveryCodesRemaining: issued });
});
