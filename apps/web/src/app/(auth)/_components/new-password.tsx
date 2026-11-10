'use client';

import { estimatePassphrase } from '@/components/vault/passphrase';
import { Field } from '@/components/ui/field';
import { PasswordInput } from './form-parts';

/**
 * Choosing an account password — on sign-up, and from a reset link — and the
 * estimate that judges it before it is posted.
 *
 * ── The bar is WorkOS's, not the vault's ──
 * This is the password WorkOS checks at sign-in, and WorkOS applies its own
 * policy when it is set: ten characters at least, a zxcvbn score of 3, and not
 * containing the address (its defaults, which this deployment keeps). The page
 * holds the same bar so that WorkOS almost never has to refuse one — on
 * sign-up a refusal costs the person their code, since WorkOS can only judge
 * the password once the code has proven the inbox. The vault passphrase is a
 * different secret with a higher bar (score 4, twelve characters: ADR 0009);
 * the estimator is the same one, loaded the same lazy way, on the first submit.
 *
 * The server holds the ten-character floor too, and WorkOS the rest; this is
 * the person's early warning, not the gate.
 */

export const NEW_PASSWORD_MIN_LENGTH = 10;

/** WorkOS's default `min_score`. */
export const NEW_PASSWORD_MIN_SCORE = 3;

export interface NewPasswordEstimate {
  score: number;
  warning: string | null;
}

/**
 * zxcvbn's verdict on `password`, told the address (a password built from it
 * is as guessable as the address is public) — or `null` if the dictionaries
 * would not load, in which case the server and WorkOS still judge it.
 */
export async function estimateNewPassword(
  password: string,
  email: string,
): Promise<NewPasswordEstimate | null> {
  const address = email.trim();
  const inputs = address === '' ? [] : [address, address.split('@')[0] ?? ''];
  try {
    const strength = await estimatePassphrase(password, inputs);
    return { score: strength.score, warning: strength.warning };
  } catch {
    return null;
  }
}

/**
 * Why this new password should not be posted yet, beside which field — or
 * `null`. Pure, so the rule is readable without a dictionary or a DOM; the
 * estimate is passed in (`null` when there is none to be had).
 */
export function newPasswordProblem(input: {
  password: string;
  confirm: string;
  email: string;
  estimate: NewPasswordEstimate | null;
}): { field: 'password' | 'confirm'; message: string } | null {
  const { password, confirm } = input;
  if (password.length === 0) return { field: 'password', message: 'Choose a password.' };
  if (password.length < NEW_PASSWORD_MIN_LENGTH) {
    return {
      field: 'password',
      message: `Use at least ${NEW_PASSWORD_MIN_LENGTH} characters — a few unrelated words make a strong one.`,
    };
  }
  const address = input.email.trim().toLowerCase();
  const local = address.split('@')[0] ?? '';
  const lowered = password.toLowerCase();
  if (
    (address !== '' && lowered.includes(address)) ||
    (local.length >= 3 && lowered.includes(local))
  ) {
    return { field: 'password', message: 'Leave your email address out of your password.' };
  }
  if (input.estimate !== null && input.estimate.score < NEW_PASSWORD_MIN_SCORE) {
    const warning = input.estimate.warning ?? '';
    return {
      field: 'password',
      message:
        warning !== ''
          ? `${warning} Choose something harder to guess.`
          : 'That password is too easy to guess. Choose something longer or less common.',
    };
  }
  if (confirm.length === 0) return { field: 'confirm', message: 'Type the password again.' };
  if (confirm !== password) return { field: 'confirm', message: 'The two passwords don’t match.' };
  return null;
}

/** The new password and its confirmation, both `new-password` for a password manager. */
export function NewPasswordFields({
  password,
  onPassword,
  confirm,
  onConfirm,
  problems,
  disabled,
  label = 'Password',
}: {
  password: string;
  onPassword: (value: string) => void;
  confirm: string;
  onConfirm: (value: string) => void;
  problems: Record<string, string>;
  disabled: boolean;
  label?: string;
}) {
  return (
    <>
      <Field
        label={label}
        hint={`At least ${NEW_PASSWORD_MIN_LENGTH} characters. A few unrelated words make a strong one.`}
        error={problems['password'] ?? null}
      >
        <PasswordInput
          name="password"
          value={password}
          onChange={(event) => onPassword(event.target.value)}
          autoComplete="new-password"
          disabled={disabled}
        />
      </Field>
      <Field label={`Confirm ${label.toLowerCase()}`} error={problems['confirm'] ?? null}>
        <PasswordInput
          name="confirm"
          value={confirm}
          onChange={(event) => onConfirm(event.target.value)}
          autoComplete="new-password"
          disabled={disabled}
        />
      </Field>
    </>
  );
}
