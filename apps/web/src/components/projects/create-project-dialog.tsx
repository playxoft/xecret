'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { uuidv7 } from '@xecret/core/ids';
import { zeroize } from '@xecret/core/crypto/client';
import {
  DEFAULT_ENVIRONMENTS,
  isReservedSlug,
  slugify,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
} from '@xecret/core/validation';
import { api, isApiError } from '@/lib/api';
import { apiPath, appPath } from '@/app/(dashboard)/_lib/paths';
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
  Textarea,
  useToast,
} from '@/components/ui';
import type { CreateProjectResponse } from './types';

export interface CreateProjectDialogProps {
  orgSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 500;

/**
 * Validates a slug against the same rules the server applies.
 *
 * `slugSchema` lives in `@xecret/core/validation` and this reproduces its three
 * clauses rather than importing it, because a zod `safeParse` returns an issue
 * list written for a developer and this needs one sentence written for the
 * person typing. The rules themselves — pattern, ceiling, reserved list — come
 * from that module, so there is still only one definition of what a valid slug
 * is; only the wording differs.
 */
function validateSlug(slug: string): string | null {
  if (slug.length === 0) {
    return 'Enter a name that contains at least one letter or digit.';
  }
  if (slug.length > SLUG_MAX_LENGTH) {
    return `A slug can be at most ${SLUG_MAX_LENGTH} characters.`;
  }
  if (!SLUG_PATTERN.test(slug)) {
    return 'Use lowercase letters, digits and single hyphens.';
  }
  if (isReservedSlug(slug)) {
    return 'That slug is reserved. Choose a different one.';
  }
  return null;
}

/**
 * Creates a project and its three default environments.
 *
 * ── Why the slug is a field and not a detail ──
 * A project slug is permanent. It goes into every URL, into `.xecret.yaml`, and
 * into the CI configuration of everyone who consumes the project, so the API
 * refuses to change it later — a rename would break every consumer that is not
 * redeployed in the same instant. Something a user cannot undo should not be
 * decided for them behind a disclosure triangle, so it is shown, derived live
 * from the name, and editable until they touch it.
 *
 * ── Why this needs an unlocked vault ──
 * A project is not an empty container that gets environments later: it arrives
 * with development, staging and production, and each of them is end-to-end
 * encrypted. Their keys are generated **here** and sealed to the creator — three
 * times, once per environment — so a locked vault has nothing to seal with and
 * the form refuses rather than sending a body the server would reject. The same
 * gate `CreateEnvironmentDialog` applies, for the reason stated there.
 *
 * The environment uuids are minted here too, because each grant is sealed
 * against one; `projectEnvironmentInitSchema` explains why the server insists on
 * receiving them rather than minting its own.
 */
export function CreateProjectDialog({ orgSlug, open, onOpenChange }: CreateProjectDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent>
        {/* The form lives one component down because Radix unmounts a closed
            dialog's content. Its state is therefore fresh on every open, with no
            effect resetting it after a render in which the previous values were
            still on screen. */}
        <CreateProjectForm
          orgSlug={orgSlug}
          onOpenChange={onOpenChange}
          onSubmittingChange={setSubmitting}
        />
      </DialogContent>
    </Dialog>
  );
}

/** One default environment's client-generated keys, awaiting the create call. */
interface EnvironmentKeys {
  slug: string;
  id: string;
  grant: Awaited<ReturnType<typeof createEnvironmentKeys>>['grant'];
  edk: Awaited<ReturnType<typeof createEnvironmentKeys>>['edk'];
  ehk: Awaited<ReturnType<typeof createEnvironmentKeys>>['ehk'];
}

/**
 * Mints an id and generates a key pair for each of the three default
 * environments.
 *
 * In sequence rather than concurrently, and that is the interesting part: the
 * generation is cheap, but the failure handling is not. If the second of three
 * throws, everything produced so far is key material in a heap that is about to
 * render an error, and it has to be wiped — which is straightforward walking a
 * list built in order and impossible to reason about across three promises
 * settling in whatever order they settle in.
 */
async function generateEnvironmentKeys(
  vault: NonNullable<ReturnType<typeof useVaultKeys>>,
): Promise<EnvironmentKeys[]> {
  const keyed: EnvironmentKeys[] = [];

  try {
    for (const environment of DEFAULT_ENVIRONMENTS) {
      const environmentId = uuidv7();
      const keys = await createEnvironmentKeys({ vault, environmentId });
      keyed.push({ slug: environment.slug, id: environmentId, ...keys });
    }
  } catch (cause) {
    // Nothing downstream will ever be able to use these — the request is not
    // going to be sent — and they are 64 bytes of key material per environment.
    for (const environment of keyed) {
      zeroize(environment.edk);
      zeroize(environment.ehk);
    }
    throw cause;
  }

  return keyed;
}

function CreateProjectForm({
  orgSlug,
  onOpenChange,
  onSubmittingChange,
}: {
  orgSlug: string;
  onOpenChange: (open: boolean) => void;
  onSubmittingChange: (submitting: boolean) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const vault = useVaultKeys();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  // Once the slug has been edited by hand it stops following the name. Silently
  // overwriting a deliberate choice on the next keystroke is maddening.
  const [slugEdited, setSlugEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  /** Kept in step with the parent, which blocks dismissal mid-request. */
  function setBusy(busy: boolean) {
    setSubmitting(busy);
    onSubmittingChange(busy);
  }

  const effectiveSlug = slugEdited ? slug : slugify(name);
  const slugProblem = name.trim().length === 0 ? null : validateSlug(effectiveSlug);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    const trimmedName = name.trim();
    const nextErrors: Record<string, string> = {};
    if (trimmedName.length === 0) nextErrors['name'] = 'Enter a project name.';
    if (trimmedName.length > NAME_MAX_LENGTH) {
      nextErrors['name'] = `A name can be at most ${NAME_MAX_LENGTH} characters.`;
    }
    const slugError = validateSlug(effectiveSlug);
    if (slugError !== null) nextErrors['slug'] = slugError;

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    if (vault === null) {
      setFormError(
        'Unlock your vault first. A new project starts with three end-to-end encrypted environments, and their keys are generated in this browser and sealed to your own key.',
      );
      return;
    }

    setBusy(true);
    setFormError(null);

    // Generated before the `try` that owns the zeroization, and guarded on its
    // own: a failure part-way through has produced material to wipe but nothing
    // to send, and letting it fall through to a `finally` that reads `keyed`
    // would wipe a partial list on top of whatever actually went wrong.
    let keyed: EnvironmentKeys[];
    try {
      keyed = await generateEnvironmentKeys(vault);
    } catch {
      setBusy(false);
      setFormError('Could not generate this project’s environment keys in your browser.');
      return;
    }

    try {
      const created = await api.post<CreateProjectResponse>(apiPath.projects(orgSlug), {
        name: trimmedName,
        slug: effectiveSlug,
        ...(description.trim().length === 0 ? {} : { description: description.trim() }),
        environments: keyed.map((environment) => ({
          slug: environment.slug,
          id: environment.id,
          keys: { grant: environment.grant },
        })),
      });

      toast({
        variant: 'success',
        title: `Created ${created.project.name}`,
        description: `${created.environments.length} environments are ready.`,
      });

      onOpenChange(false);
      router.push(appPath.project(orgSlug, created.project.slug));
    } catch (cause) {
      setBusy(false);
      if (isApiError(cause)) {
        // 409 is the partial unique index on (org_id, slug) refusing a
        // duplicate. It is a property of the slug, so it is shown on that field
        // rather than at the bottom of the form where it reads as unrelated.
        if (cause.code === 'conflict') {
          setErrors({ slug: 'A project with this slug already exists in this organisation.' });
          return;
        }
        const fieldErrors = cause.fieldErrors();
        if (Object.keys(fieldErrors).length > 0) {
          setErrors(fieldErrors);
          return;
        }
      }
      setFormError(cause instanceof Error ? cause.message : 'Could not create the project.');
    } finally {
      // The environments are re-opened through the ordinary path — `GET …/keys`,
      // open the grant — so there is one way key material enters the store and
      // no second copy of a live data key left in this closure. On the failure
      // path they are simply gone, which is why the server writes the project
      // and all six key rows in one transaction.
      for (const environment of keyed) {
        zeroize(environment.edk);
        zeroize(environment.ehk);
      }
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <DialogHeader>
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>
          A project holds one set of secrets per environment. It starts with development, staging
          and production, each end-to-end encrypted under its own key — generated here, in your
          browser, and sealed to you.
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
            placeholder="Payments API"
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            autoFocus
          />
        </Field>

        <Field
          label="Slug"
          error={errors['slug'] ?? slugProblem}
          hint="Permanent. It appears in URLs, in .xecret.yaml and in CI configuration, so it cannot be changed later."
        >
          <Input
            value={effectiveSlug}
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value);
              setErrors({});
            }}
            placeholder="payments-api"
            maxLength={SLUG_MAX_LENGTH}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="font-mono"
          />
        </Field>

        <Field label="Description" optional error={errors['description']}>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this project is, so the next person does not have to guess."
            maxLength={DESCRIPTION_MAX_LENGTH}
            rows={3}
          />
        </Field>

        {formError ? <Alert tone="danger">{formError}</Alert> : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          Create project
        </Button>
      </DialogFooter>
    </form>
  );
}
