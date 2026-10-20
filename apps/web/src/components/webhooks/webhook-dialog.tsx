'use client';

import { useId, useState } from 'react';

import { WEBHOOK_EVENT_TYPES, WEBHOOK_URL_MAX_LENGTH } from '@xecret/core/webhooks';
import { api, isApiError } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { ChangeError } from '@/components/plans/plan-notice';
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from '@/components/ui';
import type { Webhook, WebhookCreated, WebhookResponse } from './types';
import {
  createBody,
  emptyWebhookForm,
  EVENT_TYPE_COPY,
  formFromWebhook,
  hasErrors,
  patchBody,
  toggleEventType,
  validateWebhookForm,
  WEBHOOK_DESCRIPTION_MAX_LENGTH,
} from './webhook-form';
import type { WebhookFormErrors, WebhookFormField, WebhookFormValues } from './webhook-form';

export interface WebhookDialogProps {
  orgSlug: string;
  /** The endpoint being edited, or `null` to add one. */
  webhook: Webhook | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An endpoint was added. Carries the signing secret, which is shown next and never again. */
  onCreated: (created: WebhookCreated) => void;
  onSaved: (webhook: Webhook) => void;
}

/**
 * Adding an endpoint, and changing one.
 *
 * One dialog for both because they are one form: where to deliver, what to call
 * it, and which events to send. What differs is the body — a create sends the
 * whole form, an edit sends only what changed (`patchBody` says why that
 * matters) — and what happens next: a create hands its signing secret to the
 * caller, which shows it once, while an edit leaves the secret alone.
 */
export function WebhookDialog({ open, onOpenChange, ...props }: WebhookDialogProps) {
  const [saving, setSaving] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => (saving ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-xl">
        {/* One component down, so the form is seeded afresh every time the
            dialog opens — Radix unmounts closed content — rather than carrying
            the last endpoint's URL into the next one. */}
        <WebhookForm {...props} onOpenChange={onOpenChange} onSavingChange={setSaving} />
      </DialogContent>
    </Dialog>
  );
}

function WebhookForm({
  orgSlug,
  webhook: given,
  onOpenChange,
  onCreated,
  onSaved,
  onSavingChange,
}: Omit<WebhookDialogProps, 'open'> & { onSavingChange: (saving: boolean) => void }) {
  // Captured at mount. The caller clears its target the moment the dialog is
  // asked to close, and the exit animation would otherwise re-title an edit
  // "New webhook endpoint" for the frames it takes to fade.
  const [webhook] = useState(given);
  const editing = webhook !== null;
  const [values, setValues] = useState<WebhookFormValues>(() =>
    webhook === null ? emptyWebhookForm() : formFromWebhook(webhook),
  );
  /**
   * Whether Save has been pressed. Until then the live checks stay quiet: a
   * fresh form whose URL box is empty is not yet wrong, and opening a dialog
   * onto "Enter the URL to deliver to" in red is a rebuke for nothing.
   */
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  /** The server's field errors, each cleared as soon as its field is edited. */
  const [serverErrors, setServerErrors] = useState<WebhookFormErrors>({});
  const [error, setError] = useState<unknown>(null);

  const eventsId = useId();
  const live = validateWebhookForm(values);

  function shown(field: WebhookFormField): string | null {
    return (tried ? live[field] : undefined) ?? serverErrors[field] ?? null;
  }

  function update(field: WebhookFormField, next: Partial<WebhookFormValues>) {
    setValues((current) => ({ ...current, ...next }));
    setServerErrors((current) => {
      if (current[field] === undefined) return current;
      const rest = { ...current };
      delete rest[field];
      return rest;
    });
  }

  function setBusy(busy: boolean) {
    setSaving(busy);
    onSavingChange(busy);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setTried(true);
    if (hasErrors(live)) return;

    setBusy(true);
    setError(null);
    setServerErrors({});
    try {
      if (webhook === null) {
        const created = await api.post<WebhookCreated>(
          apiPath.webhooks(orgSlug),
          createBody(values),
        );
        onCreated(created);
      } else {
        const patch = patchBody(webhook, values);
        // Nothing changed: closing is the whole of the answer. A request that
        // changed nothing would still be audited as an edit.
        if (patch !== null) {
          const answer = await api.patch<WebhookResponse>(
            apiPath.webhook(orgSlug, webhook.id),
            patch,
          );
          onSaved(answer.webhook);
        }
        onOpenChange(false);
      }
    } catch (cause) {
      // A field the server named goes under that field; anything else — a plan
      // refusal above all — goes in the alert at the top of the form, which
      // knows how to say "this needs the Pro plan" rather than "failed".
      if (isApiError(cause) && cause.code === 'validation_failed' && cause.fields.length > 0) {
        const fields = cause.fieldErrors();
        const mapped: WebhookFormErrors = {};
        for (const field of ['url', 'description', 'eventTypes'] as const) {
          if (fields[field] !== undefined) mapped[field] = fields[field];
        }
        setServerErrors(mapped);
        if (Object.keys(mapped).length === 0) setError(cause);
      } else {
        setError(cause);
      }
    } finally {
      setBusy(false);
    }
  }

  const eventsError = shown('eventTypes');

  return (
    <form onSubmit={handleSubmit} noValidate>
      <DialogHeader>
        <DialogTitle>{editing ? 'Edit endpoint' : 'New webhook endpoint'}</DialogTitle>
        <DialogDescription>
          {editing
            ? 'Where deliveries go and which events are sent. The signing secret is unchanged — rotate it from the endpoint’s menu.'
            : 'xecret sends a signed POST to this URL whenever one of the chosen events happens. A delivery names what changed — the secret, the environment, who did it — and never carries a value.'}
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        {error !== null ? (
          <ChangeError
            error={error}
            title={editing ? 'The endpoint was not changed' : 'The endpoint was not added'}
          />
        ) : null}

        <Field
          label="URL"
          error={shown('url')}
          hint="https only, and not a private or local address. Each delivery is signed with this endpoint’s secret, so the receiver can tell a real one from a forgery."
        >
          <Input
            type="url"
            inputMode="url"
            value={values.url}
            onChange={(event) => update('url', { url: event.target.value })}
            placeholder="https://example.com/hooks/xecret"
            maxLength={WEBHOOK_URL_MAX_LENGTH}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="font-mono"
            disabled={saving}
            autoFocus={!editing}
          />
        </Field>

        <Field
          label="Description"
          optional
          error={shown('description')}
          hint="What receives these, so the next person knows whether it is safe to remove."
        >
          <Input
            value={values.description}
            onChange={(event) => update('description', { description: event.target.value })}
            placeholder="Deploy bot in #platform"
            maxLength={WEBHOOK_DESCRIPTION_MAX_LENGTH}
            autoComplete="off"
            disabled={saving}
          />
        </Field>

        {/* A fieldset rather than a `Field`: a `Field` labels exactly one
            control, and this is a group of six. The legend names the group and
            the error is tied to it, so a screen reader hears "Events, choose at
            least one" on entering it rather than on one arbitrary checkbox. */}
        <fieldset
          className="flex flex-col gap-1.5"
          aria-describedby={eventsError !== null ? `${eventsId}-error` : undefined}
          aria-invalid={eventsError !== null ? true : undefined}
        >
          <legend className="text-fg mb-1.5 text-sm font-medium">Events</legend>
          <div className="border-line divide-line-subtle divide-y rounded-lg border">
            {WEBHOOK_EVENT_TYPES.map((type) => (
              <label
                key={type}
                className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 has-[button:disabled]:cursor-not-allowed"
              >
                <Checkbox
                  className="mt-0.5"
                  checked={values.eventTypes.includes(type)}
                  disabled={saving}
                  onCheckedChange={(checked) =>
                    update('eventTypes', {
                      eventTypes: toggleEventType(values.eventTypes, type, checked === true),
                    })
                  }
                  aria-label={EVENT_TYPE_COPY[type].label}
                />
                <span className="min-w-0">
                  <span className="text-fg block text-sm font-medium">
                    {EVENT_TYPE_COPY[type].label}{' '}
                    <code className="text-fg-subtle font-mono text-xs font-normal">{type}</code>
                  </span>
                  <span className="text-fg-subtle block text-sm leading-5">
                    {EVENT_TYPE_COPY[type].description}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {eventsError !== null ? (
            <p id={`${eventsId}-error`} className="text-danger-text text-sm leading-5">
              {eventsError}
            </p>
          ) : null}
        </fieldset>
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={saving}>
          {editing ? 'Save changes' : 'Add endpoint'}
        </Button>
      </DialogFooter>
    </form>
  );
}
