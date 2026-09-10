'use client';

import { useEffect, useState } from 'react';

import { decodePublicKey } from '@xecret/core/crypto/client';
import { formatAbsoluteTime } from '@/lib/format';
import { Alert, Badge, Tooltip } from '@/components/ui';
import { checkPin, fingerprint, readPins, substitutedRecipients } from './pins';
import type { PinCheck, PinnedKind } from './pins';
import type { Recipient } from './types';

/**
 * A public key's short form, and whether this browser has seen it before.
 *
 * ── What the fingerprint is for ──
 * Not verification — 40 bits is far too short for that, and it is not used as a
 * commitment anywhere. It is a *comparison aid*: two people on a call reading
 * eight characters to each other, in the alphabet this product already uses for
 * recovery codes. The decision "has this key changed" is made against the full
 * 32 bytes by `checkPin`, and this string is what a human looks at while acting
 * on it.
 *
 * ── Why the warning is loud and the first sighting is quiet ──
 * A first sighting is the ordinary case: everybody's key is new once. Marking it
 * would put a yellow badge beside every colleague on the day the feature ships,
 * and a warning that fires on the normal path is a warning people learn to
 * dismiss. A *change* is the abnormal case and the one a substituting server
 * would produce, so that is the one that gets a colour and a sentence.
 */
export function KeyFingerprint({
  kind,
  id,
  publicKey,
  /** Who this key belongs to, for the warning's sentence. */
  label,
}: {
  kind: PinnedKind;
  id: string;
  publicKey: string;
  label?: string;
}) {
  /**
   * The fingerprint and the pin verdict, resolved together.
   *
   * One piece of state rather than two, and both written from the same
   * asynchronous callback: they are always rendered together, and setting the
   * verdict first would put "Key changed" on screen for a frame beside a
   * fingerprint that had not been computed yet — a warning about a value nobody
   * can see.
   */
  const [resolved, setResolved] = useState<{ short: string | null; pin: PinCheck } | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const pin = checkPin(readPins(), kind, id, publicKey);

      let short: string | null;
      try {
        short = await fingerprint(decodePublicKey(publicKey));
      } catch {
        // A key that does not decode is a key nothing can be sealed to, and the
        // rotation dialog will fail loudly on it. Rendering no fingerprint is
        // the honest answer here rather than a fabricated one.
        short = null;
      }

      if (!cancelled) setResolved({ short, pin });
    })();

    return () => {
      cancelled = true;
    };
  }, [kind, id, publicKey]);

  const short = resolved?.short ?? null;
  const changed = resolved?.pin.status === 'changed';

  return (
    <span className="inline-flex items-center gap-1.5">
      <Tooltip
        content={
          changed
            ? `This is not the key ${label ?? 'this principal'} used when you last sealed to them.`
            : 'A short form of the public key this grant is sealed to. Compare it out of band if you want certainty.'
        }
      >
        <code
          className={
            changed ? 'text-danger-text font-mono text-xs' : 'text-fg-subtle font-mono text-xs'
          }
        >
          {short ?? '········'}
        </code>
      </Tooltip>
      {changed ? <Badge tone="danger">Key changed</Badge> : null}
    </span>
  );
}

/**
 * The recipients of a rotation or a share, with their fingerprints.
 *
 * ── This component records nothing ──
 * It used to pin every key it displayed, from an effect, on render. That
 * contradicted `pins.ts`'s own stated rule — *pin on deliberate acts only* — and
 * the contradiction was not academic. Rendering is not consent: opening the
 * rotation dialog to look at it, or landing on a screen that happens to mount
 * this list, recorded whatever the server said at that moment as the key this
 * browser trusts for that person, for ever. A substitution that arrived before
 * any pin existed was therefore pinned *as* the trusted key, and every later
 * comparison agreed with it. The trust-on-first-use window closed on whichever
 * answer arrived first rather than on one somebody acted upon.
 *
 * Pins are now written by the two places a person deliberately seals a key to
 * somebody — `pending-shares.tsx` after a successful share, `rotation-dialog.tsx`
 * after a successful rotation. This displays and compares, and does neither.
 */
export function FingerprintList({ recipients }: { recipients: readonly Recipient[] }) {
  /**
   * Computed during render rather than in an effect.
   *
   * The same pattern, and the same reason, as the environment guard in
   * `useRevealAll`: an effect runs after paint, so a substituted key would have
   * its fingerprint on screen — with no warning beside it — for the frame in
   * which somebody could click "Rotate". It is a pure read of `localStorage`
   * with no state to synchronise, so there is nothing here an effect would buy.
   */
  const changed = substitutedRecipients(recipients);

  if (recipients.length === 0) {
    return <p className="text-fg-muted text-sm">Nobody holds a key for this environment.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {changed.length > 0 ? (
        <Alert tone="danger" title="A public key has changed since you last sealed to it">
          <p>
            {changed.length === 1 ? 'One principal is' : `${changed.length} principals are`}{' '}
            presenting a different key from the one this browser recorded. That happens when
            somebody resets their vault — and it is also exactly what a substituted key looks like.
            Confirm the new fingerprint with them out of band before continuing.
          </p>
        </Alert>
      ) : null}

      <ul className="border-line bg-canvas-inset max-h-48 divide-y divide-[color:var(--color-line-subtle)] overflow-y-auto rounded-lg border">
        {recipients.map((recipient) => (
          <li
            key={`${recipient.kind}:${recipient.id}`}
            className="flex items-center justify-between gap-3 px-3 py-2"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-sm">
              {recipient.kind === 'token' ? 'Service token ' : ''}
              {recipient.id}
            </span>
            <KeyFingerprint
              kind={recipient.kind}
              id={recipient.id}
              publicKey={recipient.publicKey}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "You first saw this key on …", for a tooltip or a detail line. */
export function pinAge(check: PinCheck): string | null {
  if (check.status === 'new') return null;
  return formatAbsoluteTime(check.firstSeen);
}
