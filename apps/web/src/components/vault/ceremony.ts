'use client';

import type { RecoveryCode } from '@xecret/core/crypto/client';

import { kitConfirmationProblem } from './emergency-kit';
import { passphraseProblem } from './passphrase';

/**
 * The setup ceremony's shape, and the rules that decide when it may move on.
 *
 * ── Why the gates are here and not in the component ──
 * Because they are the security-relevant part. "You cannot continue until you
 * have ticked the box that says nobody can recover this for you" and "you cannot
 * continue until you have saved the codes" are the two rules that decide whether
 * a user ends up with an unrecoverable vault they did not understand they were
 * signing up for. Written as a pure function over a plain state object, they can
 * be asserted directly; written as `disabled={...}` in JSX, they can only be
 * asserted by driving a DOM, which this repository's test suite does not do —
 * see `use-plaintext-cache.ts` for the same reasoning applied to a cache rule.
 *
 * ── Why the ceremony has five steps and not one long form ──
 * Because they ask for different kinds of assent. Step 1 is a decision, step 2
 * is a choice, step 4 is a chore that must not be skipped, and step 5 is
 * genuinely optional. Collapsing them into one page would let a user scroll past
 * the sentence that matters — and it is the sentence that matters most in the
 * whole product.
 */

/**
 * The steps, in order.
 *
 * `generating` is not a page the user navigates to; it is the state the ceremony
 * sits in while Argon2id runs and the keys are uploaded. It is a step rather
 * than a boolean so that "Securing your vault…" is a screen with nothing else on
 * it, which is the honest rendering of a moment when nothing can be cancelled.
 */
export const VAULT_SETUP_STEPS = ['explain', 'passphrase', 'generating', 'kit', 'passkey'] as const;

export type VaultSetupStep = (typeof VAULT_SETUP_STEPS)[number];

/**
 * The sentence the checkbox is attached to.
 *
 * First person, and unhedged. Every softer phrasing that was considered —
 * "may be unable to", "in most cases" — describes a different product: there is
 * no key on the server side, so there is no case in which anyone can help. A
 * consent control whose text is not literally true is worse than no consent
 * control, because it manufactures a record of agreement to something the user
 * was not told.
 */
export const CONSENT_STATEMENT =
  'If I lose my passphrase and my recovery codes, my secrets are unrecoverable — no one can help, including xecret.';

/** Everything the gates below read. Held by the ceremony component as state. */
export interface VaultSetupState {
  consented: boolean;
  passphrase: string;
  confirm: string;
  /** The latest zxcvbn score, or `null` while one is being computed. */
  score: number | null;
  /** Set by a completed download or print. */
  kitSaved: boolean;
  /** The code the confirmation step asks to have typed back. */
  promptedCode: RecoveryCode | null;
  typedCode: string;
}

/**
 * Why this step cannot be left yet, or `null` when it can.
 *
 * A string rather than a boolean, because every one of these is shown to the
 * user: a disabled button with no explanation is a dead end, and the three
 * reasons here are all things somebody can act on.
 */
export function setupStepProblem(step: VaultSetupStep, state: VaultSetupState): string | null {
  switch (step) {
    case 'explain':
      return state.consented
        ? null
        : 'Tick the box to confirm you understand that nobody can recover this for you.';

    case 'passphrase':
      return passphraseProblem({
        passphrase: state.passphrase,
        confirm: state.confirm,
        score: state.score,
      });

    case 'generating':
      // Not a gate. Nothing the user does advances this step — the derivation
      // and the upload do — and reporting a "problem" here would put a message
      // on a screen whose whole point is that there is nothing to decide.
      return null;

    case 'kit':
      if (state.promptedCode === null) return 'Your recovery codes have not been issued yet.';
      return kitConfirmationProblem({
        saved: state.kitSaved,
        prompted: state.promptedCode,
        typed: state.typedCode,
      });

    case 'passkey':
      // Genuinely skippable, and it must stay that way: a passkey is an extra
      // door, and making it mandatory would turn "this authenticator does not
      // support PRF" into a vault its owner cannot finish creating.
      return null;
  }
}

/** The step after this one, or `null` at the end of the ceremony. */
export function nextSetupStep(step: VaultSetupStep): VaultSetupStep | null {
  const index = VAULT_SETUP_STEPS.indexOf(step);
  return VAULT_SETUP_STEPS[index + 1] ?? null;
}

/** `Step 2 of 4` — `generating` is not counted, because it is not a decision. */
export function setupStepPosition(step: VaultSetupStep): { current: number; total: number } {
  const visible = VAULT_SETUP_STEPS.filter((candidate) => candidate !== 'generating');
  return { current: visible.indexOf(step as (typeof visible)[number]) + 1, total: visible.length };
}
