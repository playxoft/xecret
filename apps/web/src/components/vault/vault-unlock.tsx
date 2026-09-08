'use client';

import { useMemo, useState } from 'react';
import { zeroize } from '@xecret/core/crypto/client';
import type { Bytes, RecoveryCode } from '@xecret/core/crypto/client';

import { errorMessage, SIGN_IN_PATH } from '@/lib/api';
import { Alert, Button, Field, Input, KeyIcon, Skeleton } from '@/components/ui';
import { kitConfirmationProblem, promptedCodeIndex } from './emergency-kit';
import { PassphraseFields, usePassphraseStrength } from './passphrase-fields';
import { passphraseProblem } from './passphrase';
import { RecoveryKitPanel } from './recovery-kit-panel';
import {
  beginRecovery,
  completeRecovery,
  describeUnlockFailure,
  openRecoveryWrap,
  PASSKEY_UNLOCK_UNAVAILABLE,
  readRecoveryCode,
  unlockWithPassphrase,
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
 * Passkey first when one is enrolled, then the passphrase, per plan §4.2. The
 * passkey section is currently an explanation rather than a button, for the
 * reason `PASSKEY_UNLOCK_UNAVAILABLE` sets out at length: a passkey opens the
 * User Key but cannot produce the verifier the unlock endpoint compares, so a
 * button there would be one that always fails. It is rendered rather than hidden
 * because somebody who deliberately enrolled a passkey deserves to be told why
 * it is not being offered.
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

  switch (stage) {
    case 'unlock':
      return (
        <UnlockForm
          user={user}
          material={vault.material}
          onUnlocked={onUnlocked}
          onForgot={() => setStage('code')}
        />
      );
    case 'lost':
      return <AllCodesLost onBack={() => setStage('code')} />;
    default:
      return <RecoveryFlow user={user} stage={stage} onStage={setStage} onDone={onUnlocked} />;
  }
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
  const [failure, setFailure] = useState<string | null>(null);

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
      {material.passkeys.length > 0 ? (
        <Alert
          tone="info"
          title={`${material.passkeys.length === 1 ? 'A passkey is' : 'Passkeys are'} enrolled`}
        >
          {PASSKEY_UNLOCK_UNAVAILABLE}
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
          variant="primary"
          size="lg"
          loading={busy}
          disabled={passphrase.length === 0}
        >
          <KeyIcon className="size-4" />
          Unlock
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
 * What to say when the passphrase and all five codes are gone.
 *
 * ── Why there is no "reset my vault" button here ──
 * Plan §4.3 asks for one and it does not exist in this build. `deleteVault` is
 * reachable from exactly one place — `DELETE /api/auth/account`, as one step of
 * deleting the whole account — and there is no route that drops key material on
 * its own. Adding one from this screen would mean inventing a destructive
 * endpoint reachable from a locked session, which is not a thing to invent
 * quietly on the page where somebody has just lost everything.
 *
 * ── And the account deletion is not a way out either ──
 * That route carries no `allowLocked` exemption, deliberately and for a good
 * reason of its own: erasing an account demands the same proof of presence as
 * reading a secret, so a locked session left on a bench cannot do it. The two
 * decisions are individually right and together they close the last door — an
 * account in this state cannot unlock, cannot reset, and cannot delete itself.
 * Only whoever operates the installation can remove the key rows.
 *
 * So the copy says that, in those words. It does not offer a button that fails,
 * and it does not apologise its way around the fact: there is no key on our
 * side, and "we may be able to help" would be a lie told at the worst possible
 * moment.
 */
function AllCodesLost({ onBack }: { onBack: () => void }) {
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
          <span className="text-fg">
            Ask whoever runs this xecret installation to clear your key material.
          </span>{' '}
          Doing so discards your vault permanently — nothing encrypted under it becomes readable
          again — and lets you start over with a new passphrase and a new set of keys. It is the
          only action that unsticks this account, and it is not one this page can take: every route
          that touches key material requires an unlocked vault, which is precisely what you no
          longer have.
        </p>
        <p>
          Once you have a new vault, an owner or admin of your organisation can re-share the
          environments you had access to.
        </p>
      </div>

      <Button variant="secondary" onClick={onBack}>
        I have found a code after all
      </Button>
      <Button variant="ghost" size="sm" asChild>
        <a href={SIGN_IN_PATH}>Sign in with a different account</a>
      </Button>
    </div>
  );
}
