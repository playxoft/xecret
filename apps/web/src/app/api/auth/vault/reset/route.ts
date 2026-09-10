import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { confirmationMatches } from '@/server/schemas/resources';
import {
  VAULT_RESET_CONFIRMATION,
  VAULT_RESET_MAX_AUTH_AGE_SECONDS,
  vaultResetSchema,
} from '@/server/schemas/vault';
import {
  assertRecentAccountOwner,
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
 * So the body carries a fresh Firebase ID token and this route verifies it
 * server-side, through the same `FirebaseIdentityProvider` that backs
 * `POST /api/auth/session`. Its subject must be this session's own account, and
 * its `auth_time` must be inside {@link VAULT_RESET_MAX_AUTH_AGE_SECONDS} — the
 * claim a refresh does *not* move, which is what makes this a second act of
 * authentication rather than a second copy of the same credential.
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
    // authentication failure, and a stale token should not be reported as a typo.
    await assertRecentAccountOwner(services, user, body.idToken);

    const destroyed = await resetVault(services, user);

    // Nothing to reset. A 404 rather than a cheerful 200, for the same reason
    // unenrolling a passkey that does not exist is a 404: a destructive call
    // that reports success without destroying anything teaches a client that
    // the call worked, and the next screen it draws will be wrong.
    if (!destroyed) {
      throw errors.notFound('no vault to reset');
    }

    const orgId = await primaryOrgId(services, user.user.id);
    if (orgId !== null) {
      // The only record that this account's existing ciphertext became
      // permanently unreadable at a particular moment. Without it, "I cannot see
      // any of my secrets and I never deleted them" has no answer in the log.
      record(
        audit(orgId).success(
          'vault.reset',
          { type: 'user', id: user.user.id },
          { source: 'dashboard', reason: 'passphrase and recovery codes lost' },
        ),
      );
    }

    // Read after the reset, so it reports `configured: false` and the client
    // routes straight to the setup ceremony. `resetVault` cleared
    // `vault_unlocked_at` on every session in the same transaction, so this
    // request's own principal is stale by exactly one field — and the field it
    // is stale in is one `vaultStatus` recomputes from the absent vault anyway.
    return json({ vault: await vaultStatus(services, { ...user, vaultUnlockedAt: null }) });
  },
  { allowLocked: true },
);
