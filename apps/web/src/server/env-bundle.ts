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
 * ── The query budget is preserved ──
 * Two statements for the values and the key state, exactly as the server-mode
 * path spends two — `loadEnvironmentSecrets` resolves "current version of each"
 * with one `DISTINCT ON`, and `environmentKeyState` reads the active key and the
 * caller's grant. Both are constant in the number of secrets. What the e2ee path
 * *saves* is the envelope unwrap: no Root KEK, no org key, no AES-GCM open, and
 * therefore no plaintext anywhere in the Worker.
 *
 * ── What is deliberately absent ──
 * No `format`. Rendering `.env` or YAML takes plaintext, and this path has none;
 * `@xecret/core/format` runs in the browser and the CLI, which is where the
 * values already are. See `assertDocumentRenderable` for the refusal the
 * document endpoints give instead.
 */
export interface ClientEnvironmentBundle {
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
