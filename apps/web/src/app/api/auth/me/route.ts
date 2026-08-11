import { findUserById, listOrganizationsForUser } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json } from '@/server/http';
import { authenticatedRoute } from '@/server/route';

/**
 * The signed-in identity and the organisations it can act in.
 *
 * The dashboard calls this once on load and uses it to decide what to render;
 * `xecret whoami` calls it to answer "which account is this machine using?".
 *
 * That makes it a convenience, never an authority. Every subsequent request is
 * authorised on the server against `can()`, so a client that lies to itself
 * about this response gains nothing. Hiding a control the user cannot use is a
 * courtesy; the control not working is the security property.
 */
export const GET = authenticatedRoute(async ({ principal, services }) => {
  // A service token has no user and no organisation switcher — it is pinned to
  // one project and one environment by construction (threat T5). Answering with
  // an empty user object would invite a client to treat "no user" as "some
  // user", so the shape is refused rather than emptied.
  if (principal.kind === 'serviceToken') {
    throw errors.forbidden('Service tokens have no user profile.');
  }

  // A session already carries the profile from its lookup join. A CLI token
  // carries only `user_id`, so the profile is fetched here — on this route
  // alone, rather than on every authenticated CLI request that does not need it.
  const user =
    principal.kind === 'user' ? principal.user : await findUserById(services.db, principal.userId);

  // The token resolved but its user did not: an account soft-deleted between
  // the token lookup and now. Treated as unauthenticated, because the
  // credential no longer identifies anybody.
  if (!user) throw errors.unauthenticated('cli token user no longer exists');

  const memberships = await listOrganizationsForUser(services.db, user.id);

  return json({
    user: {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
    },
    // Named so the CLI can show which credential is in use without the token
    // itself ever being echoed back.
    credential:
      principal.kind === 'user'
        ? { kind: 'session' as const, name: null }
        : { kind: 'cliToken' as const, name: principal.tokenName },
    organizations: memberships.map((membership) => ({
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
      role: membership.role,
    })),
  });
});
