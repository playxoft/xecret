import { json } from '@/server/http';
import { reauthStatus } from '@/server/reauth-service';
import { authenticatedRoute } from '@/server/route';
import { requireUserPrincipal } from '@/server/vault-service';

/**
 * Where this session's re-authentication for the vault reset stands.
 *
 * The reset screen asks this when it comes back from the forced sign-in, to
 * decide whether to offer "email me a code" or "sign in again". It reports
 * state the server already holds and sends nothing: the code is only ever
 * requested by an explicit `POST …/start`.
 *
 * `allowLocked`, for the reason the reset itself is: everybody here is locked
 * out by definition.
 */
export const GET = authenticatedRoute(
  async ({ principal, services }) => {
    const user = requireUserPrincipal(principal);
    const status = await reauthStatus(services, user);

    return json({
      signedIn: status.signedIn,
      signedInUntil: status.signedInUntil?.toISOString() ?? null,
      codeSent: status.codeSent,
      // The address the code goes to: the session's own, which it already knows.
      email: user.user.email,
    });
  },
  { allowLocked: true },
);
