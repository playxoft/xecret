'use client';

import { useMemo, useState } from 'react';
import { fromBase64Url, zeroize } from '@xecret/core/crypto/client';
import type { Bytes, RecoveryCode } from '@xecret/core/crypto/client';

import { errorMessage, SIGN_IN_PATH } from '@/lib/api';
import { Alert, Button, Field, Input, KeyIcon, Separator, Skeleton } from '@/components/ui';
import { kitConfirmationProblem, promptedCodeIndex } from './emergency-kit';
import { assertPasskeyPrf, currentPasskeyAvailability } from './passkey';
import { PassphraseFields, usePassphraseStrength } from './passphrase-fields';
import { passphraseProblem } from './passphrase';
import { RecoveryKitPanel } from './recovery-kit-panel';
import {
  beginRecovery,
  completeRecovery,
  describePasskeyUnlockFailure,
  describeUnlockFailure,
  openRecoveryWrap,
  readRecoveryCode,
  resetConfirmationProblem,
  resetVault,
  unlockWithPasskey,
  unlockWithPassphrase,
  VAULT_RESET_CONFIRMATION,
} from './vault-client';
import type { VaultMaterial } from './vault-client';
import { useVault } from './vault-keys';

/**
 * Unlocking, and the road back from a forgotten passphrase.
 *
 * ── What this screen must never do ──
 * It must not offer "remember this device": a lock you can permanently dismiss
 * is not a lock. It must not show how many attempts remain — that tells somebody
 * guessing exactly how much room they have, and the person who knows their own
 * passphrase has no use for a countdown. And it must always offer a way out,
 * which is why sign-out is rendered by every caller and why the recovery flow
 * below is reachable in one click rather than buried.
 *
 * ── The order of the offers ──
 * Passkey first when one is enrolled, then the passphrase, per plan §4.2 —
 * prominence in the order somebody will reach for them, not in the order they
 * were built. The passphrase form is always rendered underneath, never behind a
 * "use another method" link: a passkey is an extra door and the authenticator
 * that opens it can be at home, flat, or reset, and a screen that hid the
 * passphrase would turn each of those into being locked out.
 *
 * The passkey button is withdrawn — not disabled — when this browser or
 * authenticator turns out not to support the PRF extension, because there is
 * nothing to retry and a permanently failing button is worse than no button.
 */

export interface VaultUnlockProps {
  user: { id: string; email: string; displayName: string | null };
  /** Re-reads the session, which is what actually dismisses the lock. */
  onUnlocked: () => void;
}

type Stage = 'unlock' | 'code' | 'reset' | 'kit' | 'lost';

export function VaultUnlock({ user, onUnlocked }: VaultUnlockProps) {
  const vault = useVault();
  const [stage, setStage] = useState<Stage>('unlock');

  // Answered before the material is looked at, and the exemption is the point of
  // it: this is the screen somebody reaches when nothing they hold opens
  // anything, and it has to stay rendered through the reset that empties
  // `material` underneath it.
  if (stage === 'lost') {
    return <AllCodesLost onBack={() => setStage('code')} onReset={onUnlocked} />;
  }

  if (vault.material === null) {
    // Three states, not two. The wraps arrive from `GET /api/auth/vault` a
    // moment after this screen mounts, and rendering "your vault could not be
    // read" during that moment would tell somebody their keys are gone every
    // single time they open a locked tab.
    if (vault.loading) {
      return (
        <div aria-busy="true" aria-label="Loading your vault" className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      );
    }

    return (
      <Alert tone="danger" title="Your vault could not be read">
        {vault.error === null
          ? 'Reload the page to try again.'
          : `${errorMessage(vault.error)} Reload the page to try again.`}
      </Alert>
    );
  }

  if (stage === 'unlock') {
    return (
      <UnlockForm
        user={user}
        material={vault.material}
        onUnlocked={onUnlocked}
        onForgot={() => setStage('code')}
      />
    );
  }

  return <RecoveryFlow user={user} stage={stage} onStage={setStage} onDone={onUnlocked} />;
}

/* ─────────────────────────────── unlocking ─────────────────────────────── */

function UnlockForm({
  user,
  material,
  onUnlocked,
  onForgot,
}: {
  user: VaultUnlockProps['user'];
  material: VaultMaterial;
  onUnlocked: () => void;
  onForgot: () => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * Set when this browser or authenticator turns out not to support PRF.
   *
   * Withdrawing the button rather than disabling it: there is nothing to retry,
   * and the passphrase form below is not a fallback bolted on for this case — it
   * is the primary credential, and the reason a passkey is never the only wrap.
   */
  const [passkeyUnavailable, setPasskeyUnavailable] = useState<string | null>(null);

  // Read once. It cannot change while this screen is mounted, and re-reading it
  // per render would make the button flicker on a browser that answers slowly.
  const availability = useMemo(() => currentPasskeyAvailability(), []);
  const passkeyOffered =
    material.passkeys.length > 0 && availability === 'available' && passkeyUnavailable === null;

  async function unlockWithPasskeyPrf() {
    if (passkeyBusy || busy) return;

    setPasskeyBusy(true);
    setFailure(null);
    try {
      // Every enrolled credential is offered, so the browser's own prompt is
      // what chooses between them — this screen has no idea which authenticator
      // is to hand, and guessing would be worse than asking.
      const asserted = await assertPasskeyPrf(
        material.passkeys.map((passkey) => fromBase64Url(passkey.credentialId)),
      );

      await unlockWithPasskey({
        userId: user.id,
        material,
        credentialId: asserted.credentialId,
        prfOutput: asserted.prfOutput,
      });
      onUnlocked();
    } catch (cause) {
      const outcome = describePasskeyUnlockFailure(cause);
      // A dismissal is not a failure: the button simply comes back, and saying
      // anything about it would be telling somebody what they just did.
      if (outcome.silent) return;
      if (outcome.permanent) setPasskeyUnavailable(outcome.message);
      else setFailure(outcome.message);
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || passphrase.length === 0) return;

    setBusy(true);
    setFailure(null);
    try {
      await unlockWithPassphrase({ userId: user.id, passphrase, material });
      setPassphrase('');
      onUnlocked();
    } catch (cause) {
      // One message for a failed unwrap, and the server's own words for
      // everything it answered — including the lockout, whose wait is computed
      // from the account's real backoff state and must not be paraphrased. See
      // `describeUnlockFailure`.
      setFailure(describeUnlockFailure(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {passkeyOffered ? (
        <div className="flex flex-col gap-3">
          <Button
            variant="primary"
            size="lg"
            loading={passkeyBusy}
            disabled={busy}
            onClick={() => void unlockWithPasskeyPrf()}
          >
            <KeyIcon className="size-4" />
            Unlock with a passkey
          </Button>

          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-fg-subtle text-xs uppercase">or</span>
            <Separator className="flex-1" />
          </div>
        </div>
      ) : null}

      {passkeyUnavailable !== null ? (
        <Alert tone="warning" title="Your passkey could not be used here">
          {passkeyUnavailable} Your passphrase still opens your vault — it always does, which is why
          a passkey is never the only way in.
        </Alert>
      ) : null}

      {material.passkeys.length > 0 &&
      availability !== 'available' &&
      passkeyUnavailable === null ? (
        <Alert tone="info" title="Passkey unlock is not available in this browser">
          {availability === 'insecure-context'
            ? 'This page is not served over HTTPS, so the browser will not use a passkey. This is expected in local development.'
            : 'This browser does not support passkeys. Use your passphrase — your enrolled passkeys still work elsewhere and nothing needs re-enrolling.'}
        </Alert>
      ) : null}

      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {failure !== null ? (
          <Alert tone="danger" title="Your vault did not open">
            {failure}
          </Alert>
        ) : null}

        <Field label="Master passphrase">
          <Input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            autoComplete="current-password"
            autoFocus
            spellCheck={false}
          />
        </Field>

        <Button
          type="submit"
          // Secondary only when a passkey is offered above it — two primary
          // buttons would put the emphasis nowhere. Still a full-width button
          // and still the first thing in the form: the demotion is about
          // prominence between two working options, not about hiding one.
          variant={passkeyOffered ? 'secondary' : 'primary'}
          size="lg"
          loading={busy}
          disabled={passphrase.length === 0 || passkeyBusy}
        >
          Unlock with my passphrase
        </Button>
      </form>

      {busy ? (
        // The derivation runs in a worker, so this is a live region rather than
        // a frozen one — but it is still a second in which nothing appears to
        // happen, and an unexplained second on a passphrase form reads as a
        // failure. See `argon2.ts`.
        <p role="status" className="text-fg-subtle text-center text-sm">
          Securing your vault… this takes a moment on purpose.
        </p>
      ) : null}

      <Button variant="ghost" size="sm" onClick={onForgot}>
        Forgot your passphrase?
      </Button>
    </div>
  );
}

/* ──────────────────────────────── recovery ──────────────────────────────── */

/**
 * Redeeming a code, and the reset it forces.
 *
 * The three stages are one transaction from the user's point of view and very
 * nearly one on the server: `POST /api/auth/vault/recovery/complete` sets the
 * new passphrase, reissues the whole kit and unlocks the session together,
 * because they are inseparable. Somebody here has lost control of their
 * passphrase, so stopping at "you are in" would leave an account whose only
 * credential is a piece of paper — and every one of the five wraps holds the
 * same User Key, so a kit with one code spent is a kit four other pieces of
 * paper still open.
 */
function RecoveryFlow({
  user,
  stage,
  onStage,
  onDone,
}: {
  user: VaultUnlockProps['user'];
  stage: Stage;
  onStage: (stage: Stage) => void;
  onDone: () => void;
}) {
  const vault = useVault();

  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * The User Key, held between the two halves of the flow.
   *
   * It exists here rather than in the key store because the session is not
   * unlocked yet: nothing may render as though it were until
   * `completeRecovery` has succeeded, and the key store is what the rest of the
   * application reads to answer that question. It is zeroized the moment it has
   * been used, and again if the flow is abandoned.
   */
  const [redeemed, setRedeemed] = useState<{ userKey: Bytes; lookupHash: Bytes } | null>(null);

  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');

  const [codes, setCodes] = useState<readonly RecoveryCode[] | null>(null);
  const [issuedAt, setIssuedAt] = useState(() => new Date());
  const [promptedCode, setPromptedCode] = useState<RecoveryCode | null>(null);
  const [kitSaved, setKitSaved] = useState(false);
  const [typedCode, setTypedCode] = useState('');
  const [showKitProblem, setShowKitProblem] = useState(false);

  const userInputs = useMemo(
    () => [user.email, ...(user.displayName === null ? [] : [user.displayName])],
    [user.email, user.displayName],
  );
  const strength = usePassphraseStrength(passphrase, userInputs);

  async function redeem(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const parsed = readRecoveryCode(typed);
    if ('problem' in parsed) {
      // The check character earns its keep here: "that code has a typo" instead
      // of "invalid recovery code" is the difference between retyping one
      // character and concluding the kit is worthless.
      setFailure(parsed.problem);
      return;
    }

    setBusy(true);
    setFailure(null);
    try {
      const { wrap, lookupHash } = await beginRecovery(parsed.code);
      const userKey = await openRecoveryWrap({
        userId: user.id,
        code: parsed.code,
        lookupHash,
        wrap,
      });
      setRedeemed({ userKey, lookupHash });
      setTyped('');
      onStage('reset');
    } catch (cause) {
      setFailure(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function reset(event: React.FormEvent) {
    event.preventDefault();
    if (busy || redeemed === null) return;

    const problem = passphraseProblem({ passphrase, confirm, score: strength?.score ?? null });
    if (problem !== null) {
      setFailure(problem);
      return;
    }

    setBusy(true);
    setFailure(null);
    try {
      const result = await completeRecovery({
        userId: user.id,
        userKey: redeemed.userKey,
        lookupHash: redeemed.lookupHash,
        newPassphrase: passphrase,
      });
      vault.adopt({ vault: result.vault, material: result.material });

      const issued = result.codes ?? [];
      setCodes(issued);
      setIssuedAt(new Date());
      setPromptedCode(issued[promptedCodeIndex(issued.length)] ?? null);
      setPassphrase('');
      setConfirm('');
      // `completeRecovery` handed the User Key to the key store, which now owns
      // it. Dropping the reference here without zeroizing is deliberate:
      // wiping it would wipe the copy the store is holding.
      setRedeemed(null);
      onStage('kit');
    } catch (cause) {
      setFailure(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function abandon() {
    if (redeemed !== null) {
      zeroize(redeemed.userKey);
      setRedeemed(null);
    }
    setFailure(null);
    onStage('unlock');
  }

  if (stage === 'code') {
    return (
      <form onSubmit={redeem} noValidate className="flex flex-col gap-4">
        <p className="text-fg-muted text-sm leading-6">
          Enter one of the five recovery codes from your Emergency Kit. Using it replaces all five
          and asks you to choose a new passphrase — both are forced, because a code is what somebody
          reaches for when their passphrase is already lost.
        </p>

        {failure !== null ? (
          <Alert tone="danger" title="That code was not accepted">
            {failure}
          </Alert>
        ) : null}

        <Field label="Recovery code" hint="Hyphens, spacing and capitals do not matter.">
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            autoFocus
            className="font-mono tracking-wide"
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-C"
          />
        </Field>

        <Button type="submit" variant="primary" loading={busy} disabled={typed.trim().length === 0}>
          Continue
        </Button>
        <Button variant="ghost" size="sm" onClick={abandon}>
          Back to the passphrase
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onStage('lost')}>
          I have lost all five codes
        </Button>
      </form>
    );
  }

  if (stage === 'reset') {
    return (
      <form onSubmit={reset} noValidate className="flex flex-col gap-4">
        <Alert tone="success" title="That code worked">
          Your vault is open. Choose a new passphrase now — the code you just used is spent, and the
          other four are about to be replaced.
        </Alert>

        {failure !== null ? (
          <Alert tone="danger" title="The passphrase was not changed">
            {failure}
          </Alert>
        ) : null}

        <PassphraseFields
          passphrase={passphrase}
          onPassphrase={setPassphrase}
          confirm={confirm}
          onConfirm={setConfirm}
          strength={strength}
          labels={{ passphrase: 'New master passphrase', confirm: 'Confirm new passphrase' }}
          autoFocus
        />

        <Button type="submit" variant="primary" size="lg" loading={busy}>
          Set my new passphrase
        </Button>
        {busy ? (
          <p role="status" className="text-fg-subtle text-center text-sm">
            Securing your vault…
          </p>
        ) : null}
      </form>
    );
  }

  // `kit` — the reissued codes, behind the same save gate the ceremony uses.
  const kitProblem =
    promptedCode === null
      ? null
      : kitConfirmationProblem({ saved: kitSaved, prompted: promptedCode, typed: typedCode });

  return (
    <div className="flex flex-col gap-5">
      {codes === null ? null : (
        <RecoveryKitPanel
          email={user.email}
          codes={codes}
          issuedAt={issuedAt}
          saved={kitSaved}
          onSaved={() => setKitSaved(true)}
          promptedCode={promptedCode}
          typedCode={typedCode}
          onTypedCode={setTypedCode}
          problem={showKitProblem ? kitProblem : null}
        />
      )}

      <Button
        variant="primary"
        size="lg"
        onClick={() => {
          if (kitProblem !== null) {
            setShowKitProblem(true);
            return;
          }
          onDone();
        }}
      >
        Continue to xecret
      </Button>
      {showKitProblem && kitProblem !== null ? (
        <p role="alert" className="text-danger-text text-sm leading-5">
          {kitProblem}
        </p>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── the honest dead end ─────────────────────────── */

/**
 * What to say when the passphrase and all five codes are gone, and the one
 * action left.
 *
 * ── The reset is not recovery, and this screen must never imply that it is ──
 * Nothing is decrypted and nothing is restored, because nothing can be. The data
 * became unreadable when the last recovery code was lost; the reset does not
 * change that and arrives too late to. What it changes is only whether the
 * account can be *used* afterwards — without it, somebody sits at a lock screen
 * whose every action fails, forever, with a working session.
 *
 * So the copy separates the two facts and states them in that order: your data
 * is gone, and here is how to start again. Running them together — "reset your
 * vault to regain access" — would be the sentence somebody clicks past and then
 * accuses us of having deleted their secrets, which is the one accusation this
 * product cannot afford to have half-deserved.
 *
 * ── The gates ──
 * A typed phrase, matching what the endpoint checks, because this is the only
 * action in the product with no undo of any kind — not a recoverable delete, not
 * a soft delete, not a thirty-day window. And the phrase states the act rather
 * than naming the account, so it cannot be satisfied by muscle memory.
 *
 * The keys are released before the request, inside {@link resetVault}. Nothing
 * is held in this state, and doing it anyway costs nothing and closes the case
 * where something was.
 */
function AllCodesLost({ onBack, onReset }: { onBack: () => void; onReset: () => void }) {
  const vault = useVault();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [showProblem, setShowProblem] = useState(false);
  const [done, setDone] = useState(false);

  const problem = resetConfirmationProblem(typed);

  async function reset(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    if (problem !== null) {
      setShowProblem(true);
      return;
    }

    setBusy(true);
    setFailure(null);
    try {
      const status = await resetVault(typed);
      // Adopted before anything navigates, so this provider stops describing a
      // vault that no longer exists. `reload` follows to drop the material with
      // it — safe here and nowhere else in this file, because the dead end is
      // the one stage that renders without material.
      vault.adopt({ vault: status });
      setDone(true);
      void vault.reload();
      // Re-reads `/api/auth/me`, which now reports `configured: false` — and
      // that is what swaps this screen for the setup ceremony.
      onReset();
    } catch (cause) {
      setFailure(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div role="status" className="flex flex-col gap-3 text-center">
        <p className="text-fg text-sm font-medium">Your vault has been reset</p>
        <p className="text-fg-subtle text-sm leading-6">
          Setting up a new one now. Nothing encrypted under the old vault is readable, by us or by
          anyone.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="danger" title="We cannot recover this">
        Your secrets are encrypted with a key derived from your passphrase, and we hold no copy of
        it. Without the passphrase or one of your recovery codes, the data in your vault cannot be
        decrypted by anyone — including us. There is no support process that gets it back, because
        there is nothing on our side to get it back with.
      </Alert>

      <div className="text-fg-muted flex flex-col gap-3 text-sm leading-6">
        <p>
          What is lost is your own copy of the keys. Your organisation’s data is not damaged by
          this, and teammates who still have their vaults are unaffected.
        </p>
        <p>
          <span className="text-fg">You can start again by resetting your vault.</span> That
          discards your keys, your recovery codes and your passkeys permanently. It does not recover
          anything and it is not a way back in: everything already encrypted under the old vault
          stays unreadable, including your access to every team environment you were shared into.
        </p>
        <p>
          Afterwards you choose a new passphrase and get a new Emergency Kit, and an owner or admin
          of your organisation can share those environments with you again — from that point on, not
          retroactively. Ask them before you reset, so you know the way back exists.
        </p>
      </div>

      {failure !== null ? (
        <Alert tone="danger" title="Your vault was not reset">
          {failure}
        </Alert>
      ) : null}

      <form onSubmit={reset} noValidate className="flex flex-col gap-4">
        <Field
          label={`Type “${VAULT_RESET_CONFIRMATION}” to confirm`}
          error={showProblem ? problem : null}
        >
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={VAULT_RESET_CONFIRMATION}
          />
        </Field>

        <Button type="submit" variant="danger" loading={busy}>
          Reset my vault
        </Button>
      </form>

      <Button variant="secondary" onClick={onBack}>
        I have found a code after all
      </Button>
      <Button variant="ghost" size="sm" asChild>
        <a href={SIGN_IN_PATH}>Sign in with a different account</a>
      </Button>
    </div>
  );
}
