import { json, parseJsonBody } from '@/server/http';
import { attemptKey, enforce } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { vaultUnlockSchema } from '@/server/schemas/vault';
import {
  primaryOrgId,
  requireUserPrincipal,
  unlockVault,
  vaultStatus,
} from '@/server/vault-service';

/**
 * Unlocking a session's vault.
 *
 * ── What is actually being proved here ──
 * Not that the caller can decrypt anything. That question was already answered
 * in the browser, where a key opened the User Key wrap; the server never sees
 * any of it. What arrives is an **unlock verifier**, and what it buys is the
 * three things a server can still usefully do: gate the API for the next eight
 * hours, count the attempt, and write the audit line.
 *
 * ── Two verifiers, because an unlock is not always a passphrase ──
 * A passphrase unlock derives `SK` and sends `unlockVerifier`. A passkey unlock
 * opens blob type 3 — which holds the User Key — never derives `SK`, and sends
 * `ukUnlockVerifier` instead (spec §8.2). Exactly one of the two, enforced by
 * the schema's union: a body with both would be asking the server to choose
 * which proof counts, and a body with neither would be claiming an unlock it
 * never proved.
 *
 * They compare against different stored digests, so neither can be replayed for
 * the other, and they share one lockout, because they attest to the same thing.
 *
 * Two independent limits apply, and both are deliberate:
 *
 *  - `RL_LOGIN`, at the edge, keyed on IP and user. Cheap, per-colo, and its job
 *    is to stop a flood before it reaches a database round trip.
 *  - The per-account lockout in `user_keys`, applied inside `unlockVault`. That
 *    one is the actual defence: it is globally exact and survives an isolate
 *    being recycled, which the edge counter does not.
 *
 * Neither substitutes for the other. The first protects the service; the second
 * protects the account.
 */
export const POST = authenticatedRoute(
  async ({ request, principal, services, audit, record }) => {
    const user = requireUserPrincipal(principal);

    await enforce(services.env, 'RL_LOGIN', attemptKey(services.meta.ipAddress, user.user.id));

    const body = await parseJsonBody(request, vaultUnlockSchema);
    // Which proof arrived is settled by the schema's union, not here: a body
    // carrying both verifiers or neither never reaches this line.
    const method = 'unlockVerifier' in body ? 'passphrase' : 'passkey';

    let result: Awaited<ReturnType<typeof unlockVault>>;
    try {
      result = await unlockVault(services, user, body);
    } catch (cause) {
      // Recorded here rather than in the service, because only the route holds
      // an audit builder — and recorded before the rethrow, because the route
      // wrapper flushes queued records in a `finally`. The denial that caused
      // the failure is exactly the record worth keeping: a burst of these from
      // one account is the shape of a vault being attacked, and that pattern is
      // invisible if each refusal is silent.
      //
      // No detail about *why*. Whether the verifier was wrong, the vault absent
      // or the account locked out is not something the audit log needs and is
      // not something a reader of it should be able to correlate back into an
      // oracle. The `warn` line from `vault-service.ts` carries the count.
      const failedOrgId = await primaryOrgId(services, user.user.id);
      if (failedOrgId !== null) {
        record(
          audit(failedOrgId).error(
            'vault.unlock_failed',
            { type: 'user', id: user.user.id },
            'invalidCredentials',
            { source: 'dashboard', method },
          ),
        );
      }
      throw cause;
    }

    // ── Why a successful unlock is audited, when a successful PIN entry was not ──
    // The PIN's omission was considered and correct for what it was: a screen
    // lock, entered twice a day, recording nothing the surrounding events did
    // not already say. A vault unlock marks something else — the moment key
    // material became reachable on a device — and "the vault was opened at 03:00
    // from an address this account has never used" is a sentence a
    // zero-knowledge product has to be able to say. No other event says it.
    const orgId = await primaryOrgId(services, user.user.id);
    if (orgId !== null) {
      record(
        audit(orgId).success(
          'vault.unlocked',
          { type: 'user', id: user.user.id },
          { source: 'dashboard', method: result.method },
        ),
      );
    }

    const now = new Date();
    return json({
      vault: await vaultStatus(services, { ...user, vaultUnlockedAt: now }, now),
      unlockedUntil: result.unlockedUntil,
    });
  },
  { allowLocked: true },
);
