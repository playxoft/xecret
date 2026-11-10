import { createAuditBuilder } from '@xecret/core/audit';
import type { AuditBuilder } from '@xecret/core/audit';
import {
  appendAuditEvents,
  DELETED_DATA_RETENTION_DAYS,
  listEnvironmentsDueForPurge,
  listOrganizationsDueForPurge,
  listOrganizationsWithDeletedSecrets,
  listProjectsDueForPurge,
  purgeDeletedSecrets,
  purgeEnvironment,
  purgeOrganization,
  purgeProject,
} from '@xecret/db/repositories';
import type { OrganizationDueForPurge } from '@xecret/db/repositories';
import type { ServiceContext } from './context';
import { describeError } from './logging';
import { IdentityProviderUnavailableError, workosProvider } from './workos';

/**
 * The nightly deleted-data purge: organisations, projects, environments and
 * secrets that were deleted at least {@link DELETED_DATA_RETENTION_DAYS} days
 * ago are erased for good. Why thirty days, what is erased and in what order,
 * and what holds a purge back are all in `@xecret/db`'s `deleted-data.ts`; this
 * file runs it, records it, and settles the one thing the database cannot — an
 * organisation's single sign-on link at WorkOS.
 *
 * ── Largest first ──
 * Organisations, then projects, then environments, then individual secrets. A
 * purged organisation takes its projects with it, so each later stage finds
 * less to do; and an environment is never erased by two stages at once, since
 * each takes its row under `SKIP LOCKED`.
 *
 * ── Bounded, and never stopped by one bad row ──
 * Each stage takes at most a fixed number per run ({@link PURGE_LIMITS}); the
 * next night takes the rest. Each organisation, project or environment is its
 * own transaction, so one that fails — logged, with its id — does not hold up
 * the others, and is tried again the next night. The run reports failures so
 * the Cron Trigger's own history shows them.
 *
 * ── Recorded ──
 * Each erasure is one audit record with a `system` actor, written inside the
 * erasure's own transaction: `org.purged`, `project.purged`,
 * `environment.purged`, `secret.purged`. For a project, an environment or a
 * secret of an organisation that still exists, that record is in the
 * organisation's own audit log, beside the `*.deleted` record thirty days
 * before it.
 */

export const PURGE_LIMITS = {
  organizations: 25,
  projects: 100,
  environments: 100,
  /** Secrets per transaction. */
  secretBatch: 100,
  /** Secrets per run, across every organisation. */
  secrets: 2_000,
  /** Organisations read per page when looking for deleted secrets. */
  organizationPage: 100,
} as const;

export interface DeletedDataPurgeReport {
  organizations: number;
  projects: number;
  environments: number;
  secrets: number;
  /** Erasures that failed this run. Each is logged, and the next run tries again. */
  failed: number;
}

const ACTOR_LABEL = 'deleted-data purge';

function purgeAudit(services: ServiceContext, orgId: string): AuditBuilder {
  return createAuditBuilder({
    orgId,
    actorType: 'system',
    actorId: null,
    actorLabel: ACTOR_LABEL,
    ipAddress: null,
    userAgent: null,
    requestId: services.meta.requestId,
  });
}

function sinceDeletion(days: number): string {
  return `${days} days since deletion`;
}

export async function purgeDeletedData(services: ServiceContext): Promise<DeletedDataPurgeReport> {
  const report: DeletedDataPurgeReport = {
    organizations: 0,
    projects: 0,
    environments: 0,
    secrets: 0,
    failed: 0,
  };

  await purgeOrganizations(services, report);
  await purgeProjects(services, report);
  await purgeEnvironments(services, report);
  await purgeSecrets(services, report);

  const erased = report.organizations + report.projects + report.environments + report.secrets;
  if (erased > 0 || report.failed > 0) {
    services.log
      .at('purgeDeletedData')
      .info('Erased data deleted past its retention', { ...report });
  }
  return report;
}

async function purgeOrganizations(
  services: ServiceContext,
  report: DeletedDataPurgeReport,
): Promise<void> {
  const log = services.log.at('purgeDeletedData');
  const reason = sinceDeletion(DELETED_DATA_RETENTION_DAYS);

  for (const organization of await listOrganizationsDueForPurge(
    services.db,
    PURGE_LIMITS.organizations,
  )) {
    try {
      if (!(await releaseSsoLink(services, organization))) continue;
      const purged = await purgeOrganization(services.db, organization.id, async (tx, row) => {
        await appendAuditEvents(tx, [
          purgeAudit(services, row.id).success(
            'org.purged',
            { type: 'org', id: row.id },
            { environmentCount: row.environmentCount, secretCount: row.secretCount, reason },
          ),
        ]);
      });
      if (purged !== null) report.organizations += 1;
    } catch (cause) {
      report.failed += 1;
      log.error('Could not erase a deleted organisation; the next run tries again', {
        orgId: organization.id,
        error: describeError(cause),
      });
    }
  }
}

/**
 * Deletes the WorkOS organisation a deleted organisation's single sign-on was
 * linked to, before the link itself is erased with the row. Answers whether the
 * purge may go ahead.
 *
 * WorkOS out of reach — down, rate limiting, our key refused — holds the purge
 * for the next run: erasing the row first would lose the only record of which
 * WorkOS organisation to remove. Every other answer goes ahead. A 404 means it
 * is already gone; a link made in another WorkOS environment (local development
 * against WorkOS Staging over this database) cannot be removed from here, and
 * neither can anything on a deployment without WorkOS credentials, so those are
 * logged with the id, for an operator to remove by hand, rather than kept for
 * ever.
 */
async function releaseSsoLink(
  services: ServiceContext,
  organization: OrganizationDueForPurge,
): Promise<boolean> {
  if (organization.workosOrgId === null) return true;
  const log = services.log.at('purgeDeletedData');

  let provider: ReturnType<typeof workosProvider>;
  try {
    provider = workosProvider(services.env);
  } catch (cause) {
    log.warn('Erasing an organisation whose WorkOS organisation this deployment cannot remove', {
      orgId: organization.id,
      workosOrgId: organization.workosOrgId,
      error: describeError(cause),
    });
    return true;
  }

  if (organization.workosClientId !== provider.clientId) {
    log.warn('Erasing an organisation linked in another WorkOS environment; remove it there', {
      orgId: organization.id,
      workosOrgId: organization.workosOrgId,
      workosClientId: organization.workosClientId,
    });
    return true;
  }

  try {
    await provider.deleteOrganization(organization.workosOrgId);
    return true;
  } catch (cause) {
    if (cause instanceof IdentityProviderUnavailableError) {
      log.warn('WorkOS could not be reached to remove an organisation; the purge waits a night', {
        orgId: organization.id,
        workosOrgId: organization.workosOrgId,
        reason: cause.reason,
      });
      return false;
    }
    // Refused for something about the request — most often already deleted.
    log.info('WorkOS did not remove an organisation, most likely already gone; erasing it here', {
      orgId: organization.id,
      workosOrgId: organization.workosOrgId,
      error: describeError(cause),
    });
    return true;
  }
}

async function purgeProjects(
  services: ServiceContext,
  report: DeletedDataPurgeReport,
): Promise<void> {
  const log = services.log.at('purgeDeletedData');
  const reason = sinceDeletion(DELETED_DATA_RETENTION_DAYS);

  for (const projectId of await listProjectsDueForPurge(services.db, PURGE_LIMITS.projects)) {
    try {
      const purged = await purgeProject(services.db, projectId, async (tx, row) => {
        await appendAuditEvents(tx, [
          purgeAudit(services, row.orgId).success(
            'project.purged',
            { type: 'project', id: row.id, projectId: row.id },
            {
              projectSlug: row.slug,
              environmentCount: row.environmentCount,
              secretCount: row.secretCount,
              reason,
            },
          ),
        ]);
      });
      if (purged !== null) report.projects += 1;
    } catch (cause) {
      report.failed += 1;
      log.error('Could not erase a deleted project; the next run tries again', {
        projectId,
        error: describeError(cause),
      });
    }
  }
}

async function purgeEnvironments(
  services: ServiceContext,
  report: DeletedDataPurgeReport,
): Promise<void> {
  const log = services.log.at('purgeDeletedData');
  const reason = sinceDeletion(DELETED_DATA_RETENTION_DAYS);

  for (const environmentId of await listEnvironmentsDueForPurge(
    services.db,
    PURGE_LIMITS.environments,
  )) {
    try {
      const purged = await purgeEnvironment(services.db, environmentId, async (tx, row) => {
        await appendAuditEvents(tx, [
          purgeAudit(services, row.orgId).success(
            'environment.purged',
            { type: 'environment', id: row.id, projectId: row.projectId, environmentId: row.id },
            {
              projectSlug: row.projectSlug,
              environmentSlug: row.slug,
              secretCount: row.secretCount,
              reason,
            },
          ),
        ]);
      });
      if (purged !== null) report.environments += 1;
    } catch (cause) {
      report.failed += 1;
      log.error('Could not erase a deleted environment; the next run tries again', {
        environmentId,
        error: describeError(cause),
      });
    }
  }
}

/**
 * Secrets deleted from environments that still exist, organisation by
 * organisation, each kept for its own plan's period
 * (`deletedSecretRetentionDays`). Every organisation with a secret past thirty
 * days is visited, in id order, so one whose secrets are not due yet — a Team
 * organisation inside its restore window — never stands in front of one whose
 * are.
 */
async function purgeSecrets(services: ServiceContext, report: DeletedDataPurgeReport) {
  const log = services.log.at('purgeDeletedData');
  let budget: number = PURGE_LIMITS.secrets;
  let afterOrgId: string | undefined;

  while (budget > 0) {
    const page = await listOrganizationsWithDeletedSecrets(services.db, {
      limit: PURGE_LIMITS.organizationPage,
      afterOrgId,
    });

    for (const { orgId, retentionDays } of page) {
      if (budget <= 0) break;
      try {
        for (;;) {
          const limit = Math.min(PURGE_LIMITS.secretBatch, budget);
          const purged = await purgeDeletedSecrets(
            services.db,
            { orgId, retentionDays, limit },
            async (tx, rows) => {
              const audit = purgeAudit(services, orgId);
              await appendAuditEvents(
                tx,
                rows.map((secret) =>
                  audit.success(
                    'secret.purged',
                    {
                      type: 'secret',
                      id: secret.id,
                      projectId: secret.projectId,
                      environmentId: secret.environmentId,
                    },
                    {
                      secretName: secret.name,
                      projectSlug: secret.projectSlug,
                      environmentSlug: secret.environmentSlug,
                      reason: sinceDeletion(retentionDays),
                    },
                  ),
                ),
              );
            },
          );
          report.secrets += purged.length;
          budget -= purged.length;
          if (purged.length < limit || budget <= 0) break;
        }
      } catch (cause) {
        report.failed += 1;
        log.error('Could not erase an organisation’s deleted secrets; the next run tries again', {
          orgId,
          error: describeError(cause),
        });
      }
    }

    const last = page.at(-1);
    if (page.length < PURGE_LIMITS.organizationPage || last === undefined) break;
    afterOrgId = last.orgId;
  }
}
