'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';

import { api } from '@/lib/api';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { apiPath, withQuery } from '@/app/(dashboard)/_lib/paths';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import { ChangeError, PlanLock } from '@/components/plans/plan-notice';
import { useOrgPolicies } from '@/components/policies/secret-policy-context';
import type { EnvironmentChangeResponse, EnvironmentDetail } from '@/components/projects/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Skeleton,
  Switch,
  useToast,
} from '@/components/ui';
import {
  alertsDormant,
  exportDisabled,
  readAlertDefault,
  readAlertsOn,
  readAlertsReset,
  readAlertsSource,
  switchLock,
} from './environment-policy';
import type { SwitchLock } from './environment-policy';
import { alertState, principalLine, sightingsNotice } from './read-sightings';
import type { ReadSightingsResponse } from './read-sightings';

/** How many sightings the list asks for — the route's own default. */
const SIGHTINGS_LIMIT = 50;

type Pending = 'export' | 'alerts' | 'reset' | null;

/**
 * The environment's two policy switches (P19 §7, §9), and the list the second
 * one feeds.
 *
 * ── Switches, not a form ──
 * Each takes effect when flipped, exactly as the single sign-on policies do:
 * both are one decision each, and a Save button under two switches would make
 * the intermediate state — one flipped, one not, nothing sent — something a
 * person has to remember.
 *
 * ── The plan, in one direction only ──
 * Disabling export needs Team and switching read alerts on where they would
 * otherwise be off needs Pro; undoing either never needs a plan. So the lock is
 * drawn on the "on" direction of a switch that is off, and never on one that
 * is on — see `environment-policy.ts`. The organisation's feature list comes
 * from `GET /policies`, the one place the dashboard is told what the plan
 * includes before anybody tries; until it arrives, the switches are usable and
 * a refusal still arrives, with its upgrade target, through `ChangeError`.
 *
 * ── The list ──
 * "Recent new addresses" is the in-app half of the alert: every principal and
 * address that has read this environment, when, and whether the alert covering
 * it has gone out. It needs `environment.update` — it is a map of everybody who
 * reads the environment and from where, which no build needs — so it is only
 * asked for by somebody who can manage the environment.
 */
export function EnvironmentPolicyCard({
  orgSlug,
  projectSlug,
  environment,
  canManage,
  onChanged,
}: {
  orgSlug: string;
  projectSlug: string;
  environment: EnvironmentDetail;
  /** Whether the viewer holds `environment.update`. The server still decides. */
  canManage: boolean;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const policies = useOrgPolicies(orgSlug);
  const sightings = useApiResource<ReadSightingsResponse>(
    canManage
      ? withQuery(apiPath.readSightings(orgSlug, projectSlug, environment.slug), {
          limit: SIGHTINGS_LIMIT,
        })
      : null,
  );

  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<unknown>(null);

  const features = policies.data?.features ?? null;
  const disabled = exportDisabled(environment);
  const alertsOn = readAlertsOn(environment);
  const exportLock = switchLock(disabled, features?.disableEnvExport ?? null);
  const alertsLock = switchLock(alertsOn, features?.newIpReadAlerts ?? null);
  const reset = readAlertsReset(environment);
  const resetLocked =
    reset !== null && reset.turnsOn && features !== null && !features.newIpReadAlerts.enabled;
  const dormant = alertsDormant(environment, features?.newIpReadAlerts ?? null);

  async function patch(
    kind: Exclude<Pending, null>,
    body: { plaintextExport?: 'allowed' | 'disabled'; readAlerts?: boolean | null },
    title: string,
  ) {
    if (pending !== null) return;
    setPending(kind);
    setError(null);
    try {
      await api.patch<EnvironmentChangeResponse>(
        apiPath.environmentPolicy(orgSlug, projectSlug, environment.slug),
        body,
      );
      toast({ variant: 'success', title });
      onChanged();
      // Whether reads are recorded at all may just have changed, and the list
      // says so in its empty state.
      if (canManage) void sightings.reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Policy</CardTitle>
        <CardDescription>
          Whether this environment’s values may be written to a file, and whether a read from a new
          address alerts the organisation’s owners and admins.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {error !== null ? <ChangeError error={error} /> : null}

        {!canManage ? (
          <p className="text-fg-subtle text-sm">
            Only an owner or admin can change this environment’s policy.
          </p>
        ) : null}

        <PolicySwitch
          id={`export-${environment.slug}`}
          label="Disable plaintext export"
          description={
            <>
              <code className="font-mono">xecret pull</code>,{' '}
              <code className="font-mono">xecret export</code> and the download on this
              environment’s page refuse to put its values in a file.{' '}
              <code className="font-mono">xecret run</code> is unaffected — it hands values to a
              process without writing them anywhere — so builds and deploys keep working. It cannot
              stop somebody who may read a value from writing it down; what it removes is the
              one-command route from the vault to an unencrypted file on a laptop.
            </>
          }
          checked={disabled}
          lock={exportLock}
          lockWhat="Disabling plaintext export"
          canManage={canManage}
          saving={pending === 'export'}
          busy={pending !== null}
          onChange={(next) =>
            void patch(
              'export',
              { plaintextExport: next ? 'disabled' : 'allowed' },
              next
                ? `Plaintext export is disabled for ${environment.name}`
                : `Plaintext export is allowed again for ${environment.name}`,
            )
          }
          footer={
            disabled && features !== null && !features.disableEnvExport.enabled ? (
              <p className="text-fg-subtle mt-1.5 text-sm leading-5">
                The plan no longer includes this switch, and it stays on: a control this
                organisation chose is not removed by a downgrade. Switching it off is always
                possible.
              </p>
            ) : null
          }
        />

        <PolicySwitch
          id={`alerts-${environment.slug}`}
          label="Alert on reads from new addresses"
          description={
            <>
              The first time this environment is read from an address — or by a device — not seen
              reading it before, the owners and admins get an email: at most one an hour, listing
              what is new. It names who read and from where, never a secret.{' '}
              <span className="text-fg">{readAlertsSource(environment)}</span>
            </>
          }
          checked={alertsOn}
          lock={alertsLock}
          lockWhat="Switching read alerts on"
          canManage={canManage}
          saving={pending === 'alerts'}
          busy={pending !== null}
          onChange={(next) =>
            void patch(
              'alerts',
              { readAlerts: next },
              next
                ? `Read alerts are on for ${environment.name}`
                : `Read alerts are off for ${environment.name}`,
            )
          }
          footer={
            <>
              {dormant ? (
                <Alert tone="warning" title="On, but nothing is being sent" className="mt-2">
                  The plan no longer includes read alerts, so reads are not recorded and no email
                  goes out. The switch keeps its setting and works again once the plan includes
                  alerts.
                </Alert>
              ) : null}
              {canManage && reset !== null ? (
                <div className="mt-2 flex flex-col items-start gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-ml-2"
                    loading={pending === 'reset'}
                    disabled={(pending !== null && pending !== 'reset') || resetLocked}
                    onClick={() =>
                      void patch(
                        'reset',
                        { readAlerts: null },
                        `Read alerts for ${environment.name} are back to the default`,
                      )
                    }
                  >
                    Reset to default ({readAlertDefault(environment.isProduction) ? 'on' : 'off'})
                  </Button>
                  {resetLocked && features !== null ? (
                    <PlanLock
                      what="Resetting to the default, which switches alerts on here,"
                      upgradeTo={features.newIpReadAlerts.upgradeTo}
                    />
                  ) : null}
                </div>
              ) : null}
            </>
          }
        />

        {canManage ? (
          <section
            aria-labelledby={`sightings-${environment.slug}`}
            className="flex flex-col gap-2"
          >
            <h3 id={`sightings-${environment.slug}`} className="text-fg text-sm font-medium">
              Recent new addresses
            </h3>
            <SightingsList response={sightings.data} error={sightings.error} />
            {sightings.error !== null ? (
              <div>
                <Button variant="secondary" size="sm" onClick={() => void sightings.reload()}>
                  Try again
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * One switch, its explanation, and — only where switching it on is refused by
 * the plan — the plan that would allow it.
 */
function PolicySwitch({
  id,
  label,
  description,
  checked,
  lock,
  lockWhat,
  canManage,
  saving,
  busy,
  onChange,
  footer,
}: {
  id: string;
  label: string;
  description: ReactNode;
  checked: boolean;
  lock: SwitchLock;
  /** The act the lock is about, as a phrase that can start a sentence. */
  lockWhat: string;
  canManage: boolean;
  saving: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
  footer?: ReactNode;
}) {
  const hintId = `${id}-plan`;
  return (
    <div className="border-line rounded-lg border p-3.5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor={id}>{label}</Label>
          <p className="text-fg-muted mt-1 text-sm leading-5">{description}</p>
          {lock.locked && canManage ? (
            <div className="mt-1.5">
              <PlanLock id={hintId} what={lockWhat} upgradeTo={lock.upgradeTo} />
            </div>
          ) : null}
        </div>
        <Switch
          id={id}
          checked={checked}
          disabled={!canManage || lock.locked || busy}
          aria-busy={saving || undefined}
          aria-describedby={lock.locked ? hintId : undefined}
          onCheckedChange={onChange}
        />
      </div>
      {footer}
    </div>
  );
}

/**
 * The sightings, newest first, or the sentence that explains their absence.
 *
 * One row per principal and address: who, as what kind of credential, from
 * where, when first and last seen, and whether the email covering it has gone
 * out. A row whose alert is still owed says it waits for the hourly digest —
 * the organisation was mailed less than an hour ago — which is the honest
 * answer to "why did nobody get told?".
 */
function SightingsList({
  response,
  error,
}: {
  response: ReadSightingsResponse | null;
  error: unknown;
}) {
  if (error !== null) {
    return <ChangeError error={error} title="The recent addresses could not be loaded" />;
  }
  if (response === null) {
    return (
      <div aria-busy="true" aria-label="Loading recent addresses" className="flex flex-col gap-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  const notice = sightingsNotice(response);

  return (
    <>
      {notice !== null ? (
        <div className="flex flex-col gap-1">
          <p className="text-fg-subtle text-sm leading-5">{notice.text}</p>
          {notice.kind === 'unentitled' ? (
            <PlanLock what="Recording new addresses" upgradeTo={response.alerts.upgradeTo} />
          ) : null}
        </div>
      ) : null}

      {response.sightings.length > 0 ? (
        <ul className="border-line divide-line-subtle divide-y rounded-lg border">
          {response.sightings.map((sighting) => {
            const { who, kind } = principalLine(sighting);
            const sent = alertState(sighting) === 'sent';
            return (
              <li key={sighting.id} className="flex flex-col gap-1 px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <span className="text-fg min-w-0 truncate text-sm font-medium" title={who}>
                    {who}
                  </span>
                  <Badge tone={sent ? 'neutral' : 'warning'}>
                    {sent ? 'Alert sent' : 'In the next digest'}
                  </Badge>
                </div>
                <p className="text-fg-subtle flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
                  <span>{kind}</span>
                  <span className="text-fg-muted font-mono">{sighting.address}</span>
                  <span>
                    first{' '}
                    <time
                      dateTime={toIsoString(sighting.firstSeenAt)}
                      title={formatAbsoluteTime(sighting.firstSeenAt)}
                    >
                      {formatRelativeTime(sighting.firstSeenAt)}
                    </time>
                  </span>
                  <span>
                    last{' '}
                    <time
                      dateTime={toIsoString(sighting.lastSeenAt)}
                      title={formatAbsoluteTime(sighting.lastSeenAt)}
                    >
                      {formatRelativeTime(sighting.lastSeenAt)}
                    </time>
                  </span>
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}
