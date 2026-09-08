'use client';

import { useEffect, useState } from 'react';

import { parseInviteFragment, RecoveryCodeError, zeroize } from '@xecret/core/crypto/client';
import { pluralize } from '@/lib/format';
import { Alert, Button, Field, Input, Spinner } from '@/components/ui';
import { useVaultKeys } from '@/components/vault';
import { reSealInviteGrants } from './env-keys';
import type { InviteKeyGrant } from './types';

/**
 * The second half of an invitation: the key code, and what it unlocks.
 *
 * ── Where this sits in the flow ──
 * Acceptance has already happened. The membership exists, the person is in the
 * organisation, and the server has handed back the grants that were sealed to
 * the invitation's one-off keypair — and deleted them as they left, because a
 * fragment sitting in somebody's chat history does not expire the way a token
 * does. What is left is a purely client-side act: derive the same private key
 * from the code, open each grant, and re-seal it to their own key.
 *
 * ── Why skipping is offered, and is not a failure ──
 * The code may have been lost, or never sent. That is survivable by design: the
 * same acceptance queued a pending key share for every environment the new
 * member can read, so a teammate who holds the key can hand it over. Making this
 * step mandatory would strand somebody whose colleague forgot to send the second
 * message — for no security gain, because the alternative path is one an
 * administrator was always going to have.
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
  /** Move on — either because the keys are in, or because the code was lost. */
  onDone: () => void;
}

type Phase =
  { kind: 'entering' } | { kind: 'working' } | { kind: 'done'; opened: number; failed: number };

export function InviteKeyStep({ orgSlug, invitationId, grants, onDone }: InviteKeyStepProps) {
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
            acceptance already queued. */}
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

      {vault === null ? (
        <Alert tone="warning" title="Set up or unlock your vault first">
          <p>
            The keys are re-sealed to your own key, which only exists once your vault is set up and
            unlocked in this browser.
          </p>
        </Alert>
      ) : null}
    </form>
  );
}
