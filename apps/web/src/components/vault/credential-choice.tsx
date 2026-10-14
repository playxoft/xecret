'use client';

import { useId } from 'react';

/** Which credential opens an old vault or an archive. */
export type CredentialMethod = 'passphrase' | 'recovery-code';

const OPTIONS: readonly { value: CredentialMethod; label: string }[] = [
  { value: 'passphrase', label: 'Old passphrase' },
  { value: 'recovery-code', label: 'Old recovery code' },
];

/**
 * "Old passphrase" or "Old recovery code": a radio group drawn as a segmented
 * control.
 *
 * Not tabs. Tabs promise a panel each, and a screen reader announces them that
 * way; here there is one field whose label and format change. Native radios in
 * a fieldset are a radio group to every assistive technology without any ARIA,
 * and arrow keys move between them.
 *
 * The radios themselves are `sr-only`, so the focus outline is drawn on the
 * label that holds the focused one, as the pricing toggle does.
 *
 * Changing the choice is the caller's cue to clear the field: a passphrase
 * typed into a password box must not reappear in plain text because somebody
 * switched to the recovery-code field, which is not masked.
 */
export function CredentialChoice({
  value,
  onChange,
  disabled = false,
}: {
  value: CredentialMethod;
  onChange: (value: CredentialMethod) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
      <legend className="text-fg mb-1.5 text-sm font-medium">What you have</legend>
      <div className="border-line bg-canvas-inset inline-flex w-fit rounded-md border p-0.5">
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className="text-fg-muted has-[:checked]:bg-surface has-[:checked]:text-fg cursor-pointer rounded px-3 py-1.5 text-sm has-[:checked]:shadow-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--ring)]"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The recovery-code field's format hint, shared by every screen that asks for one. */
export const RECOVERY_CODE_HINT =
  'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X. Spaces and hyphens do not matter.';
