import { loadEnvironmentSecrets } from '@xecret/db/repositories';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { environmentKeyState } from './env-keys-service';
import { errors } from './errors';
import { toClientSecret } from './schemas/secrets';
import type { ClientSecretPayload } from './schemas/secrets';
import type { EnvironmentKeysPayload } from './schemas/env-keys';
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

export async function clientEnvironmentBundle(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
): Promise<ClientEnvironmentBundle> {
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

  return {
    bundle: true,
    bundleVersion: 1,
    encryptionMode: 'e2ee',
    keys,
    // Sorted by name, matching the order the dashboard renders and the order the
    // server-mode path returns — by code unit, not `localeCompare`, so the output
    // does not depend on a server locale. It also makes an exported file produce
    // a one-line diff when a secret is added rather than a reshuffle.
    secrets: materials
      .map(toClientSecret)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}
