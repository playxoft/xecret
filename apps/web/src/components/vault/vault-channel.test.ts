import { afterEach, describe, expect, it } from 'vitest';

import { holdVaultKeys, readVaultKeys, releaseVaultKeys, setMirrorStorage } from './key-store';
import { decideVaultChannelAction, installVaultChannel } from './vault-channel';
import type { VaultChannelMessage, VaultChannelPort } from './vault-channel';
import { encodeMirror } from './session-mirror';
import type { VaultKeyMaterial } from './key-store';

/**
 * What one tab does about what another tab said.
 *
 * The decision is pure, so the rules below are asserted directly rather than by
 * opening two browser windows: an unlocked tab answers a request, a tab adopts
 * only the offer it asked for, a lock is honoured by everybody. The installed
 * half is exercised over a fake port for the two properties that are easy to get
 * wrong and invisible when they are — that a lock is broadcast from *every* path
 * that reaches the key store, and that hearing one does not start a volley.
 */

function material(fill: number, userId = 'user-1'): VaultKeyMaterial {
  return {
    userId,
    userKey: new Uint8Array(32).fill(fill),
    encPrivateKey: new Uint8Array(32).fill(fill + 1),
    encPublicKey: new Uint8Array(32).fill(fill + 2),
    signPrivateKey: new Uint8Array(32).fill(fill + 3),
    signPublicKey: new Uint8Array(32).fill(fill + 4),
  };
}

/** A `BroadcastChannel` that records rather than broadcasts. */
function fakePort(): VaultChannelPort & {
  sent: VaultChannelMessage[];
  deliver: (message: unknown) => void;
  closed: boolean;
} {
  const sent: VaultChannelMessage[] = [];
  let handler: ((message: unknown) => void) | null = null;

  return {
    sent,
    closed: false,
    post: (message) => {
      sent.push(message);
    },
    listen: (next) => {
      handler = next;
    },
    deliver: (message) => handler?.(message),
    close(): void {
      this.closed = true;
    },
  };
}

afterEach(() => {
  releaseVaultKeys();
  setMirrorStorage(null);
});

describe('deciding what to do about a message', () => {
  const unlocked = { held: true, pendingNonce: null, userId: 'user-1' };
  const waiting = { held: false, pendingNonce: 'nonce-1', userId: 'user-1' };
  const asking = { type: 'handoff-request', nonce: 'n', userId: 'user-1' };

  it('answers a handoff request only when it has something to answer with', () => {
    expect(decideVaultChannelAction(asking, unlocked)).toEqual({ kind: 'offer', nonce: 'n' });
    // A locked tab answering would send an empty offer the requester would have
    // to tell apart from silence.
    expect(decideVaultChannelAction(asking, waiting)).toEqual({ kind: 'ignore' });
  });

  it('refuses to build an offer for a request that names another account', () => {
    // The keys on this tab belong to exactly one account, and the receiving
    // side's own account check is the *requester's* — which is not the party to
    // rely on when the thing being sent is a User Key. Without this, any script
    // on the origin could compose three fields and be handed the whole set.
    expect(
      decideVaultChannelAction(
        { type: 'handoff-request', nonce: 'n', userId: 'somebody-else' },
        unlocked,
      ),
    ).toEqual({ kind: 'ignore' });
  });

  it('adopts only the offer it asked for', () => {
    expect(
      decideVaultChannelAction({ type: 'handoff-offer', nonce: 'nonce-1', blob: 'b' }, waiting),
    ).toEqual({ kind: 'adopt', blob: 'b' });

    // Somebody else's answer.
    expect(
      decideVaultChannelAction({ type: 'handoff-offer', nonce: 'other', blob: 'b' }, waiting),
    ).toEqual({ kind: 'ignore' });

    // Never asked.
    expect(
      decideVaultChannelAction(
        { type: 'handoff-offer', nonce: 'nonce-1', blob: 'b' },
        { held: false, pendingNonce: null, userId: 'user-1' },
      ),
    ).toEqual({ kind: 'ignore' });

    // Unlocked by passphrase in the second between asking and being answered.
    // Adopting here would replace fresh keys with an older copy.
    expect(
      decideVaultChannelAction(
        { type: 'handoff-offer', nonce: 'nonce-1', blob: 'b' },
        { held: true, pendingNonce: 'nonce-1', userId: 'user-1' },
      ),
    ).toEqual({ kind: 'ignore' });
  });

  it('asks again when another tab says it has just been unlocked', () => {
    // The gap this closes: a request posted at install is heard only by tabs
    // that are unlocked at that instant, so a second tab opened before the first
    // was unlocked heard silence and then nothing, for ever.
    expect(decideVaultChannelAction({ type: 'unlocked', userId: 'user-1' }, waiting)).toEqual({
      kind: 'ask',
    });

    // A tab that already has keys has nothing to ask for, and one signed in as
    // somebody else has nothing to ask *this* answerer for.
    expect(decideVaultChannelAction({ type: 'unlocked', userId: 'user-1' }, unlocked)).toEqual({
      kind: 'ignore',
    });
    expect(
      decideVaultChannelAction({ type: 'unlocked', userId: 'somebody-else' }, waiting),
    ).toEqual({ kind: 'ignore' });
  });

  it('honours a lock even when it is holding nothing', () => {
    // A reloaded tab that has not restored yet holds no keys and still has a
    // mirror in `sessionStorage`; skipping it would leave that blob behind.
    expect(decideVaultChannelAction({ type: 'lock' }, unlocked)).toEqual({ kind: 'lock' });
    expect(decideVaultChannelAction({ type: 'lock' }, waiting)).toEqual({ kind: 'lock' });
  });

  it('ignores anything it does not recognise, rather than throwing', () => {
    // The channel is reachable by any script on the origin, so a malformed
    // message is not evidence of anything — and a handler that threw would take
    // the listener down with it.
    for (const message of [
      null,
      undefined,
      42,
      'lock',
      {},
      { type: 'unknown' },
      { type: 'handoff-request' },
      { type: 'handoff-request', nonce: '' },
      // No account named at all: the shape a build that predates the check
      // sends, and one an attacker's script sends by omission.
      { type: 'handoff-request', nonce: 'n' },
      { type: 'unlocked' },
      { type: 'unlocked', userId: 'somebody-else' },
      { type: 'handoff-offer', nonce: 'nonce-1' },
      { type: 'handoff-offer', nonce: 'nonce-1', blob: '' },
    ]) {
      expect(decideVaultChannelAction(message, unlocked), JSON.stringify(message)).toEqual({
        kind: 'ignore',
      });
      expect(decideVaultChannelAction(message, waiting), JSON.stringify(message)).toEqual({
        kind: 'ignore',
      });
    }
  });
});

describe('a tab on the channel', () => {
  it('asks for a handoff when it opens holding nothing', () => {
    const port = fakePort();
    const channel = installVaultChannel({ userId: 'user-1', port });

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]?.type).toBe('handoff-request');
    channel.close();
  });

  it('does not ask when it has already restored its own mirror', () => {
    const port = fakePort();
    holdVaultKeys(material(5));

    const channel = installVaultChannel({ userId: 'user-1', port, request: false });

    expect(port.sent).toHaveLength(0);
    channel.close();
  });

  it('hands the keys over when another tab asks', () => {
    const port = fakePort();
    holdVaultKeys(material(5));
    const channel = installVaultChannel({ userId: 'user-1', port, request: false });

    port.deliver({ type: 'handoff-request', nonce: 'nonce-1', userId: 'user-1' });

    expect(port.sent).toEqual([
      { type: 'handoff-offer', nonce: 'nonce-1', blob: expect.any(String) },
    ]);
    channel.close();
  });

  it('does not hand the keys to a request naming a different account', () => {
    const port = fakePort();
    holdVaultKeys(material(5));
    const channel = installVaultChannel({ userId: 'user-1', port, request: false });

    port.deliver({ type: 'handoff-request', nonce: 'nonce-1', userId: 'somebody-else' });

    expect(port.sent).toHaveLength(0);
    channel.close();
  });

  it('adopts an answer to its own request', () => {
    const port = fakePort();
    const channel = installVaultChannel({ userId: 'user-1', port });
    const nonce = (port.sent[0] as { nonce: string }).nonce;

    port.deliver({ type: 'handoff-offer', nonce, blob: encodeMirror(material(9)) });

    expect(readVaultKeys()?.userKey[0]).toBe(9);
    channel.close();
  });

  it('refuses an answer sealed to a different account', () => {
    // Two people signed into the same browser in different tabs. The channel
    // cannot prevent the offer; this is what makes it harmless.
    const port = fakePort();
    const channel = installVaultChannel({ userId: 'user-1', port });
    const nonce = (port.sent[0] as { nonce: string }).nonce;

    port.deliver({
      type: 'handoff-offer',
      nonce,
      blob: encodeMirror(material(9, 'somebody-else')),
    });

    expect(readVaultKeys()).toBeNull();
    channel.close();
  });

  it('broadcasts every lock, whichever path reached the key store', () => {
    // The idle timer, the account menu, ⇧L, sign-out, the 401 path and a
    // passphrase change all end at `releaseVaultKeys`. Hanging the broadcast off
    // the store is what covers the one somebody forgets to wire up.
    const port = fakePort();
    holdVaultKeys(material(5));
    const channel = installVaultChannel({ userId: 'user-1', port, request: false });

    releaseVaultKeys();

    expect(port.sent).toEqual([{ type: 'lock' }]);
    channel.close();
  });

  it('announces an unlock, so a tab that heard silence can ask again', () => {
    const port = fakePort();
    const channel = installVaultChannel({ userId: 'user-1', port, request: false });

    holdVaultKeys(material(5));

    // No material travels with it, and nothing it says is a secret from a
    // script on this origin — which can read the key store directly.
    expect(port.sent).toEqual([{ type: 'unlocked', userId: 'user-1' }]);
    channel.close();
  });

  it('announces it once, not on every subsequent hold', () => {
    // Only the not-held → held edge. A passphrase change supersedes its own
    // keys through `holdVaultKeys`, and that is not news to anybody.
    const port = fakePort();
    const channel = installVaultChannel({ userId: 'user-1', port, request: false });

    holdVaultKeys(material(5));
    holdVaultKeys(material(7));

    expect(port.sent).toHaveLength(1);
    channel.close();
  });

  it('asks again when it hears that another tab has keys', () => {
    const port = fakePort();
    const channel = installVaultChannel({ userId: 'user-1', port });
    const first = (port.sent[0] as { nonce: string }).nonce;

    port.deliver({ type: 'unlocked', userId: 'user-1' });

    expect(port.sent).toHaveLength(2);
    expect(port.sent[1]?.type).toBe('handoff-request');
    // A fresh nonce, so a stale offer to the first request is refused by the
    // same check that refuses an offer meant for another tab.
    expect((port.sent[1] as { nonce: string }).nonce).not.toBe(first);
    channel.close();
  });

  it('still does not ask when it was told not to', () => {
    // The lock-screen provider. Its session is one the server has already
    // refused, so a handoff into it would put live keys behind a lock screen —
    // at install or at any point afterwards.
    const port = fakePort();
    const channel = installVaultChannel({ userId: 'user-1', port, request: false });

    port.deliver({ type: 'unlocked', userId: 'user-1' });

    expect(port.sent).toHaveLength(0);
    channel.close();
  });

  it('locks on hearing a lock, without answering with another one', () => {
    // Two tabs each rebroadcasting the other's lock would volley for as long as
    // both stayed open.
    const port = fakePort();
    holdVaultKeys(material(5));
    const channel = installVaultChannel({ userId: 'user-1', port, request: false });

    port.deliver({ type: 'lock' });

    expect(readVaultKeys()).toBeNull();
    expect(port.sent).toHaveLength(0);
    channel.close();
  });

  it('goes quiet once closed', () => {
    const port = fakePort();
    holdVaultKeys(material(5));
    const channel = installVaultChannel({ userId: 'user-1', port, request: false });

    channel.close();
    releaseVaultKeys();

    expect(port.sent).toHaveLength(0);
    expect(port.closed).toBe(true);
  });

  it('is a no-op where the browser has no BroadcastChannel', () => {
    // Nothing breaks and nothing is shared: each tab simply types its own
    // passphrase, which is what the product did before this file existed.
    const channel = installVaultChannel({ userId: 'user-1', port: null });
    expect(() => channel.close()).not.toThrow();
  });
});
