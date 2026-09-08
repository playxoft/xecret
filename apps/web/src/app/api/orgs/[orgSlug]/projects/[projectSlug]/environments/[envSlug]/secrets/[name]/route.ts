import { findSecretByName, softDeleteSecret, updateSecretMetadata } from '@xecret/db/repositories';
import { toSecretValueType } from '@xecret/core/validation';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import {
  patchSecretMetadataBody,
  secretNameFromPath,
  toClientSecret,
  toEncNote,
  updateClientSecretBody,
  updateSecretBody,
} from '@/server/schemas/secrets';
import { encodeBlob } from '@/server/schemas/vault';
import {
  auditSource,
  authorizeSecretAction,
  decryptOne,
  enforceSecretRateLimit,
  rethrowRepositoryFailure,
  writeClientSecretValue,
  writeSecretValue,
  secretWriter,
} from '@/server/secrets-service';
import { resolveEnvironmentPath } from '@/server/tenancy';

/**
 * One secret: reveal, new version, delete.
 *
 * `[name]` is a name, not an id — the whole path carries the tenancy chain, so
 * there is no primary-key lookup here that a missing check could turn into an
 * IDOR (threat T2). It is validated against `SECRET_NAME_PATTERN` before it
 * reaches a query, and it arrives percent-encoded; both are handled by
 * `secretNameFromPath`.
 */

interface Params {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  name: string;
}

/**
 * Reveal: the one GET in the product that returns a plaintext credential.
 *
 * Every reveal is audited, every time, and the record is queued before the value
 * leaves this function. An unaudited reveal is the failure that matters most
 * here — the audit trail is what turns "someone read production's database
 * password" from an unanswerable question into a row.
 *
 * The honest limitation: `record()` queues, and the route wrapper flushes after
 * the response via `waitUntil`. A worker killed between the two loses the
 * record. Awaiting the write instead would put a database round trip on the
 * latency path of every reveal and still lose records to a crash one instruction
 * earlier, so the spine buffers deliberately — see `BufferedAuditRecorder`.
 *
 * `Cache-Control: no-store` is set by `json()` on every response it builds,
 * which is why this handler does not set it: one place to get right, and
 * `secrets-service.test.ts` asserts it rather than trusting the comment.
 */
export const GET = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    authorizeSecretAction(scope, principal, 'secret.read');
    await enforceSecretRateLimit(services, principal, 'read');

    const name = secretNameFromPath(params.name);

    const material = await findSecretByName(
      services.db,
      scope.organization.id,
      scope.environment.id,
      name,
    );
    if (!material) throw errors.notFound('no live secret with that name in environment');

    // ── The dual-mode fork, and why both sides are still `secret.revealed` ──
    // On a `server`-mode environment this decrypts and hands back a plaintext.
    // On an `e2ee` one it hands back the ciphertext and the key id it was sealed
    // against, and the caller decrypts it themselves.
    //
    // Both are audited identically, and that is deliberate rather than a
    // shortcut: what the record is for is answering "who obtained the value of
    // the production database password, and when". A caller who receives
    // ciphertext they hold the grant for has obtained it just as surely as one
    // who receives a plaintext — the decryption merely happens a few
    // milliseconds later, in their browser. Recording the e2ee case as something
    // lesser would make the audit log understate exactly the reads the
    // zero-knowledge model exists to keep honest about.
    const e2ee = scope.environment.encryptionMode === 'e2ee';
    const value = e2ee ? null : await decryptOne(scope, services, material);
    const sealed = e2ee ? toClientSecret(material) : null;

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
        },
      ),
    );

    return json({
      secret: {
        name: material.name,
        // `null` in `e2ee` mode, where `ciphertext` carries it instead. A field
        // rather than an omission, so a client can tell "this environment does
        // not hand out plaintext" from "this secret has no value".
        value,
        ...(sealed === null
          ? {}
          : {
              ciphertext: sealed.ciphertext,
              clientAlgorithm: sealed.clientAlgorithm,
              // Which key version this row was sealed against. A value written
              // before a rotation names the retired key, and a client holding
              // only the active grant has to learn that here rather than
              // discovering it as an unexplained decryption failure.
              envDataKeyId: sealed.envDataKeyId,
            }),
        // Returned so the dashboard validates an edit against the same type the
        // server will check it against, rather than against whatever the listing
        // happened to say when the page was loaded.
        valueType: toSecretValueType(material.valueType),
        version: material.version,
        updatedAt: material.createdAt.toISOString(),
        updatedBy: material.createdBy,
        updatedByServiceTokenId: material.createdByServiceTokenId,
      },
    });
  },
);

/**
 * Appends a new version.
 *
 * A value identical to the current one is a no-op: `writeSecretValue` compares
 * `value_hmac` without decrypting anything and returns `unchanged`. The response
 * still reports the current version, so a client that retries a failed request
 * sees success rather than a spurious conflict.
 */
export const PATCH = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    authorizeSecretAction(scope, principal, 'secret.update');

    const writer = secretWriter(principal);
    await enforceSecretRateLimit(services, principal, 'write');

    const name = secretNameFromPath(params.name);
    const e2ee = scope.environment.encryptionMode === 'e2ee';

    // Returns ciphertext this path never decrypts. It is the repository's only
    // name-to-id resolver, and it is the same query the reveal path uses — so
    // the alternative is a second lookup function that exists purely to fetch
    // less. The bytes stay inside the Worker and reach no response.
    const current = await findSecretByName(
      services.db,
      scope.organization.id,
      scope.environment.id,
      name,
    );
    if (!current) throw errors.notFound('no live secret with that name in environment');

    // `existing` is identical in both modes, and that is the point: the no-op
    // short-circuit compares `value_hmac` and nothing else, so it works the same
    // way whichever key produced the tag — and, in `e2ee` mode, keeps working
    // across an EDK rotation, because the client keys the HMAC from the
    // long-lived EHK rather than from the data key (spec §9).
    const existing = {
      secretId: current.secretId,
      version: current.version,
      valueHmac: current.valueHmac,
      valueType: current.valueType,
    };

    const written = e2ee
      ? await (async () => {
          const body = await parseJsonBody(request, updateClientSecretBody);
          const result = await writeClientSecretValue(scope, services, {
            writer,
            name: current.name,
            value: {
              ...body.value,
              ...(body.encNote === undefined ? {} : { encNote: body.encNote }),
            },
            ...(body.valueType === undefined ? {} : { valueType: body.valueType }),
            existing,
          });
          return { result, valueType: body.valueType };
        })()
      : await (async () => {
          const body = await parseJsonBody(request, updateSecretBody);
          const result = await writeSecretValue(scope, services, {
            writer,
            name: current.name,
            value: body.value,
            // Absent means "keep whatever the row already declares" — see
            // `resolveValueType`. That inheritance is what stops `xecret set`,
            // which sends no type, from downgrading a typed secret on every
            // rotation.
            ...(body.valueType === undefined ? {} : { valueType: body.valueType }),
            existing,
          });
          return { result, valueType: body.valueType };
        })();

    const result = written.result;

    // Recorded whether or not a version was appended. The caller asked for a
    // change and the request was accepted; `reason` distinguishes the two
    // outcomes so a rotation review can tell "rotated" from "re-submitted the
    // value that was already there".
    record(
      audit(scope.organization.id).success(
        'secret.updated',
        {
          type: 'secret',
          id: result.secretId,
          projectId: scope.project.id,
          environmentId: scope.environment.id,
        },
        {
          secretName: result.name,
          projectSlug: scope.project.slug,
          environmentSlug: scope.environment.slug,
          source: auditSource(principal),
          ...(written.valueType === undefined ? {} : { valueType: written.valueType }),
          ...(result.status === 'unchanged' ? { reason: 'unchanged' } : {}),
        },
      ),
    );

    return json({
      secret: { name: result.name, version: result.version, status: result.status },
    });
  },
);

/**
 * Changes what is said *about* a secret, without touching what it holds.
 *
 * A separate method from `PATCH` because it is a genuinely different operation:
 * it appends no version, unwraps no key, and never sees a plaintext. Declaring
 * `PORT` an integer is not a rotation, and routing it through the write path
 * would bump the version number — making "when did this credential last actually
 * change?" unanswerable for the sake of a label.
 *
 * `secret.update` is the permission, not something narrower. Being able to
 * declare a type is being able to decide which future writes are refused, which
 * is not a lesser authority than writing itself.
 *
 * The consequence, stated plainly: a type can be declared that the *current*
 * value does not satisfy. Refusing that would require decrypting a secret
 * because somebody used a dropdown, and would make the ordinary repair —
 * declare the type, then fix the value — impossible in either order. The next
 * write is where it is enforced, which is the moment the plaintext is
 * legitimately in hand anyway.
 */
export const PUT = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    authorizeSecretAction(scope, principal, 'secret.update');
    await enforceSecretRateLimit(services, principal, 'write');

    const name = secretNameFromPath(params.name);
    const body = await parseJsonBody(request, patchSecretMetadataBody);
    const renamed = body.name !== undefined && body.name !== name;

    // ── The one place the two note columns are told apart ──
    // A plaintext note on an `e2ee` secret would put free text — which people
    // routinely put credentials in — beside a value the whole design keeps the
    // server from seeing, so it is refused rather than stored. An encrypted note
    // on a `server`-mode secret is refused for the mirror reason: nothing in that
    // environment could ever decrypt it, so accepting it would write a column no
    // client will read and report success.
    const e2ee = scope.environment.encryptionMode === 'e2ee';
    if (e2ee && body.note !== undefined) {
      throw errors.badRequest(
        'This environment is end-to-end encrypted; send encNote rather than note.',
      );
    }
    if (!e2ee && body.encNote !== undefined) {
      throw errors.badRequest(
        'This environment uses server-side encryption; send note rather than encNote.',
      );
    }

    const updated = await updateSecretMetadata(services.db, {
      orgId: scope.organization.id,
      environmentId: scope.environment.id,
      name,
      ...(renamed ? { newName: body.name } : {}),
      ...(body.note === undefined ? {} : { note: body.note }),
      ...(body.encNote === undefined
        ? {}
        : { encNote: body.encNote === null ? null : encodeBlob(body.encNote) }),
      ...(body.valueType === undefined ? {} : { valueType: body.valueType }),
      // A rename that collides with a live secret comes back from the unique
      // index as `conflict`, and leaves here as a 409 rather than a 500.
    }).catch(rethrowRepositoryFailure);

    record(
      audit(scope.organization.id).success(
        'secret.updated',
        {
          type: 'secret',
          id: updated.id,
          projectId: scope.project.id,
          environmentId: scope.environment.id,
        },
        {
          secretName: updated.name,
          // The old name, kept only when it changed: "SECRET renamed from X" is
          // the fact an incident review needs, because everything reading the
          // old name stopped finding it at this moment.
          ...(renamed ? { previousSecretName: name } : {}),
          projectSlug: scope.project.slug,
          environmentSlug: scope.environment.slug,
          source: auditSource(principal),
          valueType: updated.valueType,
          // Distinguishes this from a rotation in the audit view. Both are
          // `secret.updated`; only one of them changed the credential.
          reason: 'metadata',
        },
      ),
    );

    return json({
      secret: {
        name: updated.name,
        note: updated.note,
        encNote: toEncNote(updated.encNote),
        valueType: toSecretValueType(updated.valueType),
      },
    });
  },
);

/**
 * Soft delete.
 *
 * The versions are left untouched — they are the record of what the value used
 * to be, and `restore` depends on them surviving. `secrets_env_name_idx` is
 * partial on `deleted_at IS NULL`, so the name is released immediately and a
 * user who deleted `DATABASE_URL` by mistake can create it again.
 */
export const DELETE = authenticatedRoute<Params>(
  async ({ params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    // `secret.delete` is absent from `SERVICE_TOKEN_ACTIONS`, so a CI credential
    // is refused here by the policy engine rather than by a check in this file.
    authorizeSecretAction(scope, principal, 'secret.delete');
    await enforceSecretRateLimit(services, principal, 'write');

    const name = secretNameFromPath(params.name);

    const current = await findSecretByName(
      services.db,
      scope.organization.id,
      scope.environment.id,
      name,
    );
    if (!current) throw errors.notFound('no live secret with that name in environment');

    await softDeleteSecret(services.db, scope.organization.id, current.secretId);

    record(
      audit(scope.organization.id).success(
        'secret.deleted',
        {
          type: 'secret',
          id: current.secretId,
          projectId: scope.project.id,
          environmentId: scope.environment.id,
        },
        {
          secretName: current.name,
          projectSlug: scope.project.slug,
          environmentSlug: scope.environment.slug,
          source: auditSource(principal),
        },
      ),
    );

    return json({ secret: { name: current.name, deleted: true } });
  },
);
