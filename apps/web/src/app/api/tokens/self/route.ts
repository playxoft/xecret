import {
  findEnvironmentById,
  findOrganizationById,
  findProjectById,
} from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json } from '@/server/http';
import { authenticatedRoute } from '@/server/route';

/**
 * What a service token is — asked by the credential itself.
 *
 * `XECRET_TOKEN=xst_… xecret run` has a problem no other caller has: it holds
 * a credential pinned to an organisation, project and environment it cannot
 * name, because the pin is stored as ids and every API path speaks slugs. This
 * endpoint closes the loop: the token asks, and learns exactly its own scope —
 * nothing more, because the answer is derived from the token row rather than
 * from any parameter, and there is no parameter to lie in.
 *
 * Deliberately service-token-only. Sessions and CLI tokens have `/api/auth/me`
 * with its richer, person-shaped answer; overloading one endpoint with both
 * shapes would give every client a union to mishandle.
 */

export const GET = authenticatedRoute(async ({ principal, services }) => {
  if (principal.kind !== 'serviceToken') {
    throw errors.forbidden('Only a service token can introspect itself here.');
  }

  const [organization, project, environment] = await Promise.all([
    findOrganizationById(services.db, principal.orgId),
    findProjectById(services.db, principal.orgId, principal.projectId),
    findEnvironmentById(services.db, principal.orgId, principal.environmentId),
  ]);

  // A live token pointing at deleted scope cannot pull anything either; the
  // honest answer is that the credential no longer resolves.
  if (!organization || !project || !environment) {
    throw errors.unauthenticated('service token scope no longer resolves');
  }

  return json({
    token: {
      /**
       * The token's own row id — the `recipientId` of every grant sealed to it
       * (spec §4.2). A service token in an `e2ee` environment cannot build the
       * AAD that opens its own grant without it, and it is not a disclosure: the
       * credential is naming itself to itself.
       */
      id: principal.tokenId,
      name: principal.tokenName,
      accessLevel: principal.accessLevel,
    },
    /**
     * `id` alongside the slug for the same reason: `orgId` is a component of
     * every secret's AAD, and slugs are renameable while AAD components are not.
     */
    organization: { id: organization.id, name: organization.name, slug: organization.slug },
    project: { name: project.name, slug: project.slug },
    environment: {
      name: environment.name,
      slug: environment.slug,
      isProduction: environment.isProduction,
    },
  });
});
