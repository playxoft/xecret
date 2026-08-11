'use client';

import { useState } from 'react';

import { checkSecretName, SECRET_NAME_MAX_LENGTH } from '@xecret/core/validation';
import { api, isApiError } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import {
  Alert,
  Badge,
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
import type { SecretSummary, SecretWriteResponse } from './types';

export interface SecretDialogProps {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
  isProduction: boolean;
  /** Absent creates a secret; present appends a new version to that one. */
  secret?: SecretSummary | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

const NOTE_MAX_LENGTH = 1024;

/**
 * Add a secret, or give an existing one a new value.
 *
 * ── The value is in React state and nowhere else ──
 * It is typed or pasted here, it goes into one request body, and it dies with
 * the component. It is never written to `localStorage` or `sessionStorage` (a
 * draft-restore feature would persist a credential to disk), never placed in the
 * URL (URLs are logged by every proxy on the way and kept in browser history),
 * and never passed to `console` — including in a `catch`, which is the tempting
 * one, because the thing that just failed is the thing holding the plaintext.
 * `lib/api.ts` upholds the same rule from the other side and never logs a body.
 *
 * ── Why the field is not masked ──
 * The user is the source of this value: they are looking at it in their password
 * manager or their terminal as they paste it. Masking here would only make
 * verifying a paste impossible, and the protection that matters — that a stored
 * value is never rendered without an explicit, audited reveal — is a property of
 * the table, not of this form.
 */
export function SecretDialog({ open, onOpenChange, ...rest }: SecretDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-xl">
        {/* One component down, because Radix unmounts a closed dialog's content.
            That is what guarantees the value field starts empty on every open —
            an effect that cleared it would run *after* a render, leaving the
            previous secret's plaintext in the DOM for a frame. */}
        <SecretForm {...rest} onOpenChange={onOpenChange} onSubmittingChange={setSubmitting} />
      </DialogContent>
    </Dialog>
  );
}

function SecretForm({
  orgSlug,
  projectSlug,
  envSlug,
  isProduction,
  secret,
  onOpenChange,
  onSaved,
  onSubmittingChange,
}: Omit<SecretDialogProps, 'open'> & { onSubmittingChange: (submitting: boolean) => void }) {
  const { toast } = useToast();
  const editing = secret !== undefined;

  const [name, setName] = useState(secret?.name ?? '');
  // Never prefilled, even when editing: the current value is only obtainable
  // through the audited reveal endpoint, and seeding it here would decrypt a
  // secret merely because somebody opened a form.
  const [value, setValue] = useState('');
  const [note, setNote] = useState(secret?.note ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  /** Kept in step with the parent, which blocks dismissal mid-request. */
  function setBusy(busy: boolean) {
    setSubmitting(busy);
    onSubmittingChange(busy);
  }

  const nameCheck = name.length === 0 ? null : checkSecretName(name);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    const nextErrors: Record<string, string> = {};

    if (!editing) {
      const check = checkSecretName(name);
      if (!check.valid) nextErrors['name'] = check.message ?? 'That name cannot be used.';
    }
    if (value.length === 0) nextErrors['value'] = 'Enter a value.';

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setBusy(true);
    setFormError(null);

    try {
      if (editing && secret) {
        // PATCH accepts a value and nothing else. The note lives on `secrets`
        // rather than on `secret_versions`, so the endpoint does not offer it
        // rather than silently discarding it.
        const result = await api.patch<SecretWriteResponse>(
          apiPath.secret(orgSlug, projectSlug, envSlug, secret.name),
          { value },
        );

        toast(
          result.secret.status === 'unchanged'
            ? {
                variant: 'info',
                title: `${secret.name} is unchanged`,
                description:
                  'The value you submitted is the one already stored, so no new version was created.',
              }
            : {
                variant: 'success',
                title: `Updated ${secret.name}`,
                description: `Now at version ${result.secret.version}.`,
              },
        );
      } else {
        const result = await api.post<SecretWriteResponse>(
          apiPath.secrets(orgSlug, projectSlug, envSlug),
          {
            name,
            value,
            ...(note.trim().length === 0 ? {} : { note: note.trim() }),
          },
        );
        toast({ variant: 'success', title: `Created ${result.secret.name}` });
      }

      // Dropped from state the moment it is no longer needed. This does not
      // guarantee the string is gone — a JavaScript engine makes no such promise
      // — but leaving it in a live fibre for the rest of the page's life would
      // put it in the next heap snapshot and the next error boundary.
      setValue('');
      onOpenChange(false);
      onSaved();
    } catch (cause) {
      setBusy(false);
      if (isApiError(cause)) {
        if (cause.code === 'conflict') {
          setErrors({ name: 'A secret with this name already exists in this environment.' });
          return;
        }
        const fieldErrors = cause.fieldErrors();
        if (Object.keys(fieldErrors).length > 0) {
          setErrors(fieldErrors);
          return;
        }
      }
      // The thrown value's own message is not read unless it is an `ApiError`:
      // an arbitrary exception's message may have been built from the request
      // payload, which here is a credential.
      setFormError(isApiError(cause) ? cause.message : 'Could not save the secret.');
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <DialogHeader>
        {isProduction ? (
          <Badge tone="production" className="mb-1 self-start">
            Production
          </Badge>
        ) : null}
        <DialogTitle>{editing ? `New value for ${secret?.name}` : 'New secret'}</DialogTitle>
        <DialogDescription>
          {editing
            ? 'This appends a new version. The previous one stays in the history and can be restored.'
            : `It will be encrypted under this environment's data key before it is stored.`}
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        {editing ? null : (
          <Field
            label="Name"
            error={errors['name'] ?? (nameCheck && !nameCheck.valid ? nameCheck.message : null)}
            hint="Becomes an environment variable, so: letters, digits and underscores, not starting with a digit."
          >
            <Input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setErrors({});
              }}
              placeholder="DATABASE_URL"
              maxLength={SECRET_NAME_MAX_LENGTH}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="font-mono"
              autoFocus
            />
          </Field>
        )}

        {/* The validator can often derive a legal name from an illegal one
                (`my-api-key` → `MY_API_KEY`). Offering it as a button is faster
                and less error-prone than explaining the rule and hoping. */}
        {nameCheck?.suggestion !== undefined ? (
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => {
              setName(nameCheck.suggestion ?? '');
              setErrors({});
            }}
          >
            Use {nameCheck.suggestion}
          </Button>
        ) : null}

        {/* No live byte counter: measuring the value on every keystroke
                would copy the plaintext into a fresh buffer each time, and the
                server's 64 KB refusal already says exactly what is wrong. */}
        <Field
          label="Value"
          error={errors['value']}
          hint="Multi-line values — certificates, private keys — are stored verbatim."
        >
          <Textarea
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setErrors({});
            }}
            rows={5}
            // Every assistant that could copy this value somewhere else is
            // turned off: autocomplete would offer it back on another form,
            // and a spell checker on some platforms sends its input to a
            // remote service.
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="font-mono"
            {...(editing ? { autoFocus: true } : {})}
          />
        </Field>

        {editing ? null : (
          <Field
            label="Note"
            optional
            error={errors['note']}
            hint="Shown beside the secret. Never put part of the value here."
          >
            <Input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Rotated quarterly; owned by the platform team."
              maxLength={NOTE_MAX_LENGTH}
              autoComplete="off"
            />
          </Field>
        )}

        {isProduction ? (
          <Alert tone="warning" title="This is production">
            Whatever reads these secrets will pick this value up on its next deploy, not
            immediately.
          </Alert>
        ) : null}

        {formError ? <Alert tone="danger">{formError}</Alert> : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          {editing ? 'Save new version' : 'Create secret'}
        </Button>
      </DialogFooter>
    </form>
  );
}
