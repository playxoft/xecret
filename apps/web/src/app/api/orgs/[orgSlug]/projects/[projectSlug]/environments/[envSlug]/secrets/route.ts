import { listSecrets } from '@xecret/db/repositories';
import type { SecretWriterRef } from '@xecret/db/repositories';
import type { ServiceContext } from '@/server/context';
import type { EnvironmentScope } from '@/server/tenancy';
import type { SecretWriteResult } from '@/server/secrets-service';
import { json, parseJsonBody, parseQuery } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { toSecretValueType } from '@xecret/core/validation';
import {
  createClientSecretBody,
  createSecretBody,
  listQuery,
  toEncNote,
} from '@/server/schemas/secrets';
import {
  auditSource,
  authorizeSecretAction,
  enforceSecretRateLimit,
  writeClientSecretValue,
  writeSecretValue,
  secretWriter,
} from '@/server/secrets-service';
import { resolveEnvironmentPath } from '@/server/tenancy';
import type { Principal } from '@/server/actor';
import { emitSecretChanges } from '@/server/change-events';
import { enforceSecretPolicy, secretPolicyRefusal } from '@/server/policies-service';
import type { ProtectionCrossing } from '@/server/references-service';
import {
  crossingRecords,
  planRefusal,
  prepareTemplateDeclaration,
  templateGuard,
} from '@/server/template-writes';

/**
 * An environment's secrets: the masked listing, and creation.
 *
 * The listing and the reveal (`secrets/[name]`) are separate routes on purpose.
 * Nothing in this file can produce a plaintext value except `POST`, which is
 * given one by the caller — so "which handler can decrypt a stored secret?" has
 * an answer that does not include this one.
 */

interface Params {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
}

/**
 * The masked listing.
 *
 * `listSecrets` writes out its select list explicitly and never touches
 * `ciphertext`, `iv` or `value_hmac`. That matters more than it looks: loading
 * the whole row and dropping the ciphertext afterwards would be identical from
 * the outside and wrong in every way that counts — the bytes would still cross
 * the network, still land in a Worker buffer, and still appear in a slow-query
 * log. The environment's data key is never unwrapped on this path at all.
 *
 * **Not audited, deliberately.** §7 of the contract audits every mutation, every
 * decryption, and every denial; a masked listing is none of those. It produces
 * no plaintext, and the dashboard polls it on every navigation — auditing it
 * would bury the `secret.revealed` records that actually matter under a flood of
 * page views, which makes the audit log worse at its one job. The denial path is
 * still recorded: `authorize` throws, and the route wrapper flushes it.
 */
export const GET = authenticatedRoute<Params>(async ({ request, params, principal, services }) => {
  const scope = await resolveEnvironmentPath(principal, params, services);
  authorizeSecretAction(scope, principal, 'secret.read');

  const { limit, cursor } = parseQuery(request, listQuery);
  const page = cursor ?? 1;

  const secrets = await listSecrets(services.db, scope.organization.id, scope.environment.id, {
    page,
    ...(limit === undefined ? {} : { pageSize: limit }),
  });

  return json({
    data: secrets.items.map((secret) => ({
      /**
       * The row id, which an `e2ee` client cannot work without.
       *
       * It is an AAD component (spec §4.2): the encrypted note carried right
       * beside it is bound to this id, and so is every value the client will
       * later write against this secret. Published in both modes rather than
       * conditionally, because a payload whose *shape* depends on the mode is a
       * payload two branches of a client have to agree about, and the id
       * discloses nothing — it names a row the caller is already reading.
       */
      id: secret.id,
      name: secret.name,
      note: secret.note,
      // The encrypted note travels with the listing rather than waiting for a
      // reveal, because it is not a value: it is a label the dashboard renders
      // beside every row, so fetching it per secret would be a request per row
      // for something this query already has. It is still ciphertext, so serving
      // it concedes nothing a reveal would not.
      encNote: toEncNote(secret.encNote),
      valueType: toSecretValueType(secret.valueType),
      version: secret.latestVersion,
      createdAt: secret.createdAt.toISOString(),
      updatedAt: secret.updatedAt.toISOString(),
      // The secret's author. *Who last changed it* is a property of the newest
      // `secret_versions` row, which this query does not read — resolving it
      // would mean a correlated lookup per secret for a column the list view
      // shows as a tooltip. `…/secrets/{name}/versions` answers it exactly.
      // Exactly one of the pair is set — a person, or the CI token that wrote it.
      createdBy: secret.createdBy,
      createdByServiceTokenId: secret.createdByServiceTokenId,
    })),
    nextCursor: secrets.hasMore ? String(page + 1) : null,
  });
});

/**
 * Creates a secret and its first version.
 *
 * A duplicate name is decided by `secrets_env_name_idx`, not by a `SELECT`
 * beforehand: check-then-insert is not a weaker guarantee, it is no guarantee at
 * all, because two concurrent requests can both read "free".
 *
 * ── One route, two bodies ──
 * The body this endpoint accepts depends on `environments.encryption_mode`, read
 * from the stored row. A `server`-mode environment takes a plaintext `value` and
 * the Worker encrypts it; an `e2ee` environment takes a `value` object holding a
 * ciphertext, a key id and an HMAC, and the Worker stores it verbatim.
 *
 * The two are refused against each other rather than coerced. Sending a
 * plaintext to an `e2ee` environment is the mistake that matters — it would put a
 * credential in a request body the whole design exists to keep it out of — and
 * the schema rejects it before the value is read, because `strictObject` does not
 * admit a `value` that is a string where an object is expected.
 */
export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);
    authorizeSecretAction(scope, principal, 'secret.create');

    // Resolved before the body is read so a credential that cannot be recorded
    // as the author is refused without the Worker buffering a 1 MB payload.
    const writer = secretWriter(principal);

    await enforceSecretRateLimit(services, principal, 'write');

    const e2ee = scope.environment.encryptionMode === 'e2ee';

    // Parsed once, under the schema the environment's mode selects, and the two
    // branches meet again at a `SecretWriteResult` — so everything after this
    // point (the audit record, the response) is written once rather than twice.
    const policyRefused = (id: string | null) =>
      secretPolicyRefusal(record, audit(scope.organization.id), 'secret.created', {
        type: 'secret',
        id,
        projectId: scope.project.id,
        environmentId: scope.environment.id,
      });

    const written = e2ee
      ? await createClientSecret(
          scope,
          services,
          writer,
          request,
          principal,
          (name, id) =>
            planRefusal(
              record,
              audit(scope.organization.id),
              'secret.created',
              {
                type: 'secret',
                id,
                projectId: scope.project.id,
                environmentId: scope.environment.id,
              },
              'secretReferencing',
              scope.entitlements.plan,
              { secretName: name },
            ),
          policyRefused,
        )
      : await createServerSecret(scope, services, writer, request, policyRefused(null));

    // The name, never the value. `AuditMetadata` makes the second half of that
    // sentence a type error rather than a habit — there is no field to put a
    // value in.
    record(
      audit(scope.organization.id).success(
        'secret.created',
        {
          type: 'secret',
          id: written.result.secretId,
          projectId: scope.project.id,
          environmentId: scope.environment.id,
        },
        {
          secretName: written.result.name,
          projectSlug: scope.project.slug,
          environmentSlug: scope.environment.slug,
          valueType: written.valueType,
          source: auditSource(principal),
        },
      ),
      ...crossingRecords(
        audit(scope.organization.id),
        scope,
        (written.crossings ?? []).map((crossing) => ({
          secretName: written.result.name,
          crossing,
        })),
      ),
    );

    // P19 §5 — after the response, never in its way.
    emitSecretChanges(services, scope, principal, [
      { type: 'secret.created', name: written.result.name, version: written.result.version },
    ]);

    return json(
      {
        secret: {
          name: written.result.name,
          version: written.result.version,
          note: written.note,
          encNote: written.encNote,
          valueType: written.valueType,
        },
      },
      { status: 201 },
    );
  },
);

/** What both branches return, so the audit record and the response are written once. */
interface CreatedSecret {
  result: SecretWriteResult;
  note: string | null;
  encNote: string | null;
  valueType: string;
  /** Production template links to non-production environments the person confirmed. */
  crossings?: readonly ProtectionCrossing[] | undefined;
}

async function createServerSecret(
  scope: EnvironmentScope,
  services: ServiceContext,
  writer: SecretWriterRef,
  request: Request,
  refused: (names: readonly string[]) => void,
): Promise<CreatedSecret> {
  const body = await parseJsonBody(request, createSecretBody);

  // P19 §8: a new name, and a plaintext the server holds — both rules apply.
  await enforceSecretPolicy(
    scope,
    services,
    [{ name: body.name, newName: true, value: body.value }],
    refused,
  );

  const result = await writeSecretValue(scope, services, {
    writer,
    name: body.name,
    value: body.value,
    valueType: body.valueType,
    ...(body.note === undefined ? {} : { note: body.note }),
  });

  return { result, note: body.note ?? null, encNote: null, valueType: body.valueType };
}

/**
 * The client-encrypted branch.
 *
 * `note` comes back `null` and `encNote` carries the note, because an `e2ee`
 * secret must not hold a plaintext note beside its encrypted value: a note is
 * free text people put credentials in, and the column's old promise that it
 * "never holds a value" was never enforceable.
 */
async function createClientSecret(
  scope: EnvironmentScope,
  services: ServiceContext,
  writer: SecretWriterRef,
  request: Request,
  principal: Principal,
  refusal: (name: string, id: string) => () => void,
  policyRefused: (id: string) => (names: readonly string[]) => void,
): Promise<CreatedSecret> {
  const body = await parseJsonBody(request, createClientSecretBody);

  // P19 §8: the name rule. The value rules ran in the client that encrypted
  // this — the server never sees the value it would test.
  await enforceSecretPolicy(
    scope,
    services,
    [{ name: body.name, newName: true }],
    policyRefused(body.id),
  );

  // P19 §1: a template's declaration, resolved and checked before anything is
  // stored — or `null` for a value that is not one.
  const crossings: ProtectionCrossing[] = [];
  const declaredReferences = await prepareTemplateDeclaration(scope, services, principal, {
    name: body.name,
    secretId: body.id,
    effectiveType: body.valueType,
    requested: body.references,
    refused: refusal(body.name, body.id),
    confirmCrossesProtection: body.confirmCrossesProtection,
    onCrossing: (found) => crossings.push(...found),
  });

  const result = await writeClientSecretValue(scope, services, {
    declaredReferences,
    // The graph check, inside the write's transaction (review round 1, L8).
    guard: templateGuard(scope, { name: body.name, secretId: body.id, declaredReferences }),
    writer,
    name: body.name,
    // The client's uuid, not one minted here. It is an AAD component, so the
    // ciphertext in this body was already sealed against it — see `id` on
    // `createClientSecretBody`.
    secretId: body.id,
    // A create is version 1 by definition — there is no earlier row to append
    // to — and the body carries no `expectedVersion` for that reason. Stated
    // here rather than defaulted in the service, so the one function that checks
    // this invariant sees a number from every caller.
    expectedVersion: 1,
    value: {
      ...body.value,
      ...(body.encNote === undefined ? {} : { encNote: body.encNote }),
    },
    valueType: body.valueType,
  });

  return {
    result,
    note: null,
    encNote: body.encNote ?? null,
    valueType: body.valueType,
    crossings,
  };
}
