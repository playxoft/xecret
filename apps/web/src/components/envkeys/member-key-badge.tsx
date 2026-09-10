'use client';

import { useEffect, useState } from 'react';

import { decodePublicKey } from '@xecret/core/crypto/client';
import { formatAbsoluteTime } from '@/lib/format';
import { Tooltip } from '@/components/ui';
import { fingerprint, pinKey, readPins } from './pins';

/**
 * The key this browser has recorded for one member.
 *
 * ── Why it reads the pin book rather than the API ──
 * Not for want of an endpoint — `GET …/keys/recipients` serves public keys. It
 * is that the *pin* is the more meaningful thing to show here. A fingerprint
 * fetched fresh is whatever the server said a moment ago, and a person comparing
 * it on a call would be comparing the server's current answer against itself. A
 * pin is what this browser sealed to, recorded at the moment somebody
 * deliberately shared or rotated a key — so reading it out loud tests something.
 *
 * A member with no pin is the ordinary case, not a warning: it means this
 * browser has never sealed anything to them. Rendering a dash rather than a
 * badge keeps the members table from filling up with yellow on the day this
 * ships.
 */
export function MemberKeyBadge({ userId }: { userId: string }) {
  const [state, setState] = useState<{ short: string; firstSeen: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Everything, including "there is no pin", is resolved in the asynchronous
    // callback. Writing the empty case synchronously would be a cascading render
    // for a value that is already the initial state.
    void (async () => {
      const pin = readPins()[pinKey('member', userId)];
      if (pin === undefined) {
        if (!cancelled) setState(null);
        return;
      }

      try {
        const short = await fingerprint(decodePublicKey(pin.publicKey));
        if (!cancelled) setState({ short, firstSeen: pin.firstSeen });
      } catch {
        // A recorded key that no longer decodes is a corrupted book entry, not
        // a security event. Rendering nothing is the honest answer.
        if (!cancelled) setState(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (state === null) {
    return (
      <Tooltip content="You have not shared an environment key with this person from this browser, so there is no key recorded to compare.">
        <span className="text-fg-subtle text-sm">—</span>
      </Tooltip>
    );
  }

  return (
    <Tooltip
      content={`The public key this browser recorded for them on ${formatAbsoluteTime(state.firstSeen)}. Read it to them on a call to confirm nothing has been substituted.`}
    >
      <code className="text-fg-subtle font-mono text-xs">{state.short}</code>
    </Tooltip>
  );
}
