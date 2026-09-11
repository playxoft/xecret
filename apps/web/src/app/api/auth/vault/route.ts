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
  vaultMaterialOwner,
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
 *
 * ── The token read, and why it is metered and audited rather than removed ──
 * A **CLI token** reads its issuing user's material, and that is a genuine
 * concession rather than a symmetric one. What it receives is the passphrase
 * wrap, the KDF salt and the Argon2 parameters: everything an offline attack on
 * the passphrase needs, held by a credential that lives in a file on a laptop or
 * an environment variable in a CI runner and is good for months. "The wraps are
 * useless without the passphrase" is true of a locked *browser*, which is bounded
 * by a session; it is a weaker statement about an `xct_…` token, and stating it
 * without qualification would be the comment doing the work the design cannot.
 *
 * It is not removable. Headless `xecret login --passphrase` exists precisely so a
 * machine can decrypt, and a CLI token cannot open a single grant without the
 * user's wrapped private key — so withholding the material would leave the flow
 * authenticating perfectly and decrypting nothing. What is available is to make
 * the read *cost* something and *show up*: `RL_CLI_TOKEN` bounds how fast a token
 * can pull fresh material, and `vault.material_read` puts the read in the audit
 * log with the credential kind on it, so an unexpected pull at 04:00 from a CI
 * runner is a question somebody can ask. ADR 0009 §residual risks records the
 * trade honestly, including that the Argon2 cost is disclosed to the holder.
 *
 * A **browser session** is neither metered here nor audited: it reads its own
 * material on every lock screen, several times a day, and burying
 * `vault.unlocked` under page views would cost more than it buys.
 */
export const GET = authenticatedRoute(
  async ({ principal, services, audit, record }) => {
    const status = await vaultStatus(services, principal);

    // Whose material, if any — see `vaultMaterialOwner`. A session reads its
    // own; a CLI token reads its issuing user's, because it acts as that user
    // and cannot open a single grant without their wrapped private key; a
    // service token reads nothing, having no vault to read.
    const owner = vaultMaterialOwner(principal);
    if (owner === null || !status.configured) {
      return json({ vault: status, material: null });
    }

    if (principal.kind !== 'user') {
      await enforce(services.env, 'RL_CLI_TOKEN', rateLimitKey(['vault_material', owner]));
    }

    const material = await vaultMaterial(services, owner);

    if (principal.kind !== 'user' && material !== null) {
      // Filed against the account's primary organisation, like every other
      // account-level record: `audit_logs.org_id` is NOT NULL, because a record
      // nobody's audit view can reach is a record nobody will read.
      const orgId = await primaryOrgId(services, owner);
      if (orgId !== null) {
        record(
          audit(orgId).success(
            'vault.material_read',
            { type: 'user', id: owner },
            {
              source: 'cli',
              principalKind: 'token',
              reason: 'headless unlock: the wraps a passphrase login must open',
            },
          ),
        );
      }
    }

    return json({ vault: status, material });
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
      material: await vaultMaterial(services, user.user.id),
    });
  },
  { allowLocked: true },
);

/**
 * Changes how long a vault may sit idle before it locks.
 *
 * *Not* exempt from the lock gate, unlike GET and POST: this route only tunes a
 * protection, and a locked session has no business loosening one. It changes no
 * key material and unlocks nothing, so it takes the ordinary mutation allowance
 * rather than the login bucket — it is not a guessing surface.
 *
 * Audited, and audited with the *effective* interval rather than the requested
 * one: the service clamps, and a record naming a number no gate ever used would
 * be a record an incident review is entitled to disbelieve. Stretching the
 * allowance is the act worth having dated, because it is how an unlocked laptop
 * stays unlocked.
 *
 * ── The effect is not confined to this session ──
 * The preference lives on the vault row, and the gate reads it on every request
 * from every device. So loosening it here loosens every signed-in browser at
 * once, which is what the settings copy promises and what makes this a
 * protection rather than a per-tab convenience.
 */
export const PATCH = authenticatedRoute(async ({ request, principal, services, audit, record }) => {
  const user = requireUserPrincipal(principal);
  await enforce(services.env, 'RL_MUTATION', rateLimitKey([user.user.id]));

  const body = await parseJsonBody(request, autoLockSchema);
  const minutes = await setAutoLock(services, user, body.autoLockMinutes);

  const orgId = await primaryOrgId(services, user.user.id);
  if (orgId !== null) {
    record(
      audit(orgId).success(
        'auth.autolock_changed',
        { type: 'user', id: user.user.id },
        {
          source: 'dashboard',
          reason:
            body.autoLockMinutes === null
              ? `reset to the default of ${minutes} minutes idle`
              : `after ${minutes} minutes idle`,
        },
      ),
    );
  }

  return json({ vault: await vaultStatus(services, principal) });
});
