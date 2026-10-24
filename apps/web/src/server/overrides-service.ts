import { auditingDenials } from '@xecret/core/authz';
import type { Denial } from '@xecret/core/authz';
import type { OverrideOwner } from '@xecret/db/repositories';
import type { Principal } from './actor';
import { errors } from './errors';
import { authorize } from './tenancy';
import type { EnvironmentScope } from './tenancy';

/**
 * Personal overrides (P19 §2): one person's own value for one key in one
 * environment, which `xecret run` applies on their machine and nowhere else.
 *
 * ── The four rules, and where each is kept ──
 *  - **Never visible to another member.** Every repository read is scoped by
 *    owner, and the value is under a key derived from the owner's own X25519
 *    private key (spec §2.2, type 13) — so a teammate holding the environment's
 *    key still cannot open it, and this server can neither open one nor make
 *    one the owner's CLI would accept.
 *  - **Never part of a CI fetch.** A service token is refused every override
 *    route, below, and no bundle or pull carries an override: they are fetched
 *    separately, by the CLI, for a person, and applied after resolution.
 *  - **Never inherited.** An override names one environment's id in its AAD and
 *    its row; a child environment's pull never sees its parent's.
 *  - **A person who may read the key.** Setting a value you could not read would
 *    be a way to learn nothing, but listing overrides on an environment you have
 *    lost access to would keep a copy of a decision you are no longer party to;
 *    so every route asks `secret.read` of the environment.
 *
 * End-to-end encrypted environments only: the owner's key pair is the vault's,
 * and the CLI that applies overrides is the one that opens bundles.
 */
export function overrideOwner(
  scope: EnvironmentScope,
  principal: Principal,
  denied?: (decision: Denial) => void,
): OverrideOwner {
  if (principal.kind === 'serviceToken') {
    throw errors.forbidden(
      'Personal overrides belong to a person. A service token never reads or writes one, ' +
        'so a CI run always gets the shared values.',
    );
  }
  if (denied === undefined) authorize(scope, 'secret.read');
  else auditingDenials(denied, () => authorize(scope, 'secret.read'));
  if (scope.environment.encryptionMode !== 'e2ee') {
    throw errors.conflict(
      'e2ee_required: personal overrides need an end-to-end encrypted environment.',
    );
  }
  return {
    orgId: scope.organization.id,
    environmentId: scope.environment.id,
    userId: principal.kind === 'user' ? principal.user.id : principal.userId,
  };
}
