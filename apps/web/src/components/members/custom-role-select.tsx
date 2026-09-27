'use client';

import { useState } from 'react';

import { api, errorMessage } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@/components/ui';
import type { CustomRole, Member } from './types';

/** What the row needs to offer custom roles: the list, and whether the plan allows putting anyone on one. */
export interface CustomRoleChoices {
  roles: readonly CustomRole[];
  /**
   * Whether the organisation's plan lets a member be put on a role. When it
   * does not, the select still offers taking the member's role off — the API
   * never gates that — and nothing else.
   */
  assignable: boolean;
}

/** The select's value for "no custom role" — Radix reserves the empty string. */
const NONE = '__none__';

/**
 * A member's custom role, as a select on their row: none, or one of the
 * organisation's roles.
 *
 * Choosing applies immediately, like the built-in role select beside it — one
 * audited `member.custom_role_changed` per choice — and the list reloads so the
 * label and the reachable projects follow. The server re-checks everything:
 * the member's role within the viewer's authority, the held-grant check when
 * the change widens them, and the plan. A refusal is shown as the toast the
 * role select uses, in the server's own words.
 *
 * Not drawn for an owner, who can never hold a custom role — offering one
 * would be a control that only ever answers 409.
 */
export function CustomRoleSelect({
  orgSlug,
  member,
  choices,
  onChanged,
}: {
  orgSlug: string;
  member: Member;
  choices: CustomRoleChoices;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [pending, setPending] = useState(false);

  if (member.role === 'owner') return null;

  const held = member.customRole;
  const current = held?.id ?? NONE;
  // Without the plan, only "none" (so the role can be taken off) and the role
  // the member holds (so the select reads truthfully). The held role is added
  // from the member row if the list lacks it, rather than rendering a select
  // whose value matches no option and so shows nothing.
  const listed: readonly { id: string; name: string }[] = choices.assignable
    ? choices.roles
    : choices.roles.filter((role) => role.id === current);
  const offered =
    held !== null && !listed.some((role) => role.id === held.id) ? [...listed, held] : listed;
  // Nothing to choose between: no roles defined, or none assignable and none held.
  if (offered.length === 0) return null;

  const label = member.displayName ?? member.email;

  async function change(next: string) {
    if (next === current || pending) return;
    setPending(true);
    try {
      await api.patch(apiPath.member(orgSlug, member.id), {
        customRoleId: next === NONE ? null : next,
      });
      const chosen = choices.roles.find((role) => role.id === next);
      toast({
        variant: 'success',
        title:
          chosen === undefined
            ? `${label} no longer holds a custom role`
            : `${label} is now ${chosen.name}`,
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

  return (
    <Select value={current} onValueChange={(next) => void change(next)} disabled={pending}>
      <SelectTrigger className="h-8 w-36" aria-label={`Custom role of ${label}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>No custom role</SelectItem>
        {offered.length > 0 ? <SelectSeparator /> : null}
        {offered.map((role) => (
          <SelectItem key={role.id} value={role.id}>
            {role.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
