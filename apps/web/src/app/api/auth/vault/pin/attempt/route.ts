import { json, parseJsonBody } from '@/server/http';
import { attemptKey, enforce } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { pinAttemptSchema } from '@/server/schemas/vault';
import {
  attemptDevicePin,
  primaryOrgId,
  requireUserPrincipal,
  vaultStatus,
} from '@/server/vault-service';

/**
 * One device-PIN attempt: six digits, proved as a verifier, against a pepper the
 * server releases at most one attempt at a time.
 *
 * ── What is being exchanged here ──
 * Not a decryption. The wrap that holds the User Key is in this browser's
 * `localStorage` and never reaches this server — what the server has is the
 * other half of its key, 32 random bytes, and the question this route answers is
 * whether to hand them over. On a match it does, marks the session unlocked, and
 * the browser unwraps locally; on a miss it counts the attempt instead.
 *
 * ── The budget, in the same two layers as a passphrase unlock ──
 *
 *  - `RL_LOGIN` at the edge, keyed on IP and user. Cheap, per-colo, and its job
 *    is to stop a flood before it reaches a database round trip.
 *  - The **per-device attempt counter**, applied transactionally inside
 *    `attemptPinUnlock`. That one is the actual defence, and for a PIN it is the
 *    *only* defence: 10^6 candidates means the guesses have to be finite rather
 *    than merely slow. At five the pepper row is deleted, the browser's wrap
 *    stops being openable by anybody who never saw its pepper, and the
 *    passphrase is the only way in.
 *
 * Neither substitutes for the other. The first protects the service; the second
 * protects the account — and unlike an isolate-local counter, it survives a
 * Worker being recycled.
 *
 * ── Why a failure is a 200 with an outcome, and not a 401 ──
 * The caller *is* authenticated; a 401 would be a false statement about the
 * session, and `lib/api.ts` answers one by navigating to the sign-in page — so
 * mistyping a digit would sign somebody out. More importantly, three of the four
 * outcomes are instructions rather than reports: `burned` and `unknown` both
 * mean the local wrap is dead and must be cleared before the passphrase form is
 * offered, while `wrong` means keep it and show the count. One status code for
 * all three would leave a dead wrap suppressing the PIN option forever, or wipe
 * a good one on the first typo.
 *
 * `allowLocked`, necessarily: every caller of this route is at a lock screen.
 */
export const POST = authenticatedRoute(
  async ({ request, principal, services, audit, record }) => {
    const user = requireUserPrincipal(principal);

    await enforce(services.env, 'RL_LOGIN', attemptKey(services.meta.ipAddress, user.user.id));

    const body = await parseJsonBody(request, pinAttemptSchema);
    const result = await attemptDevicePin(services, user, body);

    const orgId = await primaryOrgId(services, user.user.id);
    const now = new Date();

    if (result.outcome !== 'unlocked') {
      // A burn is its own event: it is the moment a PIN's entire five-attempt
      // budget was spent, and a burst of them across an account is the shape of
      // somebody working through a stolen laptop. An ordinary miss is recorded
      // as a refused unlock, like a wrong passphrase, and carries no detail
      // about *why* — the `warn` line in the service holds the reason.
      if (orgId !== null) {
        record(
          result.outcome === 'burned'
            ? audit(orgId).error(
                'vault.pin_burned',
                { type: 'user', id: user.user.id },
                'invalidCredentials',
                { source: 'dashboard', method: 'pin', deviceName: body.deviceId },
              )
            : audit(orgId).error(
                'vault.unlock_failed',
                { type: 'user', id: user.user.id },
                'invalidCredentials',
                { source: 'dashboard', method: 'pin' },
              ),
        );
      }

      // The status travels with a refusal as well as with a success, so a lock
      // screen that has just been told "wrong PIN" is also told, by the same
      // response, that it is still locked.
      return json({ pin: result, vault: await vaultStatus(services, principal, now) });
    }

    if (orgId !== null) {
      // The same record a passphrase unlock writes, with the method that
      // distinguishes it. "The vault was opened at 03:00 from an address this
      // account has never used" has to stay sayable whichever door was used.
      record(
        audit(orgId).success(
          'vault.unlocked',
          { type: 'user', id: user.user.id },
          { source: 'dashboard', method: 'pin' },
        ),
      );
    }

    return json({
      pin: result,
      // Reported from the principal as it now is: the attempt unlocked the
      // session, and echoing the stale state would tell the client it is locked.
      vault: await vaultStatus(services, { ...user, vaultUnlockedAt: now }, now),
    });
  },
  { allowLocked: true },
);
