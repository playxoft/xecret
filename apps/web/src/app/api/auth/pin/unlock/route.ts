import { z } from 'zod';
import { PIN_LENGTH } from '@xecret/core/auth';
import { json, parseJsonBody } from '@/server/http';
import { requireUserPrincipal, unlockSession } from '@/server/pin-service';
import { attemptKey, enforce } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';

/**
 * Unlocking a session with its PIN.
 *
 * Two independent limits apply, and both are deliberate:
 *
 *  - `RL_LOGIN`, at the edge, keyed on IP and user. Cheap, per-colo, and its job
 *    is to stop a flood before it reaches PBKDF2 — 600,000 iterations is
 *    expensive on purpose, which makes an unmetered unlock endpoint a
 *    denial-of-service amplifier against our own Worker.
 *  - The per-account lockout in the database, applied inside `unlockSession`.
 *    That one is the actual defence: it is globally exact and survives an
 *    isolate being recycled, which the edge counter does not.
 *
 * Neither substitutes for the other. The first protects the service; the second
 * protects the account.
 */

const unlockRequest = z.object({
  pin: z
    .string()
    .length(PIN_LENGTH, `Your PIN must be exactly ${PIN_LENGTH} digits.`)
    .regex(/^\d+$/, 'Your PIN must be digits only.'),
});

export const POST = authenticatedRoute(
  async ({ request, principal, services }) => {
    const user = requireUserPrincipal(principal);

    await enforce(services.env, 'RL_LOGIN', attemptKey(services.meta.ipAddress, user.user.id));

    const { pin } = await parseJsonBody(request, unlockRequest);
    const result = await unlockSession(services, user, pin);

    // A successful unlock is not audited, and that is a considered omission
    // rather than an oversight. It happens once or twice a day per person and
    // records nothing that `auth.login` and the reads that follow do not already
    // say — an audit log people scroll past is one they stop reading. Failures
    // are logged (see `pin-service.ts`), because those are the interesting ones.
    return json({ pin: { configured: true, unlocked: true, unlockedUntil: result.unlockedUntil } });
  },
  { allowLocked: true },
);
