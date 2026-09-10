'use client';

import { useMemo, useState } from 'react';
import type { RecoveryCode } from '@xecret/core/crypto/client';

import { errorMessage } from '@/lib/api';
import { formatAbsoluteTime, formatRelativeTime, pluralize, toIsoString } from '@/lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  KeyIcon,
  RefreshIcon,
  Separator,
  Skeleton,
  useToast,
} from '@/components/ui';
import { kitConfirmationProblem, promptedCodeIndex } from './emergency-kit';
import { PasskeyEnrolment } from './passkey-enrolment';
import { passphraseProblem } from './passphrase';
import { PassphraseFields, usePassphraseStrength } from './passphrase-fields';
import { RecoveryKitPanel } from './recovery-kit-panel';
import { changePassphrase, regenerateRecoveryCodes, removeVaultPasskey } from './vault-client';
import type { VaultPasskey } from './vault-client';
import { useVault } from './vault-keys';

/**
 * The Security page's vault section: the passphrase, the kit, and the passkeys.
 *
 * ── The sudo pattern, applied twice ──
 * Changing the passphrase and reissuing the recovery kit both require the
 * *current* passphrase to be typed again, even though this page is already
 * behind an unlocked session. The two prove different things: the unlock proves
 * this session opened the vault at some point in the last eight hours, and the
 * re-entry proves the person at the keyboard right now knows the passphrase.
 * Without the second, an unattended desk is a passphrase change and a fresh set
 * of printed codes — the two acts that would hand somebody durable access.
 *
 * The endpoints enforce it as well (`currentUnlockVerifier` in both bodies), so
 * this is not a client-side courtesy; the field is here because the verifier
 * cannot be derived without it.
 *
 * ── Auto-lock is not here ──
 * It lives in the Lock card immediately below, which is also where "lock this
 * device" and "lock every device" are. Splitting the interval away from the two
 * buttons it governs, to satisfy a section boundary, would put one setting in
 * two places on one page.
 */

export interface VaultCardProps {
  user: { id: string; email: string; displayName: string | null };
}

export function VaultCard({ user }: VaultCardProps) {
  const vault = useVault();

  if (vault.loading && vault.material === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Vault</CardTitle>
        </CardHeader>
        <CardContent>
          <div aria-busy="true" aria-label="Loading your vault" className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Vault</CardTitle>
        <CardDescription>
          Your master passphrase, recovery codes and passkeys — the keys that decrypt your secrets
          in this browser. None of them is ever sent to xecret.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-8">
        {vault.material === null ? (
          <Alert tone="info" title="No vault yet">
            This account has not been through vault setup. Reload the dashboard to start it.
          </Alert>
        ) : (
          <>
            <ChangePassphraseSection user={user} />
            <Separator />
            <RecoveryCodesSection user={user} />
            <Separator />
            <PasskeysSection user={user} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ────────────────────────── change the passphrase ────────────────────────── */

function ChangePassphraseSection({ user }: VaultCardProps) {
  const vault = useVault();
  const { toast } = useToast();

  const [current, setCurrent] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');

  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const userInputs = useMemo(
    () => [user.email, ...(user.displayName === null ? [] : [user.displayName])],
    [user.email, user.displayName],
  );
  const strength = usePassphraseStrength(passphrase, userInputs);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || vault.keys === null || vault.material === null) return;

    const failure = passphraseProblem({ passphrase, confirm, score: strength?.score ?? null });
    if (failure !== null) {
      setProblem(failure);
      return;
    }
    if (current.length === 0) {
      setProblem('Type your current passphrase to confirm this is you.');
      return;
    }

    setBusy(true);
    setProblem(null);
    try {
      const result = await changePassphrase({
        userId: user.id,
        userKey: vault.keys.userKey,
        material: vault.material,
        currentPassphrase: current,
        newPassphrase: passphrase,
      });
      // The wrap this page was holding is now superseded; a client still using
      // it would fail its next unlock against a row that has moved on.
      vault.adopt({ vault: result.vault, material: result.material });

      setCurrent('');
      setPassphrase('');
      setConfirm('');
      toast({
        variant: 'success',
        title: 'Passphrase changed',
        description:
          'Your recovery codes still work and your other devices stay unlocked — the key itself did not change, only the passphrase that unwraps it.',
      });
    } catch (cause) {
      setProblem(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div>
        <h3 className="text-fg text-sm font-medium">Master passphrase</h3>
        <p className="text-fg-subtle mt-1 text-sm leading-6">
          Changing it re-encrypts one 32-byte key and nothing else, so no secret is re-encrypted,
          your recovery codes keep working, and sessions on your other devices stay unlocked.
        </p>
      </div>

      {problem !== null ? (
        <Alert tone="danger" title="The passphrase was not changed">
          {problem}
        </Alert>
      ) : null}

      <Field
        label="Current passphrase"
        hint="Asked for again even though you are signed in — it is what proves this is you and not somebody at your desk."
      >
        <Input
          type="password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          autoComplete="current-password"
          spellCheck={false}
        />
      </Field>

      <PassphraseFields
        passphrase={passphrase}
        onPassphrase={setPassphrase}
        confirm={confirm}
        onConfirm={setConfirm}
        strength={strength}
        labels={{ passphrase: 'New passphrase', confirm: 'Confirm new passphrase' }}
      />

      <div>
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={current.length === 0 || passphrase.length === 0}
        >
          Change passphrase
        </Button>
      </div>
    </form>
  );
}

/* ───────────────────────────── recovery codes ───────────────────────────── */

function RecoveryCodesSection({ user }: VaultCardProps) {
  const vault = useVault();
  const { toast } = useToast();

  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const [issued, setIssued] = useState<readonly RecoveryCode[] | null>(null);
  const [issuedAt, setIssuedAt] = useState(() => new Date());
  const [promptedCode, setPromptedCode] = useState<RecoveryCode | null>(null);
  const [saved, setSaved] = useState(false);
  const [typedCode, setTypedCode] = useState('');
  const [showKitProblem, setShowKitProblem] = useState(false);

  const remaining = vault.material?.recoveryCodesRemaining ?? 0;

  async function regenerate(event: React.FormEvent) {
    event.preventDefault();
    if (busy || vault.keys === null || vault.material === null) return;
    if (passphrase.length === 0) {
      setProblem('Type your passphrase to confirm this is you.');
      return;
    }

    setBusy(true);
    setProblem(null);
    try {
      const result = await regenerateRecoveryCodes({
        userId: user.id,
        userKey: vault.keys.userKey,
        material: vault.material,
        passphrase,
      });

      setPassphrase('');
      setIssued(result.codes);
      setIssuedAt(new Date());
      setPromptedCode(result.codes[promptedCodeIndex(result.codes.length)] ?? null);
      setSaved(false);
      setTypedCode('');
      setShowKitProblem(false);
      vault.adopt({
        material: { ...vault.material, recoveryCodesRemaining: result.remaining },
      });
    } catch (cause) {
      setProblem(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const kitProblem =
    promptedCode === null
      ? null
      : kitConfirmationProblem({ saved, prompted: promptedCode, typed: typedCode });

  function closeKit() {
    if (kitProblem !== null) {
      setShowKitProblem(true);
      return;
    }
    setIssued(null);
    toast({
      variant: 'success',
      title: 'New recovery codes issued',
      description: 'Every previous code stopped working the moment these were created.',
    });
  }

  return (
    <>
      <form onSubmit={regenerate} noValidate className="flex flex-col gap-4">
        <div>
          <h3 className="text-fg text-sm font-medium">Recovery codes</h3>
          <p className="text-fg-subtle mt-1 text-sm leading-6">
            {remaining === 0
              ? 'You have no unused recovery codes left. Issue a new set now — without one, a forgotten passphrase is the end of your vault.'
              : `${pluralize(remaining, 'unused code')} left of five. Reissuing replaces every one of them, including any you have already printed.`}
          </p>
        </div>

        {remaining === 0 ? (
          <Alert tone="warning" title="Nothing stands behind your passphrase">
            Recovery codes are the only way back into a vault whose passphrase has been forgotten.
          </Alert>
        ) : null}

        {problem !== null ? (
          <Alert tone="danger" title="No new codes were issued">
            {problem}
          </Alert>
        ) : null}

        <Field
          label="Your passphrase"
          hint="Printing a fresh set of codes is exactly the act a re-entry requirement exists to stop."
        >
          <Input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            autoComplete="current-password"
            spellCheck={false}
          />
        </Field>

        <div>
          <Button
            type="submit"
            variant="secondary"
            loading={busy}
            disabled={passphrase.length === 0}
          >
            <RefreshIcon className="size-4" />
            Issue new recovery codes
          </Button>
        </div>
      </form>

      <Dialog
        open={issued !== null}
        onOpenChange={(open) => {
          if (!open) closeKit();
        }}
      >
        <DialogContent
          // No corner dismiss: leaving this dialog is a decision, and the gate
          // below is the whole reason it exists.
          hideCloseButton
          className="max-w-lg"
        >
          <DialogHeader>
            <DialogTitle>Your new recovery codes</DialogTitle>
            <DialogDescription>
              The previous five stopped working the moment these were created.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {issued === null ? null : (
              <RecoveryKitPanel
                email={user.email}
                codes={issued}
                issuedAt={issuedAt}
                saved={saved}
                onSaved={() => setSaved(true)}
                promptedCode={promptedCode}
                typedCode={typedCode}
                onTypedCode={setTypedCode}
                problem={showKitProblem ? kitProblem : null}
              />
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="primary" onClick={closeKit}>
              I have saved them
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ──────────────────────────────── passkeys ──────────────────────────────── */

function PasskeysSection({ user }: VaultCardProps) {
  const vault = useVault();
  const { toast } = useToast();
  const [removing, setRemoving] = useState<VaultPasskey | null>(null);

  const passkeys = vault.material?.passkeys ?? [];

  async function remove() {
    if (removing === null || vault.material === null) return;
    const target = removing;

    await removeVaultPasskey(target.id);
    vault.adopt({
      material: {
        ...vault.material,
        passkeys: vault.material.passkeys.filter((passkey) => passkey.id !== target.id),
      },
    });
    toast({ variant: 'success', title: `Removed “${target.label}”` });
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-fg text-sm font-medium">Passkeys</h3>
          <p className="text-fg-subtle mt-1 text-sm leading-6">
            Each enrolled passkey holds its own encrypted copy of your key, opened by your
            authenticator. Removing one can never lock you out: your passphrase is always there and
            cannot be removed.
          </p>
        </div>

        {passkeys.length === 0 ? (
          <p className="text-fg-subtle text-sm">No passkeys enrolled.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {passkeys.map((passkey) => (
              <li
                key={passkey.id}
                className="border-line bg-canvas-inset flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3"
              >
                <KeyIcon className="text-fg-muted size-4 shrink-0" />
                <span className="text-fg text-sm font-medium">{passkey.label}</span>
                {passkey.transports?.includes('internal') ? (
                  <Badge tone="neutral">This device type</Badge>
                ) : null}
                <span className="w-full sm:hidden" />
                <span className="text-fg-subtle text-sm">
                  added{' '}
                  <time
                    dateTime={toIsoString(passkey.createdAt)}
                    title={formatAbsoluteTime(passkey.createdAt)}
                  >
                    {formatRelativeTime(passkey.createdAt)}
                  </time>
                  {passkey.lastUsedAt === null
                    ? ' · never used'
                    : ` · last used ${formatRelativeTime(passkey.lastUsedAt)}`}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setRemoving(passkey)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <PasskeyEnrolment
          user={user}
          material={vault.material}
          keys={vault.keys}
          onEnrolled={(passkey) => {
            if (vault.material === null) return;
            vault.adopt({
              material: { ...vault.material, passkeys: [...vault.material.passkeys, passkey] },
            });
            toast({ variant: 'success', title: `Enrolled “${passkey.label}”` });
          }}
        />
      </div>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={removing === null ? 'Remove this passkey?' : `Remove “${removing.label}”?`}
        description="Its encrypted copy of your key is deleted with it. Your passphrase still opens your vault, and you can enrol the same authenticator again later."
        confirmLabel="Remove it"
        onConfirm={remove}
      />
    </>
  );
}
