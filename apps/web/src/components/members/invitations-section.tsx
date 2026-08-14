'use client';

import { useState } from 'react';

import { api } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  useToast,
} from '@/components/ui';
import { ROLE_LABELS } from './types';
import type { Invitation } from './types';

/**
 * Open invitations: who has been asked to join and has not yet answered.
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
    <Card>
      <CardHeader>
        <CardTitle>Pending invitations</CardTitle>
        <CardDescription>
          Each one holds a seat until it is accepted, revoked, or expires.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {error !== null ? (
          <Alert tone="danger" title="That change was not saved">
            {errorMessage(error)}
          </Alert>
        ) : null}

        <ul className="flex flex-col">
          {invitations.map((invitation) => (
            <li
              key={invitation.id}
              className="border-line-subtle flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 [&:not(:last-child)]:border-b"
            >
              <div className="min-w-0 flex-1">
                <p className="text-fg truncate text-[0.8125rem] font-medium">{invitation.email}</p>
                <p className="text-fg-subtle text-xs">
                  {ROLE_LABELS[invitation.role]}
                  {invitation.invitedBy !== null ? (
                    <>
                      {' '}
                      · invited by {invitation.invitedBy.displayName ?? invitation.invitedBy.email}
                    </>
                  ) : null}
                </p>
              </div>

              {invitation.state === 'expired' ? (
                <Badge tone="warning">Expired</Badge>
              ) : (
                <span className="text-fg-muted text-xs whitespace-nowrap">
                  expires{' '}
                  <time
                    dateTime={toIsoString(invitation.expiresAt)}
                    title={formatAbsoluteTime(invitation.expiresAt)}
                  >
                    {formatRelativeTime(invitation.expiresAt)}
                  </time>
                </span>
              )}

              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => onReinvite(invitation)}>
                  Re-invite
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRevoking(invitation)}>
                  Revoke
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>

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
    </Card>
  );
}
