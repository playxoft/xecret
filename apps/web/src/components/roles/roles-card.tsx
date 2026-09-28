'use client';

import { useState } from 'react';

import { actionsForBase } from '@xecret/core/authz';
import { PLANS } from '@xecret/core/entitlements';
import type { PlanId } from '@xecret/core/entitlements';
import { CUSTOM_ROLES_PER_ORGANIZATION } from '@xecret/core/validation';
import { api } from '@/lib/api';
import { pluralize } from '@/lib/format';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import { canAdminister } from '@/app/(dashboard)/_components/session';
import type { SessionOrganization } from '@/app/(dashboard)/_components/session';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  PlusIcon,
  Skeleton,
  useToast,
} from '@/components/ui';
import { ACCESS_LEVEL_LABELS, ROLE_LABELS } from '@/components/members/types';
import type { CustomRole, CustomRoleListResponse } from '@/components/members/types';
import { RoleDialog } from './role-dialog';

/** A plan's name as the pricing page says it, from the plan table the server enforces. */
function planName(id: string): string {
  return id in PLANS ? PLANS[id as PlanId].name : id;
}

/**
 * The organisation's custom roles, on its settings page.
 *
 * ── Who sees what ──
 * The list needs `member.update` — role definitions are policy, and stay with
 * the people who apply them — so anybody else is told who manages roles rather
 * than shown an empty card. Of those who can see it:
 *
 *  - **defining and editing** needs an owner or admin who holds no custom role
 *    themselves (`definableBaseRoles` from the session), *and* a plan that
 *    includes custom roles (Enterprise);
 *  - **deleting** needs the same person, on any plan: an organisation that has
 *    left Enterprise can always tidy up, and the API does not gate it. A role
 *    somebody holds cannot be deleted, and its Delete is drawn unavailable
 *    with the reason rather than offered to fail;
 *  - **"New role"** gives way to a sentence at the per-organisation ceiling
 *    the server refuses past.
 *
 * Each absent control is explained in a sentence rather than silently missing,
 * because "why can't I?" has two different answers here — the plan, or who you
 * are — and they are fixed by different people.
 *
 * Assigning a role to somebody happens on the Members page, beside their
 * built-in role; this card says so.
 */
export function RolesCard({
  orgSlug,
  organization,
}: {
  orgSlug: string;
  organization: SessionOrganization | null;
}) {
  const mayList = canAdminister(organization, 'member.update');
  const roles = useApiResource<CustomRoleListResponse>(mayList ? apiPath.roles(orgSlug) : null);
  const { toast } = useToast();

  const [editing, setEditing] = useState<CustomRole | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CustomRole | null>(null);

  const definable = organization?.authority.definableBaseRoles ?? [];
  const mayDefine = definable.length > 0;
  const feature = roles.data?.feature;
  const entitled = feature?.enabled ?? false;
  const upgradeTo = feature?.upgradeTo ?? null;
  const atCeiling = (roles.data?.data.length ?? 0) >= CUSTOM_ROLES_PER_ORGANIZATION;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <CardTitle>Roles</CardTitle>
          <CardDescription>
            Job titles that narrow a built-in role — a Deployer who is a developer without
            production, a Contractor who reads one project. A custom role only ever takes away.
            Assign them on the Members page.
          </CardDescription>
        </div>
        {mayList && mayDefine && entitled && !atCeiling ? (
          <Button variant="secondary" onClick={() => setEditing('new')}>
            <PlusIcon className="size-4" />
            New role
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {!mayList ? (
          <p className="text-fg-subtle text-sm">
            Custom roles are managed by owners and admins who can change members.
          </p>
        ) : roles.error !== null ? (
          <Alert tone="danger" title="The roles could not be loaded">
            <Button variant="secondary" size="sm" onClick={() => void roles.reload()}>
              Try again
            </Button>
          </Alert>
        ) : roles.data === null ? (
          <div aria-busy="true" aria-label="Loading roles" className="flex flex-col gap-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : (
          <>
            {!entitled ? (
              <Alert tone="info" title="Custom roles are an Enterprise feature">
                {upgradeTo !== null
                  ? `Defining and assigning roles needs the ${planName(upgradeTo)} plan.`
                  : 'Defining and assigning roles is not part of this organisation’s plan.'}{' '}
                {roles.data.data.length > 0
                  ? 'The roles below still apply to the people holding them; you can take members off them and delete roles nobody holds.'
                  : null}
              </Alert>
            ) : !mayDefine ? (
              <p className="text-fg-subtle text-sm">
                Only an owner or admin who holds no custom role can define or change roles.
              </p>
            ) : atCeiling ? (
              <p className="text-fg-subtle text-sm">
                This organisation has defined the most roles it can ({CUSTOM_ROLES_PER_ORGANIZATION}
                ). Delete one nobody holds to define another.
              </p>
            ) : null}

            {roles.data.data.length === 0 ? (
              entitled && mayDefine ? (
                <p className="text-fg-subtle text-sm">
                  No custom roles yet. Everybody holds exactly their built-in role.
                </p>
              ) : null
            ) : (
              <ul className="border-line divide-line-subtle divide-y rounded-lg border">
                {roles.data.data.map((role) => (
                  <li
                    key={role.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-fg truncate text-sm font-medium">{role.name}</p>
                      <p className="text-fg-subtle text-sm">{describeRole(role)}</p>
                    </div>
                    <span className="text-fg-muted text-sm whitespace-nowrap">
                      {pluralize(role.holderCount ?? 0, 'member')}
                    </span>
                    {mayDefine ? (
                      <div className="flex items-center gap-1.5">
                        {/* The in-use rule, said where the button is: a role
                            somebody holds cannot be deleted, and a Delete that
                            only ever answers 409 is an error message in
                            disguise. The count can be stale, so the server's
                            409 still reaches the dialog if it is. */}
                        {entitled ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Edit role ${role.name}`}
                            onClick={() => setEditing(role)}
                          >
                            Edit
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger-text hover:text-danger-text"
                          disabled={(role.holderCount ?? 0) > 0}
                          title={
                            (role.holderCount ?? 0) > 0
                              ? 'In use — move its members to another role, or to none, first'
                              : undefined
                          }
                          aria-label={
                            (role.holderCount ?? 0) > 0
                              ? `Delete role ${role.name} — unavailable while ${pluralize(role.holderCount ?? 0, 'member')} ${role.holderCount === 1 ? 'holds' : 'hold'} it`
                              : `Delete role ${role.name}`
                          }
                          onClick={() => setDeleting(role)}
                        >
                          Delete
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>

      {editing !== null ? (
        <RoleDialog
          orgSlug={orgSlug}
          role={editing === 'new' ? null : editing}
          definableBaseRoles={definable}
          open
          onOpenChange={(open) => (open ? undefined : setEditing(null))}
          onSaved={() => void roles.reload()}
        />
      ) : null}

      {deleting !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => (open ? undefined : setDeleting(null))}
          title={`Delete ${deleting.name}?`}
          description={
            (deleting.holderCount ?? 0) > 0
              ? `${pluralize(deleting.holderCount ?? 0, 'member')} still ${deleting.holderCount === 1 ? 'holds' : 'hold'} this role. A role in use cannot be deleted — move them to another role, or to none, on the Members page first.`
              : 'Nobody holds this role, so deleting it changes nobody’s access. The audit log keeps what it allowed.'
          }
          confirmLabel="Delete role"
          onConfirm={async () => {
            // A refusal — the role still in use, above all — is thrown back to
            // the dialog, which shows it in the server's words and stays open.
            await api.delete(apiPath.role(orgSlug, deleting.id));
            toast({ variant: 'success', title: `Deleted ${deleting.name}` });
            setDeleting(null);
            void roles.reload();
          }}
        />
      ) : null}
    </Card>
  );
}

/**
 * One line describing a role, e.g. "Based on Developer · 5 of 13 actions · at
 * most read & write outside production, no access in production".
 */
function describeRole(role: CustomRole): string {
  const offered = actionsForBase(role.baseRole);
  const kept = offered.filter((action) => role.allowedActions.includes(action)).length;
  const parts = [`Based on ${ROLE_LABELS[role.baseRole]}`, `${kept} of ${offered.length} actions`];
  if (role.accessCeiling !== null) {
    parts.push(
      `at most ${ACCESS_LEVEL_LABELS[role.accessCeiling.nonProduction].toLowerCase()} outside production, ${ACCESS_LEVEL_LABELS[role.accessCeiling.production].toLowerCase()} in production`,
    );
  }
  return parts.join(' · ');
}
