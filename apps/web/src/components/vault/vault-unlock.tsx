'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { fromBase64Url, zeroize } from '@xecret/core/crypto/client';
import type { Bytes, RecoveryCode } from '@xecret/core/crypto/client';

import { errorMessage, SIGN_IN_PATH } from '@/lib/api';
import {
  describeAuthError,
  reauthenticateWithGoogle,
  reauthenticateWithPassword,
} from '@/lib/firebase';
import {
  Alert,
  Button,
  Field,
  Input,
  KeyIcon,
  Separator,
  Skeleton,
  useToast,
} from '@/components/ui';
import { appPath } from '@/app/(dashboard)/_lib/paths';
import { kitConfirmationProblem, promptedCodeIndex } from './emergency-kit';
import { assertPasskeyPrf, currentPasskeyAvailability } from './passkey';
import { PinUnlock } from './pin-unlock';
import { PassphraseFields, usePassphraseStrength } from './passphrase-fields';
import { passphraseProblem } from './passphrase';
import { RecoveryKitPanel } from './recovery-kit-panel';
import { useDevicePinId } from './device-pin';
import {
  hasDevicePinWrap,
  nudgeStorage,
  readNudgeDismissedAt,
  rememberNudge,
  shouldNudge,
} from './unlock-nudge';
import {
  beginRecovery,
  completeRecovery,
  describePasskeyUnlockFailure,
  describeUnlockFailure,
  fetchVault,
  materialSupersedes,
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
 * is not a lock. It must not show how many *passphrase* attempts remain — that
 * tells somebody guessing exactly how much room they have, and the person who
 * knows their own passphrase has no use for a countdown. The PIN form below is a
 * deliberate exception and not a drift: five is that credential's entire budget
 * rather than a sample of a search space, and the guesser is holding the device
 * anyway — `pin-unlock.tsx` makes the whole argument. And this screen must
 * always offer a way out, which is why sign-out is rendered by every caller and
 * why the recovery flow below is reachable in one click rather than buried.
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

/**
 * Which screen of the unlock flow is showing.
 *
 * Exported, because the host that titles and sizes the frame around it needs
 * the same list — and a hand-copied union there is a list that stops agreeing
 * with this one the first time a stage is added.
 */
export type Stage = 'unlock' | 'code' | 'reset' | 'kit' | 'lost';

export interface VaultUnlockProps {
  user: { id: string; email: string; displayName: string | null };
  /** Re-reads the session, which is what actually dismisses the lock. */
  onUnlocked: () => void;
  /**
   * Reports which stage is on screen, so the host can title each one for what
   * it actually asks, and widen its frame for the one stage that needs it —
   * the reissued kit, which is five full-width codes and a row of save buttons.
   */
  onStageChange?: (stage: Stage) => void;
}

export function VaultUnlock({ user, onUnlocked, onStageChange }: VaultUnlockProps) {
  const vault = useVault();
  const [stage, setStage] = useState<Stage>('unlock');

  useEffect(() => {
    onStageChange?.(stage);
    // Intentionally keyed on the stage alone: a new callback identity from a
    // host re-render carries no new information.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  /**
   * The wraps are re-read whenever this screen appears.
   *
   * ── What a stale copy costs ──
   * A dashboard tab reads `/api/auth/vault` once, when the provider mounts, and
   * then stays open for a working day. A passphrase change, a recovery or a reset
   * performed on another device moves the salt and the wrap underneath it — so
   * the tab that idles out at four o'clock presents a form built from this
   * morning's material, and the *correct* new passphrase fails against it. Every
   * attempt then spends from a server-side lockout budget that no correct
   * passphrase can satisfy, and the screen blames the typing.
   *
   * The mount is the right moment because it is the one that costs nothing: the
   * lock screen appears at a transition, not on every render, and a person about
   * to type a passphrase is a person about to wait for something anyway.
   */
  const reload = vault.reload;
  useEffect(() => {
    void reload();
  }, [reload]);

  // Answered before the material is looked at, and the exemption is the point of
  // it: this is the screen somebody reaches when nothing they hold opens
  // anything, and it has to stay rendered through the reset that empties
  // `material` underneath it.
  if (stage === 'lost') {
    return <AllCodesLost email={user.email} onBack={() => setStage('code')} onReset={onUnlocked} />;
  }

  /**
   * A vault that no longer exists, discovered by the refetch above.
   *
   * Somebody reset their vault on another device. This tab's session still says
   * `configured: true`, so its shell chose the unlock screen — and an unlock
   * screen for a vault that is gone is a form nothing can satisfy, with a
   * "forgotten your passphrase?" link whose recovery codes were destroyed along
   * with everything else. Saying what happened and offering the one act that
   * remains is the whole of the fix; `onUnlocked` re-reads the account, whose
   * `configured: false` moves the caller to the setup ceremony.
   */
  if (vault.status?.configured === false && stage === 'unlock') {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="warning" title="Your vault was reset on another device">
          <p>
            There is nothing here to unlock any more. A reset destroys the keys, every wrap and
            every recovery code — deliberately, because nothing else could have replaced a
            passphrase nobody remembered. Anything encrypted under the old vault stays unreadable.
          </p>
          <p className="mt-2">
            Setting up a new one takes a minute. Your teammates then share each environment&apos;s
            key with you again, which is a prompt on their side rather than a request on yours.
          </p>
        </Alert>
        <Button variant="primary" onClick={onUnlocked}>
          Set up a new vault
        </Button>
      </div>
    );
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
  const vault = useVault();
  const { toast } = useToast();
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

  /**
   * Whether this browser holds a PIN wrap, and what killed it if one did.
   *
   * Subscribed rather than read once: `unlockWithPin` clears the record on a
   * burn, on an unknown enrolment and on a wrap that does not open, and this
   * form has to disappear when it does. `useDevicePinId` also answers `null`
   * during server rendering, which is what keeps the two credential forms from
   * swapping places at hydration.
   */
  const pinDeviceId = useDevicePinId();
  const [pinGone, setPinGone] = useState<string | null>(null);
  const pinOffered = pinDeviceId !== null;

  /**
   * The passphrase field, so the caret can be handed back to it.
   *
   * Needed for exactly one moment: the PIN form withdrawing itself after a burn
   * or a revocation. Focus is inside a subtree that is about to unmount, and a
   * browser given no instruction drops it on `document.body` — which leaves
   * somebody who has just been told their PIN is gone with a keyboard that types
   * nowhere, on a screen whose only remaining control is the field below.
   */
  const passphraseRef = useRef<HTMLInputElement>(null);

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
      offerAFasterUnlock();
      onUnlocked();
    } catch (cause) {
      setFailure(await explainFailure(cause));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The offer of a one-touch unlock, made at the one moment it is about
   * something the person has just felt.
   *
   * ── Why here and not in the provider ──
   * Because this is the only seam that knows *what* opened the vault. The keys
   * arrive in the store identically whether they were derived from a
   * passphrase, unwrapped by an authenticator, or found in this tab's own
   * mirror after a reload — and only the first of those is somebody paying the
   * cost this offer would remove. A nudge hung off the store's `unlocked`
   * transition would fire on every refresh of an already-open tab, which is the
   * behaviour that makes people stop reading notifications.
   *
   * The availability check is the call site's rather than {@link shouldNudge}'s
   * because it is not a rule about nagging: on a browser without WebAuthn, or
   * on plain HTTP in development, there is nothing on the other end of the link
   * to set up.
   *
   * Fired before `onUnlocked`, which unmounts this screen. The toast outlives
   * it — `Toaster` is mounted at the root layout, above every route — so the
   * message lands on the dashboard the unlock just revealed.
   */
  function offerAFasterUnlock() {
    if (availability !== 'available') return;

    const storage = nudgeStorage();
    const now = Date.now();

    const nudge = shouldNudge({
      cause: 'passphrase',
      hasPasskey: material.passkeys.length > 0,
      hasPinWrap: hasDevicePinWrap(storage),
      dismissedAt: readNudgeDismissedAt(storage),
      now,
    });
    if (!nudge) return;

    rememberNudge(storage, now);
    toast({
      title: 'Unlock with your fingerprint or face next time — set it up in seconds',
      action: { label: 'Set it up', href: appPath.settingsSecurity() },
      // Until dismissed. Five seconds is long enough to notice a message and
      // too short to decide on one, and this is the only toast in the product
      // carrying a link somebody is meant to reach for.
      duration: 0,
    });
  }

  /**
   * What to say about a failed unlock — after checking it was this browser's
   * fault.
   *
   * ── Why a request happens before an error message is chosen ──
   * "That passphrase did not open your vault" has two causes and they need
   * opposite responses. One is a typo. The other is that the wraps this form was
   * built from are no longer the account's: a passphrase changed on a laptop, a
   * recovery completed on a phone, a reset performed anywhere. In the second case
   * the passphrase being typed is *correct*, and the typo message sends somebody
   * to doubt a credential they set ten minutes ago while every retry burns an
   * attempt from a lockout budget no correct passphrase can satisfy.
   *
   * The server cannot tell the difference — the unwrap happens here, and all it
   * saw was a verifier it never received. So this browser re-reads the material
   * it just failed against and compares. One extra request on a path that has
   * already failed, in exchange for the difference between an accusation and an
   * explanation.
   *
   * A refetch that itself fails changes nothing and says nothing: the original
   * failure is reported as it always was, because "we could not check" is not a
   * sentence that helps anybody unlock a vault.
   */
  async function explainFailure(cause: unknown): Promise<string> {
    try {
      const fresh = await fetchVault();
      vault.adopt(
        fresh.material === null
          ? { vault: fresh.vault }
          : { vault: fresh.vault, material: fresh.material },
      );

      if (!fresh.vault.configured || fresh.material === null) {
        return 'Your vault was reset on another device, so there is nothing here to unlock. Reload this page to set up a new one.';
      }

      if (materialSupersedes(material, fresh.material)) {
        return 'Your master passphrase was changed on another device. This page was still showing the old one — use the new passphrase, or reload the page and try again.';
      }
    } catch {
      // Fall through to the original failure. See above.
    }

    // One message for a failed unwrap, and the server's own words for
    // everything it answered — including the lockout, whose wait is computed
    // from the account's real backoff state and must not be paraphrased. See
    // `describeUnlockFailure`.
    return describeUnlockFailure(cause);
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

      {pinOffered ? (
        <div className="flex flex-col gap-3">
          <PinUnlock
            user={user}
            material={material}
            onUnlocked={onUnlocked}
            // The form withdraws itself: `unlockWithPin` has already cleared the
            // local record, so `useDevicePinId` answers `null` on the next
            // render. All this has to add is the sentence explaining why —
            // withdrawing rather than disabling, the same call the passkey path
            // makes, because a permanently failing entry box is worse than none.
            onGone={(message) => {
              setPinGone(message);
              // Synchronously, while this subtree is still mounted. The next
              // render withdraws it — `useDevicePinId` already answers `null`.
              passphraseRef.current?.focus();
            }}
            disabled={busy || passkeyBusy}
          />

          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-fg-subtle text-xs uppercase">or</span>
            <Separator className="flex-1" />
          </div>
        </div>
      ) : null}

      {pinGone !== null ? (
        <Alert tone="warning" title="Your PIN is off on this browser">
          {pinGone}
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
            ref={passphraseRef}
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            autoComplete="current-password"
            // Only when it is the first thing to reach for. The PIN box above
            // autofocuses too and is rendered later in the tree, so two
            // unconditional `autoFocus` attributes meant the passphrase won the
            // caret off a form somebody was about to type six digits into. The
            // passkey button is not a text field, but it is the primary action
            // when it is offered, and stealing focus past it is the same
            // mistake in the other direction.
            autoFocus={!pinOffered && !passkeyOffered}
            spellCheck={false}
          />
        </Field>

        <Button
          type="submit"
          // Secondary only when a faster unlock is offered above it — two
          // primary buttons would put the emphasis nowhere. Still a full-width
          // button and still the first thing in the form: the demotion is about
          // prominence between two working options, not about hiding one.
          variant={passkeyOffered || pinOffered ? 'secondary' : 'primary'}
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

      <Button variant="ghost" onClick={onForgot}>
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
        {/* Both consequences are forced, because a code is what somebody
            reaches for when their passphrase is already lost. */}
        <p className="text-fg-muted text-sm leading-6">
          Heads up: using a code replaces all five and asks you to choose a new passphrase.
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
        <Button variant="ghost" onClick={abandon}>
          Back to the passphrase
        </Button>
        <Button variant="ghost" onClick={() => onStage('lost')}>
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
 * And a **re-authentication**, which the typed phrase is not a substitute for.
 * The phrase is printed on the screen above the field, so it costs an attacker
 * one glance; and this is the one screen in the product that must stay reachable
 * from a locked session, so the vault lock cannot stand in front of it the way it
 * stands in front of every other destructive act. Without a second credential, a
 * stolen session cookie would be enough to destroy somebody's keys for good.
 *
 * So the person signs in again — a password, or the Google prompt — and the fresh
 * ID token travels with the request. The server verifies it against the identity
 * provider and checks both that it names this account and that the
 * authentication behind it happened minutes ago rather than at sign-in.
 *
 * The token is a local `const` in one call frame: obtained, passed into
 * {@link resetVault}, and unreachable the moment the handler returns. It is never
 * put into React state, which is the same rule `lib/firebase.ts` keeps for the
 * sign-in token.
 *
 * The keys are released before the request, inside {@link resetVault}. Nothing
 * is held in this state, and doing it anyway costs nothing and closes the case
 * where something was.
 */
/**
 * Whether a thrown value came from Firebase rather than from our API.
 *
 * A `code` of the `auth/…` shape is the only marker the SDK gives, and matching
 * on the prefix rather than on any string `code` keeps an ApiError — which may
 * one day grow a `code` of its own — from being rendered through
 * `describeAuthError`, whose vocabulary is entirely about sign-in.
 */
function isAuthError(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return false;
  const code = (cause as { code: unknown }).code;
  return typeof code === 'string' && code.startsWith('auth/');
}

function AllCodesLost({
  email,
  onBack,
  onReset,
}: {
  /** The signed-in address, so a password re-auth needs no second field. */
  email: string;
  onBack: () => void;
  onReset: () => void;
}) {
  const vault = useVault();
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [showProblem, setShowProblem] = useState(false);
  const [done, setDone] = useState(false);

  // Two screens rather than one: the facts, then the act. A single page
  // carrying both was a wall of text with a destructive form at the bottom —
  // splitting them means each screen asks the reader for exactly one thing.
  const [step, setStep] = useState<'facts' | 'confirm'>('facts');

  const problem = resetConfirmationProblem(typed);

  /**
   * The shared tail of both re-authentication routes.
   *
   * `prove` runs the Firebase half and hands back a token this function
   * immediately spends. Written once so the password path and the Google path
   * cannot drift on the order of operations — the phrase check, the token, the
   * reset, and the adopt-then-reload that follows it.
   */
  async function resetWith(prove: () => Promise<string>) {
    if (busy) return;

    if (problem !== null) {
      setShowProblem(true);
      return;
    }

    setBusy(true);
    setFailure(null);
    try {
      const status = await resetVault(typed, await prove());
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
      // `describeAuthError` first: a Firebase failure carries a `code` and a
      // developer-facing message that sometimes echoes the input, and it is the
      // likelier failure here. `errorMessage` handles our own API errors.
      setFailure(isAuthError(cause) ? describeAuthError(cause) : errorMessage(cause));
      setPassword('');
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

  // Screen one: the facts, and every way out that is not a reset. The copy
  // keeps its two sentences apart — the data is gone, and here is how to
  // start again — see the header comment for why that order is load-bearing.
  if (step === 'facts') {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="danger" title="We can’t bring your secrets back">
          They were sealed with keys only your passphrase and recovery codes could open. With both
          gone, nothing can unseal them — not even xecret.
        </Alert>

        <div className="text-fg-muted flex flex-col gap-3 text-sm leading-6">
          <p>
            <span className="text-fg">Resetting gives you a fresh start</span> — a new passphrase
            and a new Emergency Kit. Nothing old comes back, and an owner or admin will need to
            share team environments with you again.
          </p>
          <p>Your teammates and your organisation’s data are unaffected.</p>
        </div>

        <Button variant="danger-outline" onClick={() => setStep('confirm')}>
          I understand — reset my vault
        </Button>
        <Button variant="secondary" onClick={onBack}>
          I have found a code after all
        </Button>
        <Button variant="ghost" asChild>
          <a href={SIGN_IN_PATH}>Sign in with a different account</a>
        </Button>
      </div>
    );
  }

  // Screen two: the act, and nothing else to read.
  return (
    <div className="flex flex-col gap-4">
      {failure !== null ? (
        <Alert tone="danger" title="Your vault was not reset">
          {failure}
        </Alert>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void resetWith(() => reauthenticateWithPassword(email, password));
        }}
        noValidate
        className="flex flex-col gap-4"
      >
        <Field
          label={`Type “${VAULT_RESET_CONFIRMATION}” to confirm`}
          error={showProblem ? problem : null}
        >
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            placeholder={VAULT_RESET_CONFIRMATION}
          />
        </Field>

        <Separator />

        {/*
          The second credential, and the copy says what it is for. Somebody at
          this screen has just failed to prove they know their passphrase, so
          being asked for a *different* secret needs a reason attached or it
          reads as the same demand repeated.
        */}
        <p className="text-fg-muted text-sm leading-6">
          One last check that it’s really you — sign in again with the password or Google account
          you use for xecret. It protects you if someone else has this browser session.
        </p>

        <Field label={`Password for ${email}`}>
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </Field>

        <Button type="submit" variant="danger" loading={busy}>
          Reset my vault
        </Button>
      </form>

      <Button
        variant="secondary"
        loading={busy}
        onClick={() => void resetWith(reauthenticateWithGoogle)}
      >
        Confirm with Google and reset
      </Button>

      <Button variant="ghost" onClick={() => setStep('facts')}>
        Back
      </Button>
    </div>
  );
}
