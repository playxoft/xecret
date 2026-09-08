import { json, parseJsonBody } from '@/server/http';
import { attemptKey, enforce } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { vaultPassphraseSchema } from '@/server/schemas/vault';
import {
  changePassphrase,
  primaryOrgId,
  requireUserPrincipal,
  vaultMaterial,
  vaultStatus,
} from '@/server/vault-service';

/**
 * Changing the master passphrase.
 *
 * ── What actually changes, and what deliberately does not ──
 * One row: the passphrase wrap of the User Key, plus the verifier and KDF
 * parameters that go with it. The **User Key itself is untouched**, so nothing
 * sealed to this account's public key is re-encrypted, recovery codes keep
 * working, and sessions on other devices stay unlocked. That is precisely what
 * the wrap indirection in ADR 0009 buys — the alternative design, where the
 * passphrase encrypted keys directly, would make this a re-encryption of
 * everything the account can read.
 *
 * ── Two gates, not one ──
 * The route requires an unlocked session (no `allowLocked`), and the body
 * requires the current passphrase's verifier. They prove different things: the
 * gate proves this session unlocked at some point in the last eight hours, and
 * the verifier proves the person typing knows the passphrase *now*. Without the
 * second, an unattended desk is a passphrase change — the exact scenario the
 * lock exists for.
 *
 * Against the login bucket, keyed on the user: requiring the current verifier
 * makes this a guessing surface exactly like unlock, and it must not be handed
 * its own, more generous allowance. The per-account lockout applies too, inside
 * the service.
 */
export const POST = authenticatedRoute(async ({ request, principal, services, audit, record }) => {
  const user = requireUserPrincipal(principal);

  await enforce(services.env, 'RL_LOGIN', attemptKey(services.meta.ipAddress, user.user.id));

  const body = await parseJsonBody(request, vaultPassphraseSchema);
  await changePassphrase(services, user, body);

  const orgId = await primaryOrgId(services, user.user.id);
  if (orgId !== null) {
    record(
      audit(orgId).success(
        'vault.passphrase_changed',
        { type: 'user', id: user.user.id },
        { source: 'dashboard', wrapKind: 'passphrase' },
      ),
    );
  }

  // The material comes back so the client can replace what it holds without a
  // second round trip: the wrap it cached a moment ago is now superseded, and a
  // client still holding it would fail its next unlock against a stale row.
  return json({
    vault: await vaultStatus(services, principal),
    material: await vaultMaterial(services, user),
  });
});
