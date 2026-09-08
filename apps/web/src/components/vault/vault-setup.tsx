'use client';

import { useMemo, useState } from 'react';
import type { RecoveryCode } from '@xecret/core/crypto/client';

import { errorMessage } from '@/lib/api';
import { Alert, Button, Checkbox, KeyIcon, Label, Spinner } from '@/components/ui';
import { CONSENT_STATEMENT, nextSetupStep, setupStepPosition, setupStepProblem } from './ceremony';
import type { VaultSetupState, VaultSetupStep } from './ceremony';
import { promptedCodeIndex } from './emergency-kit';
import { PassphraseFields, usePassphraseStrength } from './passphrase-fields';
import { PasskeyEnrolment } from './passkey-enrolment';
import { RecoveryKitPanel } from './recovery-kit-panel';
import { setupVault } from './vault-client';
import { useVault } from './vault-keys';

/**
 * Creating a vault: five steps, in the order plan §4.1 sets out.
 *
 * ── Why this is a ceremony and not a settings form ──
 * Because it is the only irreversible decision in the product. Everything else a
 * user does here can be undone by somebody with database access; this cannot, by
 * construction, and that is the feature. So the flow is built to make sure the
 * person going through it has actually understood that before it happens — one
 * screen for the model, one for the choice, one for the artefact they must keep,
 * and only then a dashboard.
 *
 * ── What it must never do ──
 * Offer to remember the passphrase. Offer to email the codes. Offer to skip the
 * kit. Each of those turns a zero-knowledge vault into a vault with a copy of
 * the key somewhere convenient, which is the same thing as not having one.
 */

export interface VaultSetupProps {
  user: { id: string; email: string; displayName: string | null };
  /** Re-reads the session, which is what actually dismisses this screen. */
  onComplete: () => void;
}

export function VaultSetup({ user, onComplete }: VaultSetupProps) {
  const vault = useVault();

  const [step, setStep] = useState<VaultSetupStep>('explain');
  const [state, setState] = useState<Omit<VaultSetupState, 'score'>>({
    consented: false,
    passphrase: '',
    confirm: '',
    kitSaved: false,
    promptedCode: null,
    typedCode: '',
  });
  const [showProblem, setShowProblem] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [codes, setCodes] = useState<readonly RecoveryCode[] | null>(null);
  const [issuedAt, setIssuedAt] = useState<Date>(() => new Date());

  const userInputs = useMemo(
    () => [user.email, ...(user.displayName === null ? [] : [user.displayName])],
    [user.email, user.displayName],
  );

  // Owned here rather than inside the meter, because the gate below reads it:
  // one owner for the verdict and the decision it drives.
  const strength = usePassphraseStrength(state.passphrase, userInputs);

  const problem = setupStepProblem(step, { ...state, score: strength?.score ?? null });
  const position = setupStepPosition(step);

  async function generate() {
    setStep('generating');
    setFailure(null);
    try {
      const result = await setupVault({ userId: user.id, passphrase: state.passphrase });
      vault.adopt({ vault: result.vault, material: result.material });

      const issued = result.codes ?? [];
      setCodes(issued);
      setIssuedAt(new Date());
      setState((current) => ({
        ...current,
        // The passphrase has done its work and is no longer needed by this
        // component. The string cannot be wiped — JavaScript strings are
        // immutable — but dropping the reference is what lets it be collected,
        // and keeping it in state for the two screens that follow would keep it
        // alive for no reason at all.
        passphrase: '',
        confirm: '',
        promptedCode: issued[promptedCodeIndex(issued.length)] ?? null,
      }));
      setShowProblem(false);
      setStep('kit');
    } catch (cause) {
      setFailure(errorMessage(cause));
      setStep('passphrase');
    }
  }

  function advance() {
    if (problem !== null) {
      setShowProblem(true);
      return;
    }
    setShowProblem(false);

    if (step === 'passphrase') {
      void generate();
      return;
    }

    const next = nextSetupStep(step);
    if (next === null || step === 'passkey') {
      onComplete();
      return;
    }
    setStep(next);
  }

  return (
    <div className="flex flex-col gap-6">
      {step === 'generating' ? null : (
        <p className="text-fg-subtle text-sm">
          Step {position.current} of {position.total}
        </p>
      )}

      {failure !== null ? (
        <Alert tone="danger" title="Your vault was not created">
          {failure}
        </Alert>
      ) : null}

      {step === 'explain' ? (
        <ExplainStep
          consented={state.consented}
          onConsent={(consented) => setState((current) => ({ ...current, consented }))}
        />
      ) : null}

      {step === 'passphrase' ? (
        <PassphraseFields
          passphrase={state.passphrase}
          onPassphrase={(passphrase) => setState((current) => ({ ...current, passphrase }))}
          confirm={state.confirm}
          onConfirm={(confirm) => setState((current) => ({ ...current, confirm }))}
          strength={strength}
          problem={showProblem ? problem : null}
          autoFocus
        />
      ) : null}

      {step === 'generating' ? <GeneratingStep /> : null}

      {step === 'kit' && codes !== null ? (
        <RecoveryKitPanel
          email={user.email}
          codes={codes}
          issuedAt={issuedAt}
          saved={state.kitSaved}
          onSaved={() => setState((current) => ({ ...current, kitSaved: true }))}
          promptedCode={state.promptedCode}
          typedCode={state.typedCode}
          onTypedCode={(typedCode) => setState((current) => ({ ...current, typedCode }))}
          problem={showProblem ? problem : null}
        />
      ) : null}

      {step === 'passkey' ? (
        <PasskeyEnrolment
          user={user}
          material={vault.material}
          keys={vault.keys}
          onEnrolled={(passkey) => {
            if (vault.material === null) return;
            vault.adopt({
              material: { ...vault.material, passkeys: [...vault.material.passkeys, passkey] },
            });
          }}
        />
      ) : null}

      {step === 'generating' ? null : (
        <div className="flex flex-col gap-2">
          <Button variant="primary" size="lg" onClick={advance}>
            {step === 'passphrase' ? 'Create my vault' : step === 'passkey' ? 'Finish' : 'Continue'}
          </Button>

          {/* Shown under the button rather than as a tooltip on a disabled one:
              the button stays clickable so that pressing it is what reveals the
              reason, which is the only version of this a keyboard user can
              discover. */}
          {showProblem && problem !== null ? (
            <p role="alert" className="text-danger-text text-sm leading-5">
              {problem}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ExplainStep({
  consented,
  onConsent,
}: {
  consented: boolean;
  onConsent: (value: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="text-fg-muted flex flex-col gap-3 text-sm leading-6">
        <p>
          Everything you store in xecret is encrypted on this device before it is sent. The key that
          decrypts it is derived from a <span className="text-fg">master passphrase</span> only you
          know. We never receive it, and we cannot derive it from anything we hold.
        </p>
        <p>
          That is the whole product, and it has one consequence worth being blunt about: a forgotten
          passphrase is not a support ticket. There is no key on our side to reset it with. What
          stands between you and that outcome is a set of five recovery codes, which you will be
          given in a moment and which you must keep somewhere safe.
        </p>
      </div>

      <label className="border-line bg-canvas-inset flex cursor-pointer items-start gap-3 rounded-lg border p-4">
        <Checkbox
          checked={consented}
          onCheckedChange={(next) => onConsent(next === true)}
          className="mt-0.5"
        />
        <Label className="cursor-pointer text-sm leading-6 font-normal">{CONSENT_STATEMENT}</Label>
      </label>
    </div>
  );
}

/**
 * The blocking state, and why it is a whole screen.
 *
 * Argon2id at the production parameters costs about a second, and the upload
 * that follows is not cancellable in any meaningful sense — a request that
 * created the vault and whose response was abandoned would leave a browser that
 * thinks it has no vault and an account that has one. So there is nothing here
 * to click, and saying so with an empty screen is more honest than a disabled
 * form somebody will keep trying to interact with.
 */
function GeneratingStep() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center gap-4 py-10 text-center"
    >
      <Spinner className="size-6" label={null} />
      <div className="flex flex-col gap-1">
        <p className="text-fg text-sm font-medium">Securing your vault…</p>
        <p className="text-fg-subtle text-sm leading-6">
          Stretching your passphrase and generating your keys. This takes a moment on purpose — the
          same work is what makes guessing it expensive.
        </p>
      </div>
      <span className="text-fg-subtle inline-flex items-center gap-2 text-sm">
        <KeyIcon className="size-4" />
        Nothing has left this device yet.
      </span>
    </div>
  );
}
