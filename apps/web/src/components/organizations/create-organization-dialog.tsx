'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  normalizeSlugInput,
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_SLUG_MAX_LENGTH,
  slugify,
} from '@xecret/core/validation';
import { api, isApiError } from '@/lib/api';
import { apiPath, appPath, dashboardHost } from '@/app/(dashboard)/_lib/paths';
import {
  Alert,
  AlertTriangleIcon,
  Button,
  CheckCircleIcon,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Spinner,
  useToast,
} from '@/components/ui';
import type { OrganizationResponse } from '@/components/projects/types';
import { describeSlugProblem, useSlugAvailability } from './use-slug-availability';
import type { SlugAvailability } from './use-slug-availability';

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
   * organisation's slug against a list that does not contain it yet, falls back
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
 * ── Why the slug is shown, editable, and checked ──
 * An organisation slug is permanent and lives in a namespace shared with every
 * other tenant. The earlier version of this form hid it and let the server
 * suffix on collision, which meant somebody who typed "Acme" could end up with
 * `acme-2` in every URL forever, chosen for them, because of a stranger they
 * cannot see.
 *
 * So it is shown from the first keystroke, derived live from the name, editable,
 * and checked against `GET /api/orgs/availability` while they type. Immutable is
 * a defensible property for an identifier that lands in URLs and CLI config.
 * Immutable *and* auto-assigned is not — the permanence is only fair if the
 * choice was theirs.
 *
 * The check is a courtesy, not a gate: it is a snapshot, the unique index is the
 * real arbiter, and `POST /api/orgs` still answers with a field error if the
 * slug is claimed in between. See `use-slug-availability.ts`.
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

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  // Until the slug is touched it follows the name. After that it stops, because
  // silently overwriting a deliberate choice on the next keystroke is maddening
  // — and this choice is permanent.
  const [slugEdited, setSlugEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Split three ways, because they are read in three places. A rejected name or
  // slug belongs under its own field; a rate limit or a lost connection is a
  // property of the attempt and belongs at the foot of the form, where it does
  // not read as an instruction to retype either.
  const [nameError, setNameError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
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

  const effectiveSlug = slugEdited ? slug : slugify(name);
  const availability = useSlugAvailability(effectiveSlug);

  // A local rule failure outranks the server's answer, and the server's answer
  // outranks nothing — an `unknown` result is not shown at all. `slugError` is
  // set only by a rejected submission, so it wins over both.
  const slugProblem =
    slugError ??
    (availability.state === 'invalid' || availability.state === 'taken'
      ? availability.message
      : null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || isEmpty) return;

    // Re-checked at submit rather than trusted from the typeahead: the field may
    // have been edited since the last debounce fired, and this is the rule that
    // must hold. Availability is deliberately *not* re-checked here — the server
    // settles that, and a second round trip would only widen the same race.
    const problem = describeSlugProblem(effectiveSlug);
    if (problem !== null) {
      setSlugError(problem);
      return;
    }

    setBusy(true);
    setNameError(null);
    setSlugError(null);
    setFormError(null);

    try {
      const created = await api.post<OrganizationResponse>(apiPath.orgs(), {
        name: trimmed,
        slug: effectiveSlug,
      });

      toast({
        variant: 'success',
        title: `Created ${created.organization.name}`,
        description: `Its slug is ${created.organization.slug}, and it starts with a default project.`,
      });

      onOpenChange(false);
      // Awaited, so the shell's membership list already contains the new
      // organisation when its page mounts. Fired and forgotten, the push landed
      // first: the shell could not find the new slug in the list it still held,
      // fell back to the first organisation it knew, and drew that one's name
      // over the new organisation's page until the refetch caught up.
      await onCreated?.();
      router.push(appPath.org(created.organization.slug));
    } catch (cause) {
      if (isApiError(cause)) {
        const fields = cause.fieldErrors();
        // The slug first: a 409 from losing the race arrives as a field error on
        // it, and that is the one the user can act on.
        if (fields['slug'] !== undefined) {
          setSlugError(fields['slug']);
          return;
        }
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
          hint={`${name.length} of ${ORGANIZATION_NAME_MAX_LENGTH} characters. You can change this later.`}
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

        <Field
          label="Slug"
          error={slugProblem}
          hint={
            <>
              <span className="text-fg-muted">
                {dashboardHost()}/app/
                <span className="text-fg font-mono">{effectiveSlug || '…'}</span>
              </span>
              <br />
              Permanent. It appears in every URL for this organisation and cannot be changed later,
              so this is the moment to get it right.
            </>
          }
        >
          <div className="relative">
            <Input
              value={effectiveSlug}
              onChange={(event) => {
                setSlugEdited(true);
                // `normalizeSlugInput`, never `slugify`. The latter strips
                // trailing hyphens, which makes `acme-corp` untypable — the
                // hyphen disappears the moment it is pressed. This lowercases
                // and substitutes without deleting, so a trailing hyphen stays
                // on screen and the field explains it instead.
                setSlug(normalizeSlugInput(event.target.value));
                setSlugError(null);
                setFormError(null);
              }}
              placeholder="acme"
              maxLength={ORGANIZATION_SLUG_MAX_LENGTH}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="pr-9 font-mono"
            />
            <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center">
              <AvailabilityIndicator availability={availability} />
            </span>
          </div>
        </Field>

        {formError !== null ? <Alert tone="danger">{formError}</Alert> : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        {/* Disabled for the two things that are certainly wrong — no name, and a
            slug that breaks a rule this form already knows — rather than
            failing on submit. Deliberately *not* disabled while the availability
            check is in flight or when it says "taken": the check is a snapshot,
            not an authority, and blocking on it would leave the button dead if
            the request failed for reasons the user cannot see. The server has
            the final say either way. */}
        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          disabled={isEmpty || availability.state === 'invalid'}
        >
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The state of the availability check, as a glyph inside the slug field.
 *
 * Silent for `idle` and `unknown`. Nothing is a better answer than a warning
 * icon when the user has typed nothing yet, or when a background request the
 * form never promised them happened to fail — the create attempt will tell them
 * anything they actually need to know.
 *
 * The visible glyph is `aria-hidden` and paired with a live region, because a
 * tick appearing beside an input is invisible to a screen reader. `polite`, so
 * it waits for a pause in typing rather than interrupting every keystroke.
 */
function AvailabilityIndicator({ availability }: { availability: SlugAvailability }) {
  const announcement =
    availability.state === 'available'
      ? 'That slug is available.'
      : availability.state === 'taken'
        ? availability.message
        : '';

  return (
    <>
      {availability.state === 'checking' ? (
        // `label={null}`: the live region below is this component's single
        // voice, and a spinner announcing "Loading" on every debounce would talk
        // over it.
        <Spinner className="text-fg-subtle size-4" label={null} />
      ) : availability.state === 'available' ? (
        <CheckCircleIcon className="text-success-text size-4" aria-hidden="true" />
      ) : availability.state === 'taken' ? (
        <AlertTriangleIcon className="text-danger-text size-4" aria-hidden="true" />
      ) : null}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
