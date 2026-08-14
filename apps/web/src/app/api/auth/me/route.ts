import { findUserById, listOrganizationsForUser } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json } from '@/server/http';
import { pinStatus } from '@/server/pin-service';
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
export const GET = authenticatedRoute(
  async ({ principal, services }) => {
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
      principal.kind === 'user'
        ? principal.user
        : await findUserById(services.db, principal.userId);

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
      /**
       * Whether a PIN exists and whether this session is unlocked.
       *
       * This is why the route is exempt from the lock gate: the dashboard has to
       * distinguish "set up a PIN" from "enter your PIN" before it can render
       * either screen, and discovering that through a failed request to some other
       * endpoint would mean the first thing a locked user sees is an error.
       *
       * Like the rest of this response it is a convenience, not an authority. A
       * client that lied to itself about `unlocked` would still be refused by
       * `authenticatedRoute` on every request that matters.
       */
      pin: await pinStatus(services, principal),
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
  },
  {
    // The one route a locked session must reach, because it is the route that
    // tells the client it is locked.
    allowLocked: true,
  },
);
