'use client';

import { useState } from 'react';

import { api } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import { formatAbsoluteTime, formatRelativeTime, initials, toIsoString } from '@/lib/format';
import { pluralize } from '@/lib/format';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@/components/ui';
import { ROLE_LABELS, ROLE_TONE } from './types';
import type { Invitation } from './types';

/**
 * Open invitations: who has been asked to join and has not yet answered.
 *
 * ── Why it is a second table, below the members ──
 * These are the same kind of row as a member — a person, a role, an action
 * that changes their standing — and they were previously a stack of card rows
 * above the member list, which put the people who are *not* in the
 * organisation first and drew them in a different visual language. So it is
 * the member list's table, with the member list's columns, sitting underneath
 * it: the answer to "who is here" comes first, and "who has been asked" reads
 * as a continuation of it rather than as a different feature.
 *
 * Rendered only for people who hold `member.invite` — the server refuses the
 * listing to everyone else, and a section that renders as a 403 is worse than
 * one that is absent. Expired invitations stay visible with their state named,
 * because "why hasn't Alice joined?" is answered here and the repair —
 * re-invite — needs the row to act on.
 */
export function InvitationsSection({
  orgSlug,
  invitations,
  onChanged,
  onReinvite,
}: {
  orgSlug: string;
  invitations: readonly Invitation[];
  /** Reloads the invitation list after a revocation. */
  onChanged: () => void;
  /** Opens the invite dialog pre-committed to re-inviting this address. */
  onReinvite: (invitation: Invitation) => void;
}) {
  const { toast } = useToast();
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const [error, setError] = useState<unknown>(null);

  if (invitations.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-fg text-base font-semibold tracking-tight">Invited</h2>
        <p className="text-fg-muted mt-1 text-sm">
          {pluralize(invitations.length, 'invitation')} sent and not yet accepted. Each one holds a
          seat until it is accepted, revoked, or expires.
        </p>
      </div>

      {error !== null ? (
        <Alert tone="danger" title="That change was not saved">
          {errorMessage(error)}
        </Alert>
      ) : null}

      <TableContainer aria-label="Pending invitations">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invitee</TableHead>
              <TableHead className="w-32">Role</TableHead>
              <TableHead className="w-40">Status</TableHead>
              <TableHead className="w-56">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invitations.map((invitation) => (
              <TableRow key={invitation.id}>
                <TableCell>
                  {/* The same identity block as a member row — avatar bubble,
                      name, secondary line — minus the disclosure triangle,
                      which would promise an access panel that does not exist
                      until they accept. */}
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="bg-surface-active text-fg-muted grid size-7 shrink-0 place-items-center rounded-full text-sm font-semibold"
                    >
                      {initials(invitation.email)}
                    </span>
                    <span className="min-w-0">
                      <span className="text-fg block truncate text-sm font-medium">
                        {invitation.email}
                      </span>
                      {invitation.invitedBy !== null ? (
                        <span className="text-fg-subtle block truncate text-sm">
                          Invited by{' '}
                          {invitation.invitedBy.displayName ?? invitation.invitedBy.email}
                        </span>
                      ) : null}
                    </span>
                  </div>
                </TableCell>

                <TableCell>
                  <Badge tone={ROLE_TONE[invitation.role] ?? 'neutral'}>
                    {ROLE_LABELS[invitation.role]}
                  </Badge>
                </TableCell>

                <TableCell className="text-fg-muted text-sm whitespace-nowrap">
                  {invitation.state === 'expired' ? (
                    <Badge tone="warning">Expired</Badge>
                  ) : (
                    // "Expires" starts the cell, so it starts with a capital:
                    // it is a label in a column, not a clause in a sentence.
                    <>
                      Expires{' '}
                      <time
                        dateTime={toIsoString(invitation.expiresAt)}
                        title={formatAbsoluteTime(invitation.expiresAt)}
                      >
                        {formatRelativeTime(invitation.expiresAt)}
                      </time>
                    </>
                  )}
                </TableCell>

                <TableCell>
                  {/* Buttons that look like buttons. These are the two acts on
                      an invitation, and a bare word in a table cell reads as a
                      label until somebody happens to hover it. */}
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={`Re-invite ${invitation.email}`}
                      onClick={() => onReinvite(invitation)}
                    >
                      Re-invite
                    </Button>
                    <Button
                      size="sm"
                      variant="danger-outline"
                      aria-label={`Revoke the invitation to ${invitation.email}`}
                      onClick={() => setRevoking(invitation)}
                    >
                      Revoke
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke this invitation?"
        description={
          revoking === null
            ? ''
            : `The link sent to ${revoking.email} stops working immediately. You can invite them again later.`
        }
        confirmLabel="Revoke invitation"
        onConfirm={async () => {
          if (revoking === null) return;
          setError(null);
          try {
            await api.delete(apiPath.invitation(orgSlug, revoking.id));
            toast({ variant: 'success', title: `Revoked the invitation to ${revoking.email}` });
            setRevoking(null);
            onChanged();
          } catch (cause) {
            setError(cause);
            throw cause;
          }
        }}
      />
    </section>
  );
}
