'use client';

import { useEffect, useState } from 'react';

import { decodePublicKey } from '@xecret/core/crypto/client';
import { formatAbsoluteTime } from '@/lib/format';
import { Alert, Badge, Tooltip } from '@/components/ui';
import { checkPin, fingerprint, readPins, recordPin, writePins } from './pins';
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
 * ── Why the pins are recorded here and not on every render ──
 * They are recorded when this list is *shown as part of an act* — the rotation
 * dialog and the share prompt both mount it — because that is the moment
 * somebody is about to seal to these keys. Pinning on any render would record
 * whatever the server said the first time a page happened to load, which is a
 * pin nobody consented to and a comparison against itself.
 *
 * A key that has **changed** is never re-pinned here. Overwriting it would erase
 * the only evidence that a substitution happened, on the render that displays
 * the warning about it.
 */
export function FingerprintList({ recipients }: { recipients: readonly Recipient[] }) {
  const [changed, setChanged] = useState<readonly Recipient[]>([]);

  /**
   * Compared during render rather than in an effect.
   *
   * The same pattern, and the same reason, as the environment guard in
   * `useRevealAll`: an effect runs after paint, so a substituted key would have
   * its fingerprint on screen — with no warning beside it — for the frame in
   * which somebody could click "Rotate". React's documented way to adjust state
   * when a prop changes is to do it during render, and this is that case.
   *
   * The *write* stays in an effect below, because writing to `localStorage` is
   * exactly the "update an external system" an effect is for.
   */
  const [renderedFor, setRenderedFor] = useState<readonly Recipient[] | null>(null);
  if (renderedFor !== recipients) {
    setRenderedFor(recipients);
    setChanged(substitutionsIn(recipients));
  }

  useEffect(() => {
    const pins = readPins();
    let next = pins;

    for (const recipient of recipients) {
      // A key that has changed is never re-pinned. Overwriting it would erase
      // the only evidence that a substitution happened, on the very render that
      // displays the warning about it — `recordPin` already refuses, and this
      // says so at the call site too.
      next = recordPin(next, recipient.kind, recipient.id, recipient.publicKey);
    }

    if (next !== pins) writePins(next);
  }, [recipients]);

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

/** The recipients presenting a key this browser did not record for them. */
function substitutionsIn(recipients: readonly Recipient[]): readonly Recipient[] {
  const pins = readPins();
  return recipients.filter(
    (recipient) =>
      checkPin(pins, recipient.kind, recipient.id, recipient.publicKey).status === 'changed',
  );
}
