import type { DeclaredReference } from '@xecret/core/references';
import {
  findActiveGrantsForPrincipal,
  loadEnvironmentSecrets,
  loadSecretsForEnvironments,
  toBytes,
} from '@xecret/db/repositories';
import type { SecretMaterial } from '@xecret/db/repositories';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { environmentKeyState, grantRecipient } from './env-keys-service';
import { errors } from './errors';
import { mayActOn, planPull } from './references-service';
import type { ReferencedRead } from './references-service';
import { encodePublicKey } from './schemas/env-keys';
import { toClientSecret } from './schemas/secrets';
import type { ClientSecretPayload } from './schemas/secrets';
import type { EnvironmentKeysPayload } from './schemas/env-keys';
import { decodeBlob } from './schemas/vault';
import type { EnvironmentScope } from './tenancy';

/**
 * The bulk read of an end-to-end encrypted environment: every current
 * ciphertext, and the grant that opens them.
 *
 * ── Why the grant travels with the values ──
 * A bundle of ciphertexts is useless without the key, and the key is a sealed
 * blob addressed to the caller. Making a client fetch `…/keys` and then `…/pull`
 * would be two round trips for one operation on the single hottest path in the
 * product — `xecret run` and every CI job — and, worse, would open a window in
 * which a rotation lands between the two, so the client holds a key for one
 * version and ciphertext for another with nothing in either response saying so.
 * Serving both together means the grant and the values are read in one
 * consistent moment.
 *
 * ── The query budget, counted rather than claimed ──
 * Five statements, not two, and the comment that said two was wrong in a way
 * worth recording: `environmentKeyState` is not one read. It is the active key,
 * the HMAC key, the environment's highest secret version, and the caller's own
 * grant — four — and `loadEnvironmentSecrets` resolves "current version of each"
 * with one `DISTINCT ON` for the fifth.
 *
 * What matters is that every one of them is **constant in the size of the
 * environment and of the organisation**. It briefly was not: `needsRotation` used
 * to be computed for every caller, and it walked the member roster two queries at
 * a time — an O(members) scan on the single hottest path in the product, `xecret
 * run` and every CI job. That answer is now computed only for a caller who can act
 * on it, which a pull never is, and when it is computed it reads the roster in
 * bulk rather than a member at a time.
 *
 * What the e2ee path *saves* is the envelope unwrap: no Root KEK, no org key, no
 * AES-GCM open, and therefore no plaintext anywhere in the Worker.
 *
 * ── What is deliberately absent ──
 * No `format`. Rendering `.env` or YAML takes plaintext, and this path has none;
 * `@xecret/core/format` runs in the browser and the CLI, which is where the
 * values already are. See `assertDocumentRenderable` for the refusal the
 * document endpoints give instead.
 */
export interface ClientEnvironmentBundle {
  /**
   * The marker that says this response *is* a bundle.
   *
   * ── Why a field exists for something the shape seems to state ──
   * Because the shape does not state it. A `server`-mode pull at `format=json`
   * is a **flat object of the environment's own secret names**, so a client
   * sniffing for `encryptionMode` was asking a question an attacker — or an
   * unlucky naming convention — could answer: an environment holding a secret
   * literally called `encryptionMode`, with the value `e2ee`, was read as a
   * bundle by the CLI, and every value in that document was then handed to a
   * decryptor. Two fields no secret name can collide with close it, because a
   * flat document's values are all strings and `true` is not one.
   *
   * Present only in `e2ee` mode. A `server`-mode pull carries neither.
   */
  bundle: true;
  /**
   * The bundle's shape version.
   *
   * Carried by clients and not yet refused for an unknown value: the first build
   * that sees this field has to accept whatever it says, or the number can never
   * be raised without breaking every client that came before it.
   */
  bundleVersion: 1;
  encryptionMode: 'e2ee';
  /** The caller's own key material, so one request answers the whole operation. */
  keys: EnvironmentKeysPayload;
  secrets: ClientSecretPayload[];
}

/**
 * A bundle that carries more than its own environment (P19 §1) — version 2.
 *
 * Everything version 1 carries, unchanged, for the environment being read:
 * `keys` opens `secrets`. Beside them, `layers`: every ancestor (with all of its
 * secrets) and every environment a template reaches into (with only the secrets
 * it reaches), each with the caller's own grant for that environment and the
 * parent it inherits from. A layer that contributes no secret — an ancestor of a
 * referenced environment that sets nothing the reference needs — carries no keys,
 * and is there only so a client can walk the same chain the server walked.
 *
 * Every ciphertext is still bound by its AAD to the row and the environment that
 * hold it, and opens only under that environment's key. Nothing is re-encrypted
 * and nothing moves: a layer is ciphertext the caller could have pulled directly,
 * delivered together so the resolution happens on one consistent read.
 *
 * Secrets that are templates say so (`template`) and carry the references their
 * writer declared, which a client checks the decrypted text against before it
 * resolves anything.
 */
export interface ResolvedEnvironmentBundle extends Omit<
  ClientEnvironmentBundle,
  'bundleVersion' | 'secrets'
> {
  bundleVersion: 2;
  environment: {
    id: string;
    projectSlug: string;
    slug: string;
    parentEnvironmentId: string | null;
  };
  secrets: ResolvableSecretPayload[];
  layers: BundleLayer[];
}

export interface BundleLayer {
  environmentId: string;
  projectSlug: string;
  environmentSlug: string;
  parentEnvironmentId: string | null;
  /** `null` for a layer that contributes no secret and needs no key. */
  keys: LayerKeys | null;
  secrets: ResolvableSecretPayload[];
}

/** The part of `GET …/keys` that opens a layer: the active key and the caller's grant. */
export interface LayerKeys {
  encryptionMode: 'e2ee';
  environmentId: string;
  activeEdk: { id: string; version: number };
  myGrant: EnvironmentKeysPayload['myGrant'];
}

export interface ResolvableSecretPayload extends ClientSecretPayload {
  template?: true;
  references?: DeclaredReference[];
}

/** What a resolved pull read beyond the environment itself — for the audit trail. */
export interface LayerRead {
  environmentId: string;
  projectId: string;
  projectSlug: string;
  environmentSlug: string;
  secretCount: number;
  kind: 'inherited' | 'referenced';
}

export interface BundleResult {
  bundle: ClientEnvironmentBundle | ResolvedEnvironmentBundle;
  /** Empty for a version 1 bundle. */
  layerReads: LayerRead[];
  referencedReads: ReferencedRead[];
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function toResolvable(material: SecretMaterial): ResolvableSecretPayload {
  const payload: ResolvableSecretPayload = toClientSecret(material);
  if (material.valueType === 'template') {
    payload.template = true;
    payload.references = material.declaredReferences ?? [];
  }
  return payload;
}

/**
 * Whether reading this environment involves more than its own ciphertext — a
 * parent, or a template. Decided from rows the pull has already read, so an
 * environment that uses neither feature pays nothing for either.
 */
export function needsResolution(
  scope: EnvironmentScope,
  materials: readonly SecretMaterial[],
): boolean {
  return (
    scope.environment.parentEnvironmentId !== null ||
    materials.some((material) => material.valueType === 'template')
  );
}

export async function clientEnvironmentBundle(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
  options: { resolved: boolean } = { resolved: false },
): Promise<BundleResult> {
  const keys = await environmentKeyState(scope, services, principal);

  if (keys.myGrant === null) {
    // The caller passed `secret.read` — they are allowed to read this
    // environment — but nobody has sealed its key to them. That is the pending
    // queue's whole reason for existing, and it is a state the product creates
    // deliberately rather than a fault: an admin granted access without holding
    // the key themselves.
    //
    // 409 rather than 403: the caller's permissions are not the problem, and the
    // same request succeeds the moment somebody fulfils the queued share. The
    // reason code is stable so a client can render "waiting for a teammate to
    // share this environment's key" rather than "access denied", which would
    // send them to ask for access they already have.
    throw errors.conflict(
      'no_key_grant: you have access to this environment but nobody has shared its key with you yet.',
    );
  }

  const materials = await loadEnvironmentSecrets(
    services.db,
    scope.organization.id,
    scope.environment.id,
  );

  if (!needsResolution(scope, materials)) {
    return {
      bundle: {
        bundle: true,
        bundleVersion: 1,
        encryptionMode: 'e2ee',
        keys,
        // Sorted by name, matching the order the dashboard renders and the order
        // the server-mode path returns — by code unit, not `localeCompare`, so the
        // output does not depend on a server locale. It also makes an exported
        // file produce a one-line diff when a secret is added rather than a
        // reshuffle.
        secrets: sortByName(materials.map(toClientSecret)),
      },
      layerReads: [],
      referencedReads: [],
    };
  }

  // ── A client that cannot resolve is refused, never handed a partial view ──
  // A version 1 client reads `keys` and `secrets` and ignores anything else, so
  // it would inject a template's literal `${…}` text, and none of the inherited
  // values, into a process — which then starts and fails somewhere far from the
  // cause. A client that can resolve says so (`?bundle=2`); one that does not is
  // told what to upgrade, before anything else is read.
  if (!options.resolved) {
    throw errors.conflict(
      'resolution_unsupported: this environment inherits from another or holds a template, and ' +
        'this client cannot resolve them. Upgrade the xecret CLI, then run the command again.',
    );
  }

  const { plan, environments, referencedReads } = await planPull(scope, services);

  // ── Every environment that contributes a secret is one the caller may read ──
  // Asked of the caller's own membership, through the same `can()` as a direct
  // pull of that environment. A service token is pinned to one environment, and
  // `can()` refuses it every other one — the write-time rule exists so a CI
  // credential never meets this refusal.
  const contributing = [...plan.chain, ...plan.referenced.keys()];
  for (const id of new Set(contributing)) {
    const record = environments.get(id);
    if (record === undefined || !mayActOn(scope, principal, record, 'secret.read')) {
      throw errors.forbidden(
        principal.kind === 'serviceToken'
          ? 'This environment resolves values from another environment, and a service token can read only its own.'
          : 'This environment inherits from, or refers to, an environment you cannot read.',
      );
    }
  }

  const extra = await loadSecretsForEnvironments(services.db, scope.organization.id, contributing);
  const recipient = grantRecipient(principal);
  const grants = await findActiveGrantsForPrincipal(services.db, {
    orgId: scope.organization.id,
    environmentIds: contributing,
    recipientKind: recipient.kind,
    recipientId: recipient.id,
  });

  const inChain = new Set(plan.chain);
  const layerIds = [...new Set([...plan.chain, ...plan.referenced.keys(), ...plan.contexts])];
  const layers: BundleLayer[] = [];
  const layerReads: LayerRead[] = [];

  for (const id of layerIds) {
    const record = environments.get(id)!;
    const wanted = inChain.has(id) ? null : (plan.referenced.get(id) ?? new Set<string>());
    const secrets = sortByName(
      extra
        .filter((material) => material.environmentId === id)
        .filter((material) => wanted === null || wanted.has(material.name))
        .map(toResolvable),
    );

    let layerKeys: LayerKeys | null = null;
    if (secrets.length > 0) {
      const held = grants.get(id);
      if (held === undefined || held.grant === null) {
        throw errors.conflict(
          `no_key_grant: you have access to ${record.projectSlug}/${record.slug}, which this ` +
            'environment reads from, but nobody has shared its key with you yet.',
        );
      }
      layerKeys = {
        encryptionMode: 'e2ee',
        environmentId: id,
        activeEdk: held.activeKey,
        myGrant: {
          recipientPublicKey: encodePublicKey(toBytes(held.grant.recipientPublicKey)),
          edkSealed: decodeBlob(toBytes(held.grant.edkSealed)),
          ehkSealed: decodeBlob(toBytes(held.grant.ehkSealed)),
          signature: decodeBlob(toBytes(held.grant.signature)),
          signedByUserId: held.grant.signedByUserId,
        },
      };
      layerReads.push({
        environmentId: id,
        projectId: record.projectId,
        projectSlug: record.projectSlug,
        environmentSlug: record.slug,
        secretCount: secrets.length,
        kind: inChain.has(id) ? 'inherited' : 'referenced',
      });
    }

    layers.push({
      environmentId: id,
      projectSlug: record.projectSlug,
      environmentSlug: record.slug,
      parentEnvironmentId: record.parentEnvironmentId,
      keys: layerKeys,
      secrets,
    });
  }

  return {
    bundle: {
      bundle: true,
      bundleVersion: 2,
      encryptionMode: 'e2ee',
      keys,
      environment: {
        id: scope.environment.id,
        projectSlug: scope.project.slug,
        slug: scope.environment.slug,
        parentEnvironmentId: scope.environment.parentEnvironmentId,
      },
      secrets: sortByName(materials.map(toResolvable)),
      layers,
    },
    layerReads,
    referencedReads,
  };
}
