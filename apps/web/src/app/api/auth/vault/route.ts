import { json, parseJsonBody } from '@/server/http';
import { attemptKey, enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { autoLockSchema, vaultCreateSchema } from '@/server/schemas/vault';
import {
  createVault,
  primaryOrgId,
  requireUserPrincipal,
  setAutoLock,
  vaultMaterial,
  vaultStatus,
} from '@/server/vault-service';

/**
 * The vault itself: read its state, create it, tune its idle lock.
 *
 * `allowLocked` on GET and POST because a session that has never been unlocked
 * is exactly the session that needs to read the lock screen's material and to
 * run the setup ceremony. The exemption widens nothing: POST refuses to
 * overwrite an existing vault, so from a locked session it can only act on an
 * account that has none.
 */

/**
 * Everything the client needs to decide between the setup ceremony, the unlock
 * screen, and the dashboard — and, when a vault exists, the material an unlock
 * attempt requires.
 *
 * The wraps are served to a *locked* session, which is not an oversight: an
 * unlock is a client-side operation, and a client cannot try to unwrap a User
 * Key it has not been given. See `VaultMaterialPayload` for what that concedes
 * and why it is the standing trade-off of the model rather than a gap in it.
 */
export const GET = authenticatedRoute(
  async ({ principal, services }) => {
    const status = await vaultStatus(services, principal);

    // A token principal has no vault and no lock screen; `vaultStatus` already
    // reports it as configured and unlocked, and there is nothing to serve.
    if (principal.kind !== 'user' || !status.configured) {
      return json({ vault: status, material: null });
    }

    return json({ vault: status, material: await vaultMaterial(services, principal) });
  },
  { allowLocked: true },
);

/**
 * The setup ceremony's upload: both keypairs, the passphrase wrap, the whole
 * recovery kit, and the unlock verifier — in one request and one transaction.
 *
 * Nothing here can be re-run. A second call is a **409**, because the account's
 * existing public key has environment keys sealed to it and replacing it
 * silently would revoke access to every one of them while reporting success.
 *
 * Rate limited against the login bucket: this endpoint accepts key material and
 * writes seven rows, and the account it writes them for is the caller's own.
 */
export const POST = authenticatedRoute(
  async ({ request, principal, services, audit, record }) => {
    const user = requireUserPrincipal(principal);

    await enforce(services.env, 'RL_LOGIN', attemptKey(services.meta.ipAddress, user.user.id));

    const body = await parseJsonBody(request, vaultCreateSchema);
    await createVault(services, user, body);

    // Filed against the user's primary organisation, for the same reason logout
    // is: `audit_logs.org_id` is NOT NULL, because a record nobody's audit view
    // can reach is a record nobody will read.
    const orgId = await primaryOrgId(services, user.user.id);
    if (orgId !== null) {
      record(
        audit(orgId).success(
          'vault.created',
          { type: 'user', id: user.user.id },
          {
            source: 'dashboard',
            recoveryCodeCount: body.recoveryWraps.length,
          },
        ),
      );
    }

    // Reported from the principal as it now is: `createVault` unlocked the
    // session, and echoing the stale state would tell the client it is locked.
    const now = new Date();
    return json({
      vault: await vaultStatus(services, { ...user, vaultUnlockedAt: now }, now),
      material: await vaultMaterial(services, user),
    });
  },
  { allowLocked: true },
);

/**
 * Changes how long the dashboard may sit idle before locking itself.
 *
 * *Not* exempt from the lock gate, unlike GET and POST: this route only tunes a
 * protection, and a locked session has no business loosening one. It changes no
 * key material and unlocks nothing, so it takes the ordinary mutation allowance
 * rather than the login bucket — it is not a guessing surface.
 *
 * Audited: setting the interval to "never" is the act an incident review wants
 * to see dated, because it is how an unlocked laptop stays unlocked.
 */
export const PATCH = authenticatedRoute(async ({ request, principal, services, audit, record }) => {
  const user = requireUserPrincipal(principal);
  await enforce(services.env, 'RL_MUTATION', rateLimitKey([user.user.id]));

  const body = await parseJsonBody(request, autoLockSchema);
  await setAutoLock(services, user, body.autoLockMinutes);

  const orgId = await primaryOrgId(services, user.user.id);
  if (orgId !== null) {
    record(
      audit(orgId).success(
        'auth.autolock_changed',
        { type: 'user', id: user.user.id },
        {
          source: 'dashboard',
          reason:
            body.autoLockMinutes === 0 ? 'never' : `after ${body.autoLockMinutes} minutes idle`,
        },
      ),
    );
  }

  return json({ vault: await vaultStatus(services, principal) });
});
