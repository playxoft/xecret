'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ORGANIZATION_NAME_MAX_LENGTH } from '@xecret/core/validation';
import { api, isApiError } from '@/lib/api';
import { apiPath, appPath } from '@/app/(dashboard)/_lib/paths';
import {
  Alert,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  useToast,
} from '@/components/ui';
import type { OrganizationResponse } from '@/components/projects/types';
import { useOrganizationCreateLock, usePlanView } from '@/components/plans/plan-entitlements';
import { freeAllowanceNotice } from '@/components/plans/plan-gate';
import { LockedAction, PlanLockNotice } from '@/components/plans/plan-lock';

export interface CreateOrganizationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called once the organisation exists, and **awaited** before the navigation
   * to it.
   *
   * The shell's copy of the membership list comes from `GET /api/auth/me`, and
   * nothing about creating an organisation invalidates it on its own — so
   * without this the switcher would keep listing the old set while the user
   * stood inside the new organisation.
   *
   * Awaited rather than fired and forgotten because the page being navigated to
   * is drawn from that list: pushing first means the shell resolves the new
   * organisation's id against a list that does not contain it yet, falls back
   * to the first organisation it does know, and briefly labels the new
   * organisation's page with somebody else's name.
   */
  onCreated?: () => void | Promise<void>;
}

/**
 * Creates an organisation.
 *
 * ── Why this is a dialog and not a page ──
 * There is one field. A route for it would mean a navigation away from whatever
 * the user was doing, a back button that returns them to a form they have
 * already submitted, and a screen whose only content is an input — for a
 * decision that takes four seconds.
 *
 * ── Why a stray click does not dismiss it ──
 * Everything else here is a soft delete or a rename; this is the one dialog in
 * the shell that is *reached from the sidebar*, which is exactly where a
 * mis-aimed click lands. Losing a half-typed name to one is a small annoyance
 * repeated often, so pointer and focus dismissal are both refused. Escape and
 * Cancel still work — a modal that can only be left with the mouse is a trap for
 * anyone who is not using one.
 *
 * ── Why it asks for a name and nothing else ──
 * An organisation is addressed by the id it is created with: every URL, every
 * link the product mails, every path the CLI calls. So there is no identifier
 * here to choose, check or get wrong, and the name is only a label: any text,
 * changeable later, and not unique. Two organisations called "Acme" are two
 * organisations. The slug the database still keeps is the server's, derived
 * from the id and shown to nobody.
 */
export function CreateOrganizationDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateOrganizationDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent
        // Both halves of "outside": a click on the backdrop, and focus leaving
        // for something behind it. Preventing only the first leaves the dialog
        // dismissible by a stray Tab into the page beneath.
        onInteractOutside={(event) => event.preventDefault()}
        className="max-w-md"
      >
        {/* The form lives one component down because Radix unmounts a closed
            dialog's content. Its state is therefore fresh on every open, with no
            effect resetting it after a render in which the previous value was
            still on screen. */}
        <CreateOrganizationForm
          onOpenChange={onOpenChange}
          onSubmittingChange={setSubmitting}
          {...(onCreated ? { onCreated } : {})}
        />
      </DialogContent>
    </Dialog>
  );
}

function CreateOrganizationForm({
  onOpenChange,
  onSubmittingChange,
  onCreated,
}: {
  onOpenChange: (open: boolean) => void;
  onSubmittingChange: (submitting: boolean) => void;
  onCreated?: () => void | Promise<void>;
}) {
  const router = useRouter();
  const { toast } = useToast();
  // The free allowance, from the shell's read of the plan, said before Create
  // is pressed: two Free organisations already working means this one will
  // wait for a paid plan, and one already waiting means this one cannot be
  // made until that one is paid for or deleted.
  const view = usePlanView();
  const createLock = useOrganizationCreateLock();
  const allowanceNotice =
    view?.entitlements == null ? null : freeAllowanceNotice(view.entitlements);

  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Split two ways, because they are read in two places. A rejected name
  // belongs under its own field; a rate limit or a lost connection is a
  // property of the attempt and belongs at the foot of the form, where it does
  // not read as an instruction to retype the name.
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  /** Kept in step with the parent, which blocks dismissal mid-request. */
  function setBusy(busy: boolean) {
    setSubmitting(busy);
    onSubmittingChange(busy);
  }

  const trimmed = name.trim();
  // Trimmed rather than raw: a name of three spaces is a name the server will
  // refuse, and a Create button that is enabled for it promises otherwise.
  const isEmpty = trimmed.length === 0;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || isEmpty) return;

    setBusy(true);
    setNameError(null);
    setFormError(null);

    try {
      const created = await api.post<OrganizationResponse & { awaitingPaidPlan?: boolean }>(
        apiPath.orgs(),
        { name: trimmed },
      );
      const awaiting = created.awaitingPaidPlan === true;

      toast({
        variant: 'success',
        title: `Created ${created.organization.name}`,
        description: awaiting
          ? 'Choose a plan for it to start using it.'
          : 'Create your first project to start storing secrets.',
      });

      onOpenChange(false);
      // Awaited, so the shell's membership list already contains the new
      // organisation when its page mounts. Fired and forgotten, the push landed
      // first: the shell could not find the new id in the list it still held,
      // fell back to the first organisation it knew, and drew that one's name
      // over the new organisation's page until the refetch caught up.
      await onCreated?.();
      // Past the free allowance it waits for a plan, so it opens on the page
      // that buys one, under the banner that says why.
      router.push(
        awaiting ? appPath.orgPlans(created.organization.id) : appPath.org(created.organization.id),
      );
    } catch (cause) {
      if (isApiError(cause)) {
        const fields = cause.fieldErrors();
        if (fields['name'] !== undefined) {
          setNameError(fields['name']);
          return;
        }
        setFormError(cause.message);
        return;
      }
      // Anything that is not an `ApiError` is collapsed to a fixed sentence for
      // the reason `errorMessage` gives: an arbitrary exception's message may
      // have been built from the request payload.
      setFormError('Could not create the organisation.');
    } finally {
      // Released on *every* path, including the successful one. It used to be
      // released only on failure, which left the parent believing a request was
      // still in flight for the rest of the session — and the parent is what
      // refuses Escape and outside-click dismissal while one is. So the next
      // time this dialog opened, neither worked, and Cancel was the only way
      // out. `finally` also covers the early returns in the catch above.
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <DialogHeader>
        <DialogTitle>New organisation</DialogTitle>
        <DialogDescription>
          An organisation owns its own projects, members and encryption keys. Nothing is shared with
          the ones you are already in.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <Field
          label="Organisation name"
          error={nameError}
          // The raw length, not the trimmed one: this counts against what the
          // input will still accept, and a counter that disagrees with the point
          // at which typing stops working is worse than no counter.
          hint={`${name.length} of ${ORGANIZATION_NAME_MAX_LENGTH} characters. Any name will do, and you can change it later.`}
        >
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
              setFormError(null);
            }}
            placeholder="Acme"
            maxLength={ORGANIZATION_NAME_MAX_LENGTH}
            autoComplete="organization"
            autoFocus
          />
        </Field>

        {createLock !== null ? (
          <PlanLockNotice lock={createLock} />
        ) : allowanceNotice !== null ? (
          <Alert tone="info">{allowanceNotice}</Alert>
        ) : null}

        {formError !== null ? <Alert tone="danger">{formError}</Alert> : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        {/* Disabled for the one thing that is certainly wrong, no name, rather
            than failing on submit. The server has the final say either way. */}
        <LockedAction lock={createLock}>
          <Button type="submit" variant="primary" loading={submitting} disabled={isEmpty}>
            Create
          </Button>
        </LockedAction>
      </DialogFooter>
    </form>
  );
}
