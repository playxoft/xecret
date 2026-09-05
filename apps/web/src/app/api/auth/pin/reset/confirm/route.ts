import * as z from 'zod/mini';
import { PIN_LENGTH, checkPin, hashPin, hashToken, isWellFormedToken } from '@xecret/core/auth';
import { consumePinReset, markSessionUnlocked, upsertPin } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { pinStatus, primaryOrgId, requireUserPrincipal } from '@/server/pin-service';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';

/**
 * Completing a PIN reset.
 *
 * The token proves control of the mailbox; the session cookie proves which
 * account. **Both are required**, and the pairing is checked: a token issued to
 * one user cannot be redeemed by another's session, even though possessing it
 * would ordinarily be enough. Without that check, a link forwarded to a
 * colleague would let them set the PIN on their own account using somebody
 * else's reset — harmless-looking, and it would make the audit trail wrong about
 * who did what.
 */

const confirmRequest = z.object({
  token: z.string().check(z.minLength(1), z.maxLength(256)),
  pin: z
    .string()
    .check(
      z.length(PIN_LENGTH, `Your PIN must be exactly ${PIN_LENGTH} digits.`),
      z.regex(/^\d+$/, 'Your PIN must be digits only.'),
    ),
});

export const POST = authenticatedRoute(
  async ({ request, principal, services, audit, record }) => {
    const user = requireUserPrincipal(principal);

    // The reset flow's own counter, shared with `/pin/reset` and keyed on the
    // user — the two halves are one flow and one budget describes it. It used
    // to take from the login counter alongside `/pin/unlock`, which meant the
    // failed unlock attempts that sent somebody here in the first place could
    // leave nothing for the last step: a 429 on redeeming a link that is valid,
    // phrased as though the link were the problem.
    //
    // Still limited rather than exempted. The single-use token is not a rate
    // limit: every call reaches a token digest and a database lookup before
    // anything decides the token is unknown, and `enforce` running first is
    // also what keeps a rejected request from burning a good link.
    await enforce(services.env, 'RL_LOGIN', rateLimitKey(['pin_reset', user.user.id]));

    const body = await parseJsonBody(request, confirmRequest);

    // Structural check first, so a junk token costs a regular expression rather
    // than a digest and a write.
    if (!isWellFormedToken(body.token, 'pinReset')) {
      throw errors.badRequest('That reset link is not valid. Request a new one.');
    }

    const check = checkPin(body.pin);
    if (!check.valid) {
      // Validated *before* the token is consumed. A weak PIN would otherwise
      // burn the single-use link and leave the user to request another, which
      // is a maddening way to be told a PIN is too obvious.
      throw errors.validation([
        { field: 'pin', message: check.message ?? 'That PIN cannot be used.' },
      ]);
    }

    const consumed = await consumePinReset(services.db, await hashToken(body.token));

    // One answer for unknown, expired and already-used. Distinguishing them
    // tells somebody holding a guessed token which part of their guess was
    // right.
    if (consumed === null) {
      throw errors.badRequest('That reset link has expired or has already been used.');
    }

    if (consumed.userId !== user.user.id) {
      // The link was real but belongs to somebody else. Consuming it above was
      // still correct — a link presented by the wrong account is one that should
      // not survive to be presented again.
      services.log
        .at('POST')
        .warn(
          'A PIN reset link was presented by a different account than the one it was issued to. ' +
            'The link has been consumed anyway, so it cannot be presented again.',
        );
      throw errors.badRequest('That reset link belongs to a different account.');
    }

    await upsertPin(services.db, user.user.id, await hashPin(body.pin));
    await markSessionUnlocked(services.db, user.sessionId, new Date());

    const orgId = await primaryOrgId(services, user.user.id);
    if (orgId !== null) {
      // The record an incident review looks for: it means somebody proved
      // control of the mailbox rather than knowledge of the PIN.
      record(
        audit(orgId).success(
          'auth.pin_reset',
          { type: 'user', id: user.user.id },
          { source: 'dashboard', reason: 'completed' },
        ),
      );
    }

    return json({ pin: await pinStatus(services, { ...user, pinVerifiedAt: new Date() }) });
  },
  { allowLocked: true },
);
