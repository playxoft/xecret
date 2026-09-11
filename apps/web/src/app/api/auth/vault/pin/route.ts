import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { pinEnrollSchema } from '@/server/schemas/vault';
import {
  enrolDevicePin,
  listDevicePins,
  primaryOrgId,
  requireUserPrincipal,
  revokeDevicePins,
} from '@/server/vault-service';

/**
 * Device PINs: the browsers this account can open its vault on with six digits.
 *
 * ── What a PIN enrolment actually is ──
 * A 32-byte pepper on this server, and a wrap of the User Key in one browser's
 * `localStorage` that the server never sees. The wrap is encrypted under
 * `HKDF(pinKey ‖ pepper)`, so neither half is a key: the device alone holds a
 * ciphertext with nothing to attack, and this table alone holds bytes that
 * decrypt nothing anywhere. They meet for one request, under a five-attempt
 * counter — which is what turns a million offline guesses into five online ones.
 *
 * ── Why none of these methods is `allowLocked` ──
 * Enrolling wraps the User Key, and a locked browser has no User Key to wrap; it
 * could only produce a wrap of nothing, and an enrolment for a wrap that opens
 * nothing is worse than none at all, because it suppresses the offer to set one
 * up. Listing and revoking are management views, which have never been part of
 * the unlock flow. The one PIN route a locked session needs is
 * `POST /api/auth/vault/pin/attempt`, and that is where the exemption lives.
 */

/** Every browser enrolled, newest first. Never a pepper, never a digest. */
export const GET = authenticatedRoute(async ({ principal, services }) => {
  const user = requireUserPrincipal(principal);
  return json({ devices: await listDevicePins(services, user) });
});

/**
 * Enrols this browser, or re-enrols it under a new PIN, and hands back the
 * pepper once.
 *
 * The ordinary mutation allowance rather than the login bucket: this writes a
 * pepper rather than testing one, so it is not a guessing surface, and it
 * already requires an unlocked session to reach.
 */
export const POST = authenticatedRoute(async ({ request, principal, services, audit, record }) => {
  const user = requireUserPrincipal(principal);
  await enforce(services.env, 'RL_MUTATION', rateLimitKey([user.user.id]));

  const body = await parseJsonBody(request, pinEnrollSchema);
  const enrolment = await enrolDevicePin(services, user, body);

  const orgId = await primaryOrgId(services, user.user.id);
  if (orgId !== null) {
    // The one record of an account choosing a weaker credential for daily use.
    // The device id is a public uuid the browser minted; the pepper, the digest
    // and the PIN are not in this record and could not be — `AuditMetadata` has
    // no field that would hold them.
    record(
      audit(orgId).success(
        'vault.pin_enrolled',
        { type: 'user', id: user.user.id },
        { source: 'dashboard', method: 'pin', deviceName: body.deviceId },
      ),
    );
  }

  return json({ pin: enrolment }, { status: 201 });
});

/**
 * Turns off every PIN this account has, on every browser.
 *
 * The control for "I have lost a laptop and I do not remember which enrolments
 * exist". It strands nobody: the passphrase wrap always exists and has no
 * removal path, so what each of those browsers loses is a shortcut.
 */
export const DELETE = authenticatedRoute(async ({ principal, services, audit, record }) => {
  const user = requireUserPrincipal(principal);
  await enforce(services.env, 'RL_MUTATION', rateLimitKey([user.user.id]));

  const revoked = await revokeDevicePins(services, user);

  const orgId = await primaryOrgId(services, user.user.id);
  if (orgId !== null) {
    record(
      audit(orgId).success(
        'vault.pin_disabled',
        { type: 'user', id: user.user.id },
        { source: 'dashboard', method: 'pin', reason: `every browser (${revoked})` },
      ),
    );
  }

  return json({ revoked });
});
