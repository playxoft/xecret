'use client';

import { useState } from 'react';

import { uuidv7 } from '@xecret/core/ids';
import { zeroize } from '@xecret/core/crypto/client';
import { ENVIRONMENT_SLUG_PATTERN, slugify, SLUG_MAX_LENGTH } from '@xecret/core/validation';
import { api, isApiError } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { createEnvironmentKeys } from '@/components/envkeys';
import { useVaultKeys } from '@/components/vault';
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
  Label,
  Switch,
  useToast,
} from '@/components/ui';
import type { CreateEnvironmentResponse } from './types';

export interface CreateEnvironmentDialogProps {
  orgSlug: string;
  projectSlug: string;
  /** Used to place the new environment at the end of the existing order. */
  nextSortOrder: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

const NAME_MAX_LENGTH = 100;

/**
 * An environment slug is not a project slug.
 *
 * It permits underscores and forbids nothing by reservation, because it is typed
 * at a shell prompt (`xecret run --env staging_eu`) rather than placed in a
 * globally addressable URL segment. `environmentSlugSchema` is the authority;
 * this restates its pattern so the message can be one sentence.
 */
function validateEnvironmentSlug(slug: string): string | null {
  if (slug.length === 0) return 'Enter a name that contains at least one letter or digit.';
  if (slug.length > SLUG_MAX_LENGTH) return `A slug can be at most ${SLUG_MAX_LENGTH} characters.`;
  if (!ENVIRONMENT_SLUG_PATTERN.test(slug)) {
    return 'Use lowercase letters, digits, hyphens or underscores.';
  }
  return null;
}

/**
 * Adds an environment to a project.
 *
 * ── Why the production switch spells out the consequence ──
 * `isProduction` is not a label. It makes the environment deny-by-default: a
 * developer with no explicit grant cannot read it, cannot write to it, and will
 * not see its values even though they can see that it exists. That is the entire
 * behaviour of the flag, it is invisible from the outside, and someone ticking a
 * box called "Production" has no reason to expect it — so the dialog says it in
 * full rather than in a tooltip nobody opens.
 *
 * Turning the flag *off* later is deliberately much harder than turning it on
 * here: a new environment holds nothing, while reclassifying one that already
 * holds production secrets hands every developer access to them. The server
 * gates the two at different permission levels for exactly that reason.
 *
 * ── Why this needs an unlocked vault ──
 * Every environment created from Phase 3 onward is end-to-end encrypted, and its
 * two keys are generated **here**, in this browser, then sealed to the creator's
 * own public key and signed with their signing key. A locked vault has neither,
 * so the form refuses rather than sending a body the server would reject — the
 * same gate the CLI authorisation page applies, for the same reason.
 *
 * The environment's uuid is minted here too, and that is not bookkeeping: the
 * grant's AAD names the environment (spec §4.2), so the id has to exist before
 * the sealing does. The server stores the row under the id it is given.
 */
export function CreateEnvironmentDialog({
  orgSlug,
  projectSlug,
  nextSortOrder,
  open,
  onOpenChange,
  onCreated,
}: CreateEnvironmentDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent>
        {/* One component down, because Radix unmounts a closed dialog's content
            — which is what makes every open start from empty fields without an
            effect that clears them a render too late. */}
        <CreateEnvironmentForm
          orgSlug={orgSlug}
          projectSlug={projectSlug}
          nextSortOrder={nextSortOrder}
          onOpenChange={onOpenChange}
          onCreated={onCreated}
          onSubmittingChange={setSubmitting}
        />
      </DialogContent>
    </Dialog>
  );
}

function CreateEnvironmentForm({
  orgSlug,
  projectSlug,
  nextSortOrder,
  onOpenChange,
  onCreated,
  onSubmittingChange,
}: {
  orgSlug: string;
  projectSlug: string;
  nextSortOrder: number;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  onSubmittingChange: (submitting: boolean) => void;
}) {
  const { toast } = useToast();
  const vault = useVaultKeys();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [isProduction, setIsProduction] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  /** Kept in step with the parent, which blocks dismissal mid-request. */
  function setBusy(busy: boolean) {
    setSubmitting(busy);
    onSubmittingChange(busy);
  }

  const effectiveSlug = slugEdited ? slug : slugify(name);
  const slugProblem = name.trim().length === 0 ? null : validateEnvironmentSlug(effectiveSlug);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    const trimmedName = name.trim();
    const nextErrors: Record<string, string> = {};
    if (trimmedName.length === 0) nextErrors['name'] = 'Enter an environment name.';
    const slugError = validateEnvironmentSlug(effectiveSlug);
    if (slugError !== null) nextErrors['slug'] = slugError;

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    if (vault === null) {
      setFormError(
        'Unlock your vault first. A new environment is end-to-end encrypted, and its keys are generated in this browser and sealed to your own key.',
      );
      return;
    }

    setBusy(true);
    setFormError(null);

    // Minted here because the grant is sealed against it. The bytes below exist
    // in exactly one place until the request commits — the server writes the
    // environment row and both key rows in one transaction for that reason.
    const environmentId = uuidv7();

    // Generated before the `try` that owns the zeroization, and guarded on its
    // own: a failure here has produced nothing to wipe, and letting it fall
    // through to a `finally` that reads `keys` would be a reference error on top
    // of whatever actually went wrong.
    let keys: Awaited<ReturnType<typeof createEnvironmentKeys>>;
    try {
      keys = await createEnvironmentKeys({ vault, environmentId });
    } catch {
      setBusy(false);
      setFormError('Could not generate this environment’s keys in your browser.');
      return;
    }

    try {
      const created = await api.post<CreateEnvironmentResponse>(
        apiPath.environments(orgSlug, projectSlug),
        {
          id: environmentId,
          name: trimmedName,
          slug: effectiveSlug,
          isProduction,
          sortOrder: nextSortOrder,
          keys: { grant: keys.grant },
        },
      );

      toast({
        variant: 'success',
        title: `Created ${created.environment.name}`,
        description: created.environment.isProduction
          ? 'Production is deny-by-default. Grant access explicitly before anyone can read it.'
          : 'It is empty and ready for its first secret.',
      });

      onOpenChange(false);
      onCreated();
    } catch (cause) {
      setBusy(false);
      if (isApiError(cause)) {
        if (cause.code === 'conflict') {
          setErrors({ slug: 'An environment with this slug already exists in this project.' });
          return;
        }
        const fieldErrors = cause.fieldErrors();
        if (Object.keys(fieldErrors).length > 0) {
          setErrors(fieldErrors);
          return;
        }
      }
      setFormError(cause instanceof Error ? cause.message : 'Could not create the environment.');
    } finally {
      // The environment is re-opened through the ordinary path — `GET …/keys`,
      // open the grant — so there is one way key material enters the store and
      // no second copy of a live data key left in this closure. On the failure
      // path they are simply gone, which is why the write is one transaction.
      zeroize(keys.edk);
      zeroize(keys.ehk);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <DialogHeader>
        <DialogTitle>New environment</DialogTitle>
        <DialogDescription>
          Each environment holds its own secrets, end-to-end encrypted under its own data key —
          generated here, in your browser, and sealed to you. Share it with your team afterwards
          from the environment itself.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <Field label="Name" error={errors['name']}>
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setErrors({});
            }}
            placeholder="Staging (EU)"
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            autoFocus
          />
        </Field>

        <Field
          label="Slug"
          error={errors['slug'] ?? slugProblem}
          hint="Permanent, and the value you pass to xecret run --env."
        >
          <Input
            value={effectiveSlug}
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value);
              setErrors({});
            }}
            placeholder="staging-eu"
            maxLength={SLUG_MAX_LENGTH}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="font-mono"
          />
        </Field>

        <div className="border-line rounded-lg border p-3.5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Label htmlFor="environment-is-production">This is a production environment</Label>
              <p className="text-fg-muted mt-1 text-sm leading-5">
                Production is <span className="text-fg font-medium">deny-by-default</span>. Even
                developers in this organisation cannot read or write its secrets until an admin
                grants them access explicitly, and it is marked in the interface everywhere it
                appears.
              </p>
            </div>
            <Switch
              id="environment-is-production"
              checked={isProduction}
              onCheckedChange={setIsProduction}
            />
          </div>
        </div>

        {formError ? <Alert tone="danger">{formError}</Alert> : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          Create environment
        </Button>
      </DialogFooter>
    </form>
  );
}
