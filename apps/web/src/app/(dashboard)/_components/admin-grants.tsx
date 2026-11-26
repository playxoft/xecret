'use client';

import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { planName } from '@/components/plans/plan-copy';
import {
  Button,
  EmptyState,
  ShieldCheckIcon,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import type { AdminGrantPayload } from '@/server/schemas/admin';
import { apiPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { EndGrantDialog, GrantDialog, useDialogTarget } from './admin-grant-dialogs';
import type { GrantTarget } from './admin-grant-dialogs';
import { ErrorState } from './resource-states';

/**
 * The Grants tab: every free plan in force, the soonest to end first — the
 * order the server answers in, so the ones that need a decision this week are
 * at the top — and the two things done to one: change it (extend it, move it
 * to another plan) or end it now.
 *
 * Each row opens the same dialogs as a search result does. What a row cannot
 * say is whether Dodo bills the organisation; a grant is by definition a plan
 * Dodo does not, and in the rare case that changed underneath, the server's
 * refusal says so in the dialog.
 */

const count = (value: number) => value.toLocaleString('en-GB');

function targetOf(grant: AdminGrantPayload): GrantTarget {
  return {
    id: grant.orgId,
    name: grant.orgName,
    slug: grant.orgSlug,
    plan: grant.plan,
    seatLimit: grant.seatLimit,
    grant: { endsAt: grant.endsAt, note: grant.note },
    billedByDodo: false,
    awaitingActivation: false,
  };
}

export function GrantsTab() {
  const grants = useApiResource<{ grants: AdminGrantPayload[] }>(apiPath.adminGrants());
  const changing = useDialogTarget<GrantTarget>();
  const ending = useDialogTarget<GrantTarget>();
  const reload = () => void grants.reload();
  const list = grants.data?.grants ?? null;

  return (
    <div className="flex flex-col gap-4">
      {grants.error !== null ? (
        <ErrorState subject="the free plans" error={grants.error} onRetry={reload} />
      ) : list === null ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<ShieldCheckIcon />}
          title="No organisation has a free plan"
          description="Give one from the Organisations tab, or issue a free-plan code that an owner redeems."
        />
      ) : (
        <TableContainer aria-label="Free plans in force">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Organisation</TableHead>
                <TableHead className="w-28">Plan</TableHead>
                <TableHead className="w-28">Members</TableHead>
                <TableHead className="w-48">Ends</TableHead>
                <TableHead className="w-56">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((grant) => (
                <TableRow key={grant.orgId}>
                  <TableCell>
                    <p className="text-fg text-sm font-medium">{grant.orgName}</p>
                    <p className="text-fg-subtle font-mono text-sm">{grant.orgSlug}</p>
                    {grant.note ? (
                      <p className="text-fg-muted mt-0.5 text-sm">{grant.note}</p>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm">{planName(grant.plan)}</TableCell>
                  <TableCell className="text-fg-muted text-sm">
                    up to {count(grant.seatLimit)}
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap">
                    {grant.endsAt === null ? (
                      <span className="text-fg-muted">No end date</span>
                    ) : (
                      <>
                        <time dateTime={toIsoString(grant.endsAt)} className="text-fg block">
                          {formatAbsoluteTime(grant.endsAt)}
                        </time>
                        <span className="text-fg-subtle block">
                          {formatRelativeTime(grant.endsAt)}
                        </span>
                      </>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={`Change ${grant.orgName}’s free plan`}
                        onClick={() => changing.show(targetOf(grant))}
                      >
                        Change
                      </Button>
                      <Button
                        variant="danger-outline"
                        size="sm"
                        aria-label={`End ${grant.orgName}’s free plan`}
                        onClick={() => ending.show(targetOf(grant))}
                      >
                        End
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <GrantDialog
        target={changing.target}
        open={changing.open}
        onOpenChange={changing.onOpenChange}
        onGranted={reload}
      />
      <EndGrantDialog
        target={ending.target}
        open={ending.open}
        onOpenChange={ending.onOpenChange}
        onEnded={reload}
      />
    </div>
  );
}
