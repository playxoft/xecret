import { uuidv7 } from '@xecret/core/ids';
import { VAULT_RETENTION_MS } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { confirmationMatches } from '@/server/schemas/resources';
import { assertRecentAccountOwner } from '@/server/reauth-service';
import { VAULT_RESET_CONFIRMATION, vaultResetSchema } from '@/server/schemas/vault';
import { emailVaultArchive } from '@/server/vault-archive-service';
import {
  primaryOrgId,
  requireUserPrincipal,
  resetVault,
  vaultStatus,
} from '@/server/vault-service';

/**
 * The honest dead end: destroying a vault whose passphrase and every recovery
 * code are gone.
 *
 * ── What this endpoint is not ──
 * It is not a recovery path, and it must never be described as one. Nothing here
 * decrypts anything or restores anything, because nothing can: the User Key
 * existed only inside the wraps this deletes, and no copy of it is held by a
 * teammate, an operator, or us. That is the promise the product makes, and this
 * route is what keeping it looks like when somebody has lost their side of it.
 *
 * ── Why it exists anyway ──
 * The data was already unreadable before this ran — it became unreadable when
 * the last recovery code was lost. What this changes is only whether the account
 * can be *used* afterwards. Without it a person is parked at a lock screen whose
 * every action fails, forever, with a working session and a live subscription;
 * with it they run the setup ceremony again, get a new key hierarchy, and a
 * teammate re-shares the environments they need. Refusing to offer it would
 * protect nothing and strand somebody.
 *
 * ── The gates ──
 * `allowLocked`, which is the whole point: every caller of this route is locked
 * out by definition, and a lock gate in front of it would make it unreachable by
 * exactly the people it is for. Everything else stands — a browser session
 * (a token has no vault), CSRF on the mutation, and a typed confirmation.
 *
 * ── And, since the lock gate is off, proof that this is the account's owner ──
 * The typed phrase is a check against a *mistake*: it is printed on the screen
 * above the field, so it costs an attacker one glance. With the lock gate
 * necessarily absent, that left the single irreversible act in the product —
 * destroying a vault, and with it every environment key the account holds,
 * permanently — reachable by anybody holding a stolen session cookie, without
 * ever knowing the passphrase.
 *
 * So the body carries a **reauth proof**, minted by `POST
 * /api/auth/reauth/verify` only after two re-authentications in a fixed order:
 * a fresh sign-in with the identity provider told to ignore any session it
 * held, then a one-time code emailed to the account (`server/reauth-service.ts`
 * has the argument). The proof is bound to this session and this user, lives
 * five minutes, and is spent by this request whatever happens next.
 *
 * ── Then the archive, then the reset (P23) ──
 * With the proof spent and before anything changes, the account's escape
 * archive — every ciphertext the vault could open, still sealed — is assembled
 * from stored rows and emailed to the account's own address
 * (`server/vault-archive-service.ts`). A provider failure refuses the reset,
 * so a retry finds the vault where it was. A deployment with no mail provider,
 * or a vault too large to email, resets anyway and the response says no archive
 * was sent; either way the old vault is **retained for seven days**, recoverable
 * with the old passphrase or a recovery code and undeletable by anyone, and is
 * purged by the scheduled job after that (migration 0020).
 *
 * Rate limited on `RL_LOGIN` under a **`vault_reset` key of its own**, keyed on
 * the user alone like the recovery counter it sits beside. Its own counter
 * rather than recovery's, deliberately: somebody arrives here having just
 * exhausted recovery attempts, and sharing that budget would spend the escape
 * hatch on the failure it exists to escape.
 */
export const POST = authenticatedRoute(
  async ({ request, principal, services, audit, record }) => {
    const user = requireUserPrincipal(principal);

    await enforce(services.env, 'RL_LOGIN', rateLimitKey(['vault_reset', user.user.id]));

    const body = await parseJsonBody(request, vaultResetSchema);

    // Compared with the same helper `DELETE /api/auth/account` uses, which trims
    // and lowercases: this is a check against a mistake, not against an attacker
    // — anyone who can reach this route can also read the phrase off the screen.
    // What it buys is that the sentence has to be read and typed rather than
    // clicked past, on the one action in the product with no undo.
    if (!confirmationMatches(VAULT_RESET_CONFIRMATION, body.confirm)) {
      throw errors.badRequest(`Type “${VAULT_RESET_CONFIRMATION}” exactly to confirm.`);
    }

    // After the phrase, before anything is destroyed. The order matters only for
    // the message a caller gets: a mistyped phrase should not be reported as an
    // authentication failure, and a stale proof should not be reported as a typo.
    // A typo costs nothing; the proof is spent here, whether the reset that
    // follows succeeds or not.
    await assertRecentAccountOwner(services, user, body.reauthProof);

    const now = new Date();
    const retainedUntil = new Date(now.getTime() + VAULT_RETENTION_MS);

    // Before the reset, never after: the order the owner decided is "archive
    // emailed, then reset", and a send that fails must leave the vault in place.
    const archive = await emailVaultArchive(services, {
      userId: user.user.id,
      email: user.user.email,
      now,
      retainedUntil,
      archiveId: uuidv7(),
    });

    // Nothing to reset. A 404 rather than a cheerful 200, for the same reason
    // unenrolling a passkey that does not exist is a 404: a destructive call
    // that reports success without changing anything teaches a client that the
    // call worked, and the next screen it draws will be wrong.
    if (archive.status === 'not-emailed' && archive.reason === 'no-vault') {
      throw errors.notFound('no vault to reset');
    }

    const retained = await resetVault(services, user, now);
    if (retained === null) {
      throw errors.notFound('no vault to reset');
    }

    const orgId = await primaryOrgId(services, user.user.id);
    if (orgId !== null) {
      const subject = { type: 'user', id: user.user.id } as const;
      record(
        archive.status === 'emailed'
          ? audit(orgId).success('vault.archive_emailed', subject, {
              source: 'dashboard',
              partCount: archive.parts,
              environmentCount: archive.environmentCount,
              secretCount: archive.secretCount,
            })
          : audit(orgId).error(
              'vault.archive_emailed',
              subject,
              archive.reason === 'too-large' ? 'quotaExceeded' : 'upstreamUnavailable',
              { source: 'dashboard' },
            ),
        // The record that this account's existing ciphertext stopped being
        // readable to it at a particular moment — recoverable until the purge.
        audit(orgId).success('vault.reset', subject, {
          source: 'dashboard',
          reason: 'passphrase and recovery codes lost; old vault retained for seven days',
          grantCount: retained.grantCount,
        }),
      );
    }

    // Read after the reset, so it reports `configured: false` and the client
    // routes straight to the setup ceremony. `resetVault` cleared
    // `vault_unlocked_at` on every session in the same transaction, so this
    // request's own principal is stale by exactly one field — and the field it
    // is stale in is one `vaultStatus` recomputes from the absent vault anyway.
    return json({
      vault: await vaultStatus(services, { ...user, vaultUnlockedAt: null }),
      archive:
        archive.status === 'emailed'
          ? { emailed: true, parts: archive.parts, to: user.user.email }
          : { emailed: false, reason: archive.reason },
      retained: {
        id: retained.id,
        retainedUntil: retained.purgeAfter.toISOString(),
        grantCount: retained.grantCount,
      },
    });
  },
  { allowLocked: true },
);
