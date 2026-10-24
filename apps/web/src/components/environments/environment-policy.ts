import type { Environment } from '@/components/projects/types';

/**
 * An environment's two policy switches (P19 §7, §9), and what each says about
 * itself — kept apart from the card so the rules are tested without rendering.
 *
 * ── The one rule every switch here follows ──
 * A paid control needs the plan to be switched **on** and never to be switched
 * **off**. Disabling plaintext export needs Team; allowing it again needs
 * nothing. Switching read alerts on where they would otherwise be off needs Pro;
 * switching them off, or back to a default that is off, needs nothing. So a
 * lock is only ever drawn on the "on" direction, and never on a switch that is
 * already on — a lock beside a control the organisation can still use reads as
 * "you are stuck with this", which is the opposite of the truth.
 */

/** The fields of an environment the switches read. */
export type PolicyFields = Pick<
  Environment,
  'isProduction' | 'plaintextExport' | 'readAlerts' | 'readAlertsActive'
>;

/** What the read-alert switch comes to when nobody has set it: on for production. */
export function readAlertDefault(isProduction: boolean): boolean {
  return isProduction;
}

/**
 * Whether read alerts apply to this environment.
 *
 * `readAlertsActive` is the server's own answer and is preferred; the fallback
 * — the stored value, else the production default — is the same rule
 * (`readAlertsActive` in `server/schemas/resources.ts`), for a payload from a
 * server that predates the field.
 */
export function readAlertsOn(environment: PolicyFields): boolean {
  return (
    environment.readAlertsActive ??
    environment.readAlerts ??
    readAlertDefault(environment.isProduction)
  );
}

/** Whether plaintext export is switched off for this environment. */
export function exportDisabled(environment: PolicyFields): boolean {
  return environment.plaintextExport === 'disabled';
}

/**
 * One sentence on where the read-alert setting comes from.
 *
 * The default is the part people get wrong: "why are production reads alerting
 * when nobody switched anything on?" has the answer "because it is production",
 * and saying so beside the switch is what makes the reset button make sense.
 */
export function readAlertsSource(environment: PolicyFields): string {
  const fallback = readAlertDefault(environment.isProduction);
  const where = environment.isProduction
    ? 'a production environment'
    : 'an environment outside production';

  if (environment.readAlerts === null || environment.readAlerts === undefined) {
    return fallback
      ? 'On by default, because this is a production environment.'
      : 'Off by default, because this environment is not marked production.';
  }
  if (environment.readAlerts === fallback) {
    return `Set ${fallback ? 'on' : 'off'} for this environment — the same as the default for ${where}.`;
  }
  return `Set ${environment.readAlerts ? 'on' : 'off'} for this environment. The default for ${where} is ${fallback ? 'on' : 'off'}.`;
}

/**
 * What "reset to default" would do, or `null` when there is nothing to reset.
 *
 * `turnsOn` is the case the plan cares about: resetting a production
 * environment whose alerts were switched off puts them back on, and the server
 * asks the plan of exactly that.
 */
export function readAlertsReset(environment: PolicyFields): { turnsOn: boolean } | null {
  if (environment.readAlerts === null || environment.readAlerts === undefined) return null;
  const after = readAlertDefault(environment.isProduction);
  return { turnsOn: after && !readAlertsOn(environment) };
}

/** A switch's plan state: whether the "on" direction is locked, and by which plan. */
export interface SwitchLock {
  /** True when switching *on* is refused by the plan. Never true for a switch that is on. */
  locked: boolean;
  upgradeTo: string | null;
}

/**
 * Whether to lock a switch's "on" direction.
 *
 * `feature` is `null` while the organisation's policies are still loading or
 * could not be read — and an unknown answer is not a "no". The switch is left
 * usable, and the server's refusal, if there is one, arrives with its upgrade
 * target through `ChangeError`.
 */
export function switchLock(
  checked: boolean,
  feature: { enabled: boolean; upgradeTo: string | null } | null,
): SwitchLock {
  if (checked || feature === null || feature.enabled) {
    return { locked: false, upgradeTo: feature?.upgradeTo ?? null };
  }
  return { locked: true, upgradeTo: feature.upgradeTo };
}

/**
 * Whether the alerts are on here but not being delivered, because the plan no
 * longer includes them.
 *
 * Unlike the export switch — a control the customer chose, kept enforced
 * through a downgrade — an alert is a service, and it stops when the plan
 * stops. The switch keeps its setting and starts working again on an upgrade,
 * which is exactly what this lets the card say instead of leaving a switch that
 * looks on and does nothing.
 */
export function alertsDormant(
  environment: PolicyFields,
  feature: { enabled: boolean } | null,
): boolean {
  return readAlertsOn(environment) && feature !== null && !feature.enabled;
}
