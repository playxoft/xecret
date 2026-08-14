'use client';

import { useState } from 'react';

import { canAssignRole } from '@xecret/core/authz';
import type { OrgRole } from '@xecret/core/authz';
import { api, isApiError } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import {
  Alert,
  Button,
  CopyButton,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@/components/ui';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES_DESCENDING } from './types';
import type { InviteResponse } from './types';

export interface InviteDialogProps {
  orgSlug: string;
  /** The caller's role — bounds which roles the dialog offers at all. */
  viewerRole: OrgRole;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Reloads whatever lists the new invitation should appear in. */
  onInvited: () => void;
}

/**
 * Invites a colleague, then shows the acceptance link exactly once.
 *
 * The two steps are one dialog on purpose. When mail is configured the link is
 * a belt-and-braces copy of what just landed in an inbox; when it is not —
 * self-hosted installs may run without a mail provider — the link is the only
 * delivery there is, and closing the dialog discards it forever. The dialog
 * says which of the two situations the inviter is in rather than letting them
 * guess.
 *
 * The role menu offers nothing above the caller's own role — the same
 * hierarchy the server enforces. Rendering `Owner` to an admin and letting the
 * request fail would be showing a control that is really an error message.
 */
export function InviteDialog({
  orgSlug,
  viewerRole,
  open,
  onOpenChange,
  onInvited,
}: InviteDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent>
        <InviteFlow
          orgSlug={orgSlug}
          viewerRole={viewerRole}
          onOpenChange={onOpenChange}
          onSubmittingChange={setSubmitting}
          onInvited={onInvited}
        />
      </DialogContent>
    </Dialog>
  );
}

function InviteFlow({
  orgSlug,
  viewerRole,
  onOpenChange,
  onSubmittingChange,
  onInvited,
}: {
  orgSlug: string;
  viewerRole: OrgRole;
  onOpenChange: (open: boolean) => void;
  onSubmittingChange: (submitting: boolean) => void;
  onInvited: () => void;
}) {
  const { toast } = useToast();

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('developer');
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  /** Set after a successful invite; flips the dialog to the link step. */
  const [issued, setIssued] = useState<InviteResponse | null>(null);

  const offeredRoles = ROLES_DESCENDING.filter((candidate) => canAssignRole(viewerRole, candidate));

  function setBusy(busy: boolean) {
    setSubmitting(busy);
    onSubmittingChange(busy);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    const trimmed = email.trim();
    if (trimmed.length === 0 || !trimmed.includes('@')) {
      setFieldError('Enter the email address to invite.');
      return;
    }

    setBusy(true);
    setFormError(null);

    try {
      const response = await api.post<InviteResponse>(apiPath.members(orgSlug), {
        email: trimmed,
        role,
      });

      onInvited();
      setIssued(response);
      toast({
        variant: 'success',
        title: `Invited ${trimmed}`,
        ...(response.emailSent ? { description: 'They have been emailed a link to join.' } : {}),
      });
    } catch (cause) {
      if (isApiError(cause) && cause.code === 'conflict') {
        // Either the address already belongs to a member, or the seat limit is
        // full — the server's message says which, and both are addressed to
        // the address field's owner, not to the form at large.
        setFormError(cause.message);
      } else {
        setFormError('The invitation could not be created. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (issued !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Invitation sent</DialogTitle>
          <DialogDescription>
            {issued.emailSent
              ? `${issued.invitation.email} has been emailed a link to join. You can also hand them this link directly:`
              : `Email is not configured for this deployment, so this link is the only copy — share it with ${issued.invitation.email} yourself.`}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          <div className="border-line bg-canvas-inset flex items-center gap-2 rounded-lg border px-3 py-2">
            <code className="text-fg min-w-0 flex-1 truncate text-[0.8125rem]">
              {issued.inviteUrl}
            </code>
            <CopyButton value={issued.inviteUrl} label="Copy invitation link" />
          </div>
          <p className="text-fg-subtle text-xs">
            The link works once, expires in 7 days, and only signs in the invited address. Closing
            this dialog discards it — it cannot be shown again, only re-issued.
          </p>
        </DialogBody>

        <DialogFooter>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <DialogHeader>
        <DialogTitle>Invite a member</DialogTitle>
        <DialogDescription>
          They join with the role you choose. Project and environment access can be narrowed or
          widened per member afterwards.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <Field label="Email" error={fieldError}>
          <Input
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setFieldError(null);
            }}
            placeholder="colleague@example.com"
            autoComplete="off"
            autoFocus
          />
        </Field>

        <Field label="Role" hint={ROLE_DESCRIPTIONS[role]}>
          <Select value={role} onValueChange={(next) => setRole(next as OrgRole)}>
            <SelectTrigger>
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
        </Field>

        {formError ? <Alert tone="danger">{formError}</Alert> : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          Send invitation
        </Button>
      </DialogFooter>
    </form>
  );
}
