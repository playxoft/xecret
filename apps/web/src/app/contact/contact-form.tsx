'use client';

import { useState, type FormEvent } from 'react';

import { api, errorMessage, isApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { CheckCircleIcon } from '@/components/ui/icons';
import { CONTACT_LIMITS } from '@/lib/contact';

/**
 * The sales enquiry form.
 *
 * ── Why the success state replaces the form ──
 * A form that clears itself and shows a green line above it is a form people
 * submit twice, because nothing about it says the first one worked. Replacing it
 * outright makes the outcome the only thing on screen, and there is no second
 * button to press.
 *
 * ── Field errors come from the server, and only from the server ──
 * There is no client-side mirror of the validation rules. A second copy would
 * drift from `contactSchema`, and the failure mode of drift here is a form that
 * refuses something the API would have accepted — a customer told their own
 * email address is invalid by a regular expression nobody has looked at in a
 * year. The round trip costs a moment on a page nobody submits twice.
 */
export function ContactForm() {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    const form = new FormData(event.currentTarget);
    setBusy(true);
    setFields({});
    setProblem(null);

    try {
      await api.post('/contact', {
        name: String(form.get('name') ?? ''),
        email: String(form.get('email') ?? ''),
        company: String(form.get('company') ?? '') || undefined,
        message: String(form.get('message') ?? ''),
        website: String(form.get('website') ?? ''),
      });
      setSent(true);
    } catch (cause) {
      if (isApiError(cause) && cause.fields.length > 0) {
        setFields(cause.fieldErrors());
      }
      setProblem(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div
        className="border-line bg-surface flex flex-col items-center gap-3 rounded-xl border p-8 text-center"
        // `status` rather than `alert`: this is the outcome of something the
        // reader did on purpose, not an interruption, so it is announced without
        // taking focus away from wherever they moved next.
        role="status"
      >
        <CheckCircleIcon className="text-fg size-6" />
        <h2 className="text-fg text-lg font-semibold">Message sent</h2>
        <p className="text-fg-muted max-w-md text-sm leading-6">
          It has gone to the channel we actually watch, rather than an inbox nobody has agreed to
          read. Expect a reply from a person, usually within a working day.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" error={fields['name']}>
          <Input name="name" autoComplete="name" maxLength={CONTACT_LIMITS.name} required />
        </Field>

        <Field label="Work email" error={fields['email']}>
          <Input
            name="email"
            type="email"
            autoComplete="email"
            maxLength={CONTACT_LIMITS.email}
            required
          />
        </Field>
      </div>

      <Field label="Company" optional error={fields['company']}>
        <Input name="company" autoComplete="organization" maxLength={CONTACT_LIMITS.company} />
      </Field>

      <Field
        label="What do you need?"
        hint="Team size, what you are moving off, and anything your security review will ask about."
        error={fields['message']}
      >
        <Textarea name="message" rows={6} maxLength={CONTACT_LIMITS.message} required />
      </Field>

      {/* The honeypot. Hidden from sight *and* from assistive technology, and
          never focusable — a person cannot reach it by any route, so anything in
          it came from something filling in every input it found. `hidden` alone
          would do, but `tabIndex={-1}` and `aria-hidden` make the intent
          unambiguous to the next person reading this. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="hidden"
      />

      {problem === null ? null : (
        <p role="alert" className="text-danger-text text-sm leading-6">
          {problem}
        </p>
      )}

      <div className="flex items-center gap-4">
        <Button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send message'}
        </Button>
        <p className="text-fg-subtle text-sm">No newsletter, no CRM sequence.</p>
      </div>
    </form>
  );
}
