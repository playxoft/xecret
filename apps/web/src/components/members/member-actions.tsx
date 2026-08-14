'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { canAssignRole } from '@xecret/core/authz';
import type { OrgRole } from '@xecret/core/authz';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import { apiPath, appPath } from '@/app/(dashboard)/_lib/paths';
import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  MoreHorizontalIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@/components/ui';
import { ROLE_LABELS, ROLES_DESCENDING } from './types';
import type { Member } from './types';

/**
 * The controls on one member row: the role select and the actions menu.
 *
 * Rendered only when the viewer can plausibly complete the action — their role
 * is at least `admin`, the row is not their own, and the member's role is not
 * above theirs. The server re-checks all three (plus the last-owner guard,
 * which only the database can answer); what happens here is merely that a
 * control which would certainly fail is not drawn. `session.tsx` explains the
 * rule: role decides what is rendered, never what is permitted.
 */
export function MemberRowActions({
  orgSlug,
  member,
  viewerRole,
  onChanged,
}: {
  orgSlug: string;
  member: Member;
  viewerRole: OrgRole;
  onChanged: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [suspending, setSuspending] = useState(false);

  const mayManage = !member.isYou && canAssignRole(viewerRole, member.role);

  // Roles the viewer may hand out. The member's current role is always shown
  // so the select reads correctly even when it is the only entry.
  const offeredRoles = ROLES_DESCENDING.filter(
    (candidate) => candidate === member.role || canAssignRole(viewerRole, candidate),
  );

  async function changeRole(role: OrgRole) {
    if (role === member.role || pending) return;
    setPending(true);
    try {
      await api.patch(apiPath.member(orgSlug, member.id), { role });
      toast({
        variant: 'success',
        title: `${member.displayName ?? member.email} is now ${ROLE_LABELS[role].toLowerCase()}`,
      });
      onChanged();
    } catch (cause) {
      toast({
        variant: 'error',
        title: 'That change was not saved',
        description: errorMessage(cause),
      });
    } finally {
      setPending(false);
    }
  }

  if (!mayManage) {
    return (
      <div className="flex items-center justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => router.push(appPath.member(orgSlug, member.id))}
        >
          View access
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      <Select
        value={member.role}
        onValueChange={(next) => void changeRole(next as OrgRole)}
        disabled={pending}
      >
        <SelectTrigger
          className="h-8 w-32"
          aria-label={`Role of ${member.displayName ?? member.email}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {offeredRoles.map((candidate) => (
            <SelectItem key={candidate} value={candidate}>
              {ROLE_LABELS[candidate]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Actions for ${member.displayName ?? member.email}`}
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => router.push(appPath.member(orgSlug, member.id))}>
            View & edit access…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setSuspending(true)}>
            {member.status === 'suspended' ? 'Reinstate…' : 'Suspend…'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => setRemoving(true)}>
            Remove from organisation…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={suspending}
        onOpenChange={setSuspending}
        title={
          member.status === 'suspended'
            ? `Reinstate ${member.displayName ?? member.email}?`
            : `Suspend ${member.displayName ?? member.email}?`
        }
        description={
          member.status === 'suspended'
            ? 'Their role and grants were kept; everything resumes exactly as it was.'
            : 'They stay a member and keep their seat, but every request they make is denied until they are reinstated. Their grants are kept.'
        }
        confirmLabel={member.status === 'suspended' ? 'Reinstate' : 'Suspend'}
        confirmVariant={member.status === 'suspended' ? 'primary' : 'danger'}
        onConfirm={async () => {
          await api.patch(apiPath.member(orgSlug, member.id), {
            status: member.status === 'suspended' ? 'active' : 'suspended',
          });
          toast({
            variant: 'success',
            title:
              member.status === 'suspended'
                ? `Reinstated ${member.displayName ?? member.email}`
                : `Suspended ${member.displayName ?? member.email}`,
          });
          setSuspending(false);
          onChanged();
        }}
      />

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${member.displayName ?? member.email}?`}
        description="Their membership and every access grant they hold are deleted. Secrets they created stay — history is not rewritten. They can be invited again later."
        confirmLabel="Remove member"
        onConfirm={async () => {
          await api.delete(apiPath.member(orgSlug, member.id));
          toast({ variant: 'success', title: `Removed ${member.displayName ?? member.email}` });
          setRemoving(false);
          onChanged();
        }}
      />
    </div>
  );
}
