import { noContent } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { disableDevicePin, primaryOrgId, requireUserPrincipal } from '@/server/vault-service';

/**
 * Turning off one browser's device PIN — this one, or another the account owns.
 *
 * One route for both, because they are the same act seen from two chairs: a
 * browser disabling its own PIN names its own `deviceId`, and the settings list
 * revoking a laptop left at an office names that one. A separate "disable here"
 * endpoint would differ only in which uuid the client put in the path.
 *
 * The id is scoped by user in the repository's `WHERE`, so one account cannot
 * revoke another's enrolment by guessing a uuid — and an id belonging to
 * somebody else answers exactly the same 404 as one belonging to nobody
 * (threat T2).
 *
 * This can never strand an account: the passphrase wrap always exists and has no
 * removal path, so what the browser loses is a shortcut. The wrap left in its
 * `localStorage` is dead the moment the pepper is gone — nothing can open it
 * again, including the correct PIN — and the client clears it as soon as it
 * learns the enrolment is unknown.
 */
export const DELETE = authenticatedRoute<{ deviceId: string }>(
  async ({ params, principal, services, audit, record }) => {
    const user = requireUserPrincipal(principal);
    await enforce(services.env, 'RL_MUTATION', rateLimitKey([user.user.id]));

    await disableDevicePin(services, user, params.deviceId);

    const orgId = await primaryOrgId(services, user.user.id);
    if (orgId !== null) {
      record(
        audit(orgId).success(
          'vault.pin_disabled',
          { type: 'user', id: user.user.id },
          { source: 'dashboard', method: 'pin', deviceName: params.deviceId },
        ),
      );
    }

    return noContent();
  },
);
