import type { EnvironmentRecord } from '@xecret/db/repositories';
import { errors } from './errors';
import type { EnvironmentScope } from './tenancy';

/**
 * Disabling plaintext export by policy (P19 §9, `disableEnvExport`, Team and
 * above).
 *
 * ── What the switch can promise, and what it cannot ──
 * It refuses the paths whose whole purpose is to put an environment's values in
 * a file: `xecret pull`, `xecret export`, the dashboard's download, and the
 * server-mode `GET …/export` and document-format `GET …/pull`. It does not, and
 * cannot, stop a member who may read a value from writing it down — they hold
 * it in plaintext the moment they read it, and in an end-to-end encrypted
 * environment they hold the key as well. What it changes is the default: the
 * one-command route from a vault to an unencrypted file on a laptop stops being
 * one command, and the person who wants that file has to ask the people who set
 * the policy. That is the honest claim, and the docs make no larger one.
 *
 * `xecret run` is never affected. It injects values into a process without
 * writing them anywhere, which is exactly the habit the policy exists to
 * encourage, and a CI pipeline that runs a build must keep running it.
 *
 * ── The one bulk plaintext read it does not refuse ──
 * Upgrading a `server`-mode environment to end-to-end encryption
 * (`encryption-upgrade.ts`) reads every value and every older version into the
 * upgrading browser in plaintext — more than any export — so that the browser
 * can re-encrypt them. Refusing it outright would pin a policy-protected
 * environment to the one encryption mode in which the server *can* read it,
 * which is the opposite of what the policy is for. So it is narrowed instead:
 * where this switch is on, only an **owner or admin of the organisation** may
 * make that read (and so the upgrade), not every administrator of the
 * environment; the values reach that browser's memory and leave it only as
 * ciphertext, never as a file; and the `secret.read` and
 * `environment.encryption_upgraded` records carry `policyName: plaintextExport`
 * with `enabled: false`, so the policy's owners can see it was used.
 *
 * ── Who enforces it ──
 * For a `server`-mode environment the server refuses the document formats
 * itself, and marks the JSON pull — the one `xecret run` uses, which it cannot
 * tell apart from `xecret pull --format json` — with `x-xecret-plaintext-export`
 * so the CLI can refuse the second without breaking the first. For an `e2ee`
 * environment every format is rendered by the client, so the bundle carries the
 * policy and the CLI and the dashboard refuse; a modified client that ignores it
 * gets nothing it could not have got by reading the values one at a time.
 *
 * ── The plan ──
 * Turning the switch on needs the feature; turning it off never does, and an
 * organisation that downgrades keeps every switch it set, enforced — "never
 * remove a security control someone already relies on because they
 * downgraded" (P19 §6).
 */

export type PlaintextExport = 'allowed' | 'disabled';

/** The response header a `server`-mode JSON pull carries the policy in. */
export const PLAINTEXT_EXPORT_HEADER = 'x-xecret-plaintext-export';

export function plaintextExportOf(
  environment: Pick<EnvironmentRecord, 'plaintextExportDisabled'>,
): PlaintextExport {
  return environment.plaintextExportDisabled ? 'disabled' : 'allowed';
}

/**
 * The refusal, worded the same in every client: what is refused, the policy
 * that refuses it, and who can change it. The `export_disabled:` prefix is
 * stable, so a client can recognise the refusal without parsing the prose.
 */
export function exportDisabledMessage(scope: EnvironmentScope): string {
  return (
    `export_disabled: plaintext export is disabled for ${scope.project.slug}/${scope.environment.slug} ` +
    'by its environment policy; an owner or admin of the organisation can change it in the ' +
    "environment's settings. 'xecret run' is unaffected."
  );
}

export function assertPlaintextExportAllowed(scope: EnvironmentScope): void {
  if (scope.environment.plaintextExportDisabled) {
    throw errors.forbidden(exportDisabledMessage(scope));
  }
}
