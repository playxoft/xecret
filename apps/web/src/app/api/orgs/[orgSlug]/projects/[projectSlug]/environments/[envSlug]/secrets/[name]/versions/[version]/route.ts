import { findSecretByName, getSecretVersion } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { secretNameFromPath } from '@/server/schemas/secrets';
import {
  auditSource,
  authorizeSecretAction,
  decryptOne,
  enforceSecretRateLimit,
} from '@/server/secrets-service';
import { resolveEnvironmentPath } from '@/server/tenancy';

/**
 * Reveals **one** historical version.
 *
 * ── Why this is a separate endpoint from the history listing ──
 * The listing beside it (`…/versions`) returns metadata and selects no ciphertext
 * column at all, and that stays true. This is deliberate rather than incidental:
 * a rotated secret is not a dead secret — `AWS_SECRET_ACCESS_KEY` version 3 keeps
 * working until somebody disables it at AWS — so a *listing* that carried values
 * would hand out a page of live credentials under an interface people reason
 * about as an archive, and it would do so in one request that looks like
 * "showing timestamps".
 *
 * Asking for one version, by name, one at a time is a different act. It is
 * explicit, it is rate-limited like any other reveal, and — the part that matters
 * — every single one writes a `secret.revealed` record carrying the version. So
 * "who read the old production password, and which one" stays answerable, which
 * is the property the metadata-only listing was protecting in the first place.
 *
 * ── The version comes from the stored row, never from the URL ──
 * `decryptOne` builds its `EncryptionContext` from the `SecretMaterial` the
 * repository returned. Using the *requested* version to authenticate the
 * ciphertext would make an attacker's relocation of a row between versions
 * decrypt cleanly, which is precisely what the AAD binding exists to reject.
 */

interface Params {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  name: string;
  version: string;
}

/** `int4`'s ceiling, because that is the column's type. */
const MAX_VERSION = 2_147_483_647;

export const GET = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    authorizeSecretAction(scope, principal, 'secret.read');
    await enforceSecretRateLimit(services, principal, 'read');

    const name = secretNameFromPath(params.name);
    const version = versionFromPath(params.version);

    // Name to id, and the current version for the `current` flag. This also
    // excludes soft-deleted secrets, so the history of a deleted secret stays
    // unreachable here — recovering that is a restore first, which is audited.
    const secret = await findSecretByName(
      services.db,
      scope.organization.id,
      scope.environment.id,
      name,
    );
    if (!secret) throw errors.notFound('no live secret with that name in environment');

    const material = await getSecretVersion(
      services.db,
      scope.organization.id,
      secret.secretId,
      version,
    );
    if (!material) throw errors.notFound('no such version of that secret');

    const value = await decryptOne(scope, services, material);

    // Queued before the value leaves this function, and carrying the version.
    // An unaudited reveal is the failure that matters most on this path, and a
    // record that did not say *which* version was read would answer the easy
    // half of the question during an incident.
    record(
      audit(scope.organization.id).success(
        'secret.revealed',
        {
          type: 'secret',
          id: material.secretId,
          projectId: scope.project.id,
          environmentId: scope.environment.id,
        },
        {
          secretName: material.name,
          projectSlug: scope.project.slug,
          environmentSlug: scope.environment.slug,
          source: auditSource(principal),
          reason: `version ${material.version}`,
        },
      ),
    );

    return json({
      secret: {
        name: material.name,
        value,
        version: material.version,
        current: material.version === secret.version,
        createdAt: material.createdAt.toISOString(),
        createdBy: material.createdBy,
      },
    });
  },
);

/**
 * Turns the `[version]` segment into a version number.
 *
 * `not_found` rather than `validation_failed`, matching `secretNameFromPath`:
 * this segment addresses a resource, and a value outside the range names one
 * that cannot exist. Distinguishing "malformed" from "absent" would answer a
 * question the caller is not entitled to ask.
 */
function versionFromPath(raw: string): number {
  // `Number` rather than `parseInt`: `parseInt('3abc')` is 3, which would
  // silently accept a segment that is not a version at all.
  const version = Number(raw);

  if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) {
    throw errors.notFound('version outside the permitted range');
  }

  return version;
}
