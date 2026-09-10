'use client';

import { useEffect, useState } from 'react';

import { parseInviteFragment, RecoveryCodeError, zeroize } from '@xecret/core/crypto/client';
import { pluralize } from '@/lib/format';
import { Alert, Button, Field, Input, Spinner } from '@/components/ui';
import { useVaultKeys, VaultProvider, VaultSetup, VaultUnlock } from '@/components/vault';
import { reSealInviteGrants } from './env-keys';
import type { InviteKeyGrant } from './types';

/**
 * The second half of an invitation: the key code, and what it unlocks.
 *
 * ── Where this sits in the flow ──
 * Acceptance has already happened. The membership exists, the person is in the
 * organisation, and the server has handed back the grants that were sealed to
 * the invitation's one-off keypair. What is left is a purely client-side act:
 * derive the same private key from the code, open each grant, and re-seal it to
 * their own key. The invitation's copies are destroyed by the write that stores
 * each re-sealed one — per environment, in the same transaction — so nothing is
 * lost by taking as long as this takes.
 *
 * ── Why the vault ceremony is *inside* this screen ──
 * Because the population this screen exists for is people who have just arrived.
 * An invitation link is somebody's first contact with the product; they sign up,
 * they accept, and they land here with no vault at all — no key of their own to
 * re-seal to, and previously no way to make one without leaving, which discarded
 * the fragment along with the tab. Offering setup and unlock in place, the way
 * the CLI consent screen does, is what makes the two-channel flow usable by the
 * people it was designed for rather than only by an existing member who happened
 * to have an unlocked tab.
 *
 * The code lives in component state across all of that. Not `sessionStorage`,
 * not a URL, not anywhere a later page load could find it: it is the private half
 * of a key that opens environment data keys, and the whole argument for carrying
 * it in a fragment is that it does not get written down.
 *
 * ── Why skipping is offered, and is not a failure ──
 * The code may have been lost, or never sent. That is survivable by design: the
 * same acceptance queued a pending key share for every environment the new
 * member can read, so a teammate who holds the key can hand it over. And the
 * grants are no longer consumed by the acceptance, so somebody who skips can come
 * back — `GET /api/invitations/claimable` re-serves them for as long as they are
 * unclaimed, which is what the "enter your invite code" affordance reads.
 *
 * ── The fragment from the URL ──
 * Read from `#fragment` if it is there, because a link that carries it is a
 * single-channel delivery the inviter chose — the UI cannot prevent that, and
 * refusing to read it would only make them paste it by hand. It is a fragment
 * rather than a query parameter for the one reason that matters: browsers do not
 * transmit it, so it never reaches a server log, a proxy, or `Referer`. The
 * fragment is cleared from the address bar as soon as it has been read.
 */
export interface InviteKeyStepProps {
  orgSlug: string;
  invitationId: string;
  grants: readonly InviteKeyGrant[];
  /**
   * The inline vault ceremony, when this screen is somewhere that needs to offer
   * one.
   *
   * Present on the invitation page, where the account may be minutes old and
   * there is no shell above to have gated on a vault. Absent inside the
   * dashboard, which never renders anything below its own lock screen — offering
   * a second setup flow there would be a second answer to a question already
   * answered.
   *
   * `user.id` is not decoration: every wrap's AAD binds it, so neither a setup nor
   * an unlock can happen without it.
   */
  vaultGate?: {
    user: { id: string; email: string; displayName: string | null };
    /** Whether this account has a vault at all — decides setup versus unlock. */
    configured: boolean;
    /** Re-reads the account, after a vault is created or unlocked here. */
    onChanged: () => void;
  };
  /** Move on — either because the keys are in, or because the code was lost. */
  onDone: () => void;
}

type Phase =
  { kind: 'entering' } | { kind: 'working' } | { kind: 'done'; opened: number; failed: number };

export function InviteKeyStep({
  orgSlug,
  invitationId,
  grants,
  vaultGate,
  onDone,
}: InviteKeyStepProps) {
  const vault = useVaultKeys();
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'entering' });

  /**
   * The code from the URL fragment, if the inviter put it there.
   *
   * Read during the first client render rather than in an effect. An effect runs
   * after paint, so the field would be visibly empty for a frame and then fill
   * itself — and a person who started typing in that frame would have their
   * keystrokes overwritten. React's documented escape hatch for "derive state
   * once, on the client" is exactly this: adjust state during render, guarded by
   * a flag so it happens once.
   *
   * `window` is checked because this page server-renders; on the server there is
   * no fragment to read, which is also true of the browser's own behaviour —
   * a `#fragment` is never transmitted, which is the whole reason the code is
   * carried there rather than in a query parameter.
   */
  const [hashRead, setHashRead] = useState(false);
  if (!hashRead && typeof window !== 'undefined') {
    setHashRead(true);
    const hash = window.location.hash.replace(/^#/, '');
    if (hash.length > 0) setCode(decodeURIComponent(hash));
  }

  // Clearing the address bar *is* an external-system update, so it belongs in an
  // effect. `replaceState` rather than a navigation: the page must not reload,
  // and nothing should be added to history.
  useEffect(() => {
    if (!hashRead || typeof window === 'undefined') return;
    if (window.location.hash.length === 0) return;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }, [hashRead]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (phase.kind === 'working' || vault === null) return;

    let seed;
    try {
      seed = parseInviteFragment(code).seed;
    } catch (cause) {
      setProblem(
        cause instanceof RecoveryCodeError && cause.reason === 'checksum'
          ? 'That code has a typo in it — the check character does not match. Compare it with what you were sent.'
          : 'That does not look like a key code. It is 27 characters in six groups, like ABCDE-FGHJK-MNPQR-STVWX-YZ012-3A.',
      );
      return;
    }

    setProblem(null);
    setPhase({ kind: 'working' });

    try {
      const outcome = await reSealInviteGrants({
        vault,
        fragmentSeed: seed,
        invitationId,
        grants,
        orgSlug,
      });

      if (outcome.opened === 0) {
        // Every grant failed to open, which almost always means the code belongs
        // to a different invitation — it passed its own checksum, so it is not a
        // typo. Said plainly, because "decryption failed" is not a sentence
        // anybody can act on.
        setPhase({ kind: 'entering' });
        setProblem(
          'That code did not unlock anything. It is well-formed, so it is probably from a different invitation — check you copied the right one.',
        );
        return;
      }

      setPhase({ kind: 'done', opened: outcome.opened, failed: outcome.failed.length });
    } catch {
      setPhase({ kind: 'entering' });
      setProblem('Something went wrong unlocking these keys. Try again.');
    } finally {
      zeroize(seed);
    }
  }

  if (grants.length === 0) return null;

  if (phase.kind === 'done') {
    return (
      <Alert tone="success" title="Keys unlocked">
        <p>
          You can now read {pluralize(phase.opened, 'environment')} straight away.
          {phase.failed > 0
            ? ` ${pluralize(phase.failed, 'environment')} could not be unlocked — a teammate will share ${phase.failed === 1 ? 'that one' : 'those'} with you.`
            : ''}
        </p>
        <div className="mt-2">
          <Button variant="primary" size="sm" onClick={onDone}>
            Continue
          </Button>
        </div>
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-fg text-base font-semibold">Enter the key code</h2>
        <p className="text-fg-muted text-sm leading-5">
          Whoever invited you sent a short code by a different route from the link — a message, a
          call, in person. It unlocks {pluralize(grants.length, 'environment')} immediately. It was
          never sent to us, which is the point: the link alone decrypts nothing.
        </p>
      </div>

      <Field label="Key code" error={problem}>
        <Input
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            setProblem(null);
          }}
          placeholder="ABCDE-FGHJK-MNPQR-STVWX-YZ012-3A"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="font-mono"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={phase.kind === 'working'}
          disabled={vault === null}
        >
          Unlock the keys
        </Button>
        {/* Not a hidden escape hatch. Losing the code is an ordinary outcome and
            the product has a designed answer for it — the pending key shares the
            acceptance already queued, and the code can still be entered later
            from the environment that is waiting for it. */}
        <Button type="button" variant="ghost" onClick={onDone} disabled={phase.kind === 'working'}>
          I do not have it
        </Button>
        {phase.kind === 'working' ? (
          <span className="text-fg-subtle flex items-center gap-2 text-sm">
            <Spinner className="size-4" />
            Unlocking…
          </span>
        ) : null}
      </div>

      {/*
       * The ceremony, in place, with the typed code still in state above it.
       *
       * Rendered below the field rather than instead of it, so that somebody who
       * arrived with the code in the URL can see it is safely captured while they
       * do the part that takes a minute. `VaultProvider` is mounted here because
       * this route sits outside the dashboard shell and there is nothing above it
       * holding the vault material — the same reason the CLI consent screen
       * mounts its own.
       */}
      {vault !== null ? null : vaultGate === undefined ? (
        <Alert tone="warning" title="Set up or unlock your vault first">
          <p>
            The keys are re-sealed to your own key, which only exists once your vault is set up and
            unlocked in this browser.
          </p>
        </Alert>
      ) : (
        <div className="border-line mt-1 flex flex-col gap-3 rounded-lg border p-4">
          <div>
            <p className="text-fg text-sm font-medium">
              {vaultGate.configured ? 'Unlock your vault to finish' : 'Set up your vault to finish'}
            </p>
            <p className="text-fg-muted mt-1 text-sm leading-6">
              {vaultGate.configured
                ? 'The keys are re-sealed to your own key, which only exists while your vault is unlocked in this browser. Nothing is sent to the server.'
                : 'The keys are re-sealed to a key of your own, and your account does not have one yet. Creating it takes a minute and only has to happen once.'}
            </p>
          </div>

          <VaultProvider>
            {vaultGate.configured ? (
              <VaultUnlock user={vaultGate.user} onUnlocked={vaultGate.onChanged} />
            ) : (
              <VaultSetup user={vaultGate.user} onComplete={vaultGate.onChanged} />
            )}
          </VaultProvider>
        </div>
      )}
    </form>
  );
}
