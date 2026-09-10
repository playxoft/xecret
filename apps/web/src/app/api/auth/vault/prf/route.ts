import { json, parseJsonBody } from '@/server/http';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { passkeyEnrollSchema } from '@/server/schemas/vault';
import { enrollPasskey, listVaultPasskeys, requireUserPrincipal } from '@/server/vault-service';

/**
 * Passkeys enrolled for one-touch unlock, through the WebAuthn PRF extension.
 *
 * ── What a passkey wrap is ──
 * The authenticator's PRF output is HKDF'd into a key, and that key wraps the
 * same User Key the passphrase wrap holds. So enrolling one adds a door rather
 * than replacing one: the passphrase wrap always exists and has no removal path.
 * That is what makes unenrolment safe and what stops a lost authenticator from
 * being a lost account — and it is why a passkey may never be the *only* wrap.
 *
 * Both methods require an unlocked session, and neither is exempt. Reading the
 * list is a management view, not part of the unlock flow; the wrap a locked
 * client needs in order to unlock arrives with the rest of the material from
 * `GET /api/auth/vault`, which is the route that carries the exemption.
 */

export const GET = authenticatedRoute(async ({ principal, services }) => {
  const user = requireUserPrincipal(principal);
  return json({ passkeys: await listVaultPasskeys(services, user) });
});

/**
 * Enrols a passkey and the wrap its PRF output opens, atomically.
 *
 * The ordinary mutation allowance rather than the login bucket: this is not a
 * guessing surface — it writes a wrap rather than testing one — and it already
 * requires an unlocked session to reach.
 */
export const POST = authenticatedRoute(async ({ request, principal, services }) => {
  const user = requireUserPrincipal(principal);
  await enforce(services.env, 'RL_MUTATION', rateLimitKey([user.user.id]));

  const body = await parseJsonBody(request, passkeyEnrollSchema);

  return json({ passkey: await enrollPasskey(services, user, body) }, { status: 201 });
});
