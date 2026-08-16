'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api } from '@/lib/api';
import { apiPath, appPath } from '@/app/(dashboard)/_lib/paths';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  useToast,
} from '@/components/ui';
import type { Organization } from '@/components/projects/types';

export interface DeleteOrganizationCardProps {
  organization: Organization;
  /** Re-reads the session so the switcher stops listing what no longer exists. */
  onDeleted: () => void;
}

/**
 * Deleting an organisation.
 *
 * ── Why only an owner sees this ──
 * `org.delete` is the one action an admin is denied outright (`roles.ts`), so
 * rendering the card for one would be offering a button whose only outcome is a
 * 403. The check here decides what is *drawn*; the server decides what is
 * *permitted*, and a browser that renders it anyway gets the same refusal.
 *
 * ── Why the confirmation demands the slug ──
 * This is the widest blast radius the product has. Every project, environment
 * and secret in the organisation stops resolving at once — for every member, not
 * only for the person pressing the button — and the applications reading those
 * secrets keep working until their next deploy, so the mistake surfaces later,
 * to somebody else, during an outage. A dialog with a button under the pointer
 * is a speed bump; typing the slug is the step that cannot be completed by
 * muscle memory.
 *
 * The server requires the same confirmation and re-checks the permission, so
 * neither of those is a client-side courtesy.
 */
export function DeleteOrganizationCard({ organization, onDeleted }: DeleteOrganizationCardProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);

  async function deleteOrganization() {
    await api.delete(apiPath.org(organization.slug), { confirm: organization.slug });

    toast({ variant: 'success', title: `Deleted ${organization.name}` });

    // The session is re-read first: `/app` decides between redirecting to the
    // one remaining organisation and showing the picker, and it decides that
    // from the shell's membership list. Sending the user there while the list
    // still contains the organisation they just deleted would bounce them
    // straight back into a 404.
    onDeleted();
    // `replace`, not `push`: the settings page of a deleted organisation is not
    // somewhere Back should be able to return to.
    router.replace(appPath.root());
  }

  return (
    <>
      <Card className="border-danger/40">
        <CardHeader>
          <CardTitle>Delete this organisation</CardTitle>
          <CardDescription>
            Hides {organization.name} and every project, environment and secret inside it,
            immediately, for every member. Applications pulling those secrets fail at their next
            deploy — which is later, when this is hardest to connect to its cause.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert tone="warning" title="Everyone loses access, not only you">
            Members are not notified and cannot restore it. If you meant to leave rather than to
            close the organisation, remove your own membership on the Members screen instead.
          </Alert>

          <div>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Delete organisation…
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        strength="production"
        confirmPhrase={organization.slug}
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${organization.name}?`}
        description="Every project, member listing, token and secret in this organisation becomes unreachable the moment this completes."
        confirmLabel="Delete organisation"
        onConfirm={deleteOrganization}
      >
        <Alert tone="info" title="Nothing is destroyed">
          This is a soft delete. The rows are hidden, the keys stay wrapped, and the audit records
          that say this organisation existed keep pointing at it. Restoring it is a support request.
        </Alert>
      </ConfirmDialog>
    </>
  );
}
