'use client';

import { uuidv7 } from '@xecret/core/ids';
import { holdVaultKeys, readVaultKeys, releaseVaultKeys, subscribeVaultKeys } from './key-store';
import { decodeMirror, encodeMirror } from './session-mirror';

/**
 * One account's tabs, agreeing about whether the vault is open.
 *
 * ── The two problems this solves, which are the same problem ──
 * **Opening a second tab.** `sessionStorage` is deliberately per-tab, so a new
 * tab starts with no key material even though the one beside it has some. Asking
 * for the master passphrase again, in the same browser, in the same minute, to
 * reach the same vault, is friction with no security behind it — anything that
 * could read the new tab could already read the old one. So a new tab asks, and
 * any unlocked tab answers.
 *
 * **Locking.** A lock that only locked the tab it was pressed in would be a lie
 * on the screen that promises it: the idle timer fires in one tab while three
 * others sit there holding a User Key. So every lock is broadcast, and every tab
 * zeroizes and clears its mirror when it hears one.
 *
 * ── Where the keys go, and where they do not ──
 * The handoff travels as a `structuredClone`d message between two same-origin
 * documents in one browser. It does not touch the network, `localStorage`,
 * IndexedDB, or a server; the receiving tab's only durable record of it is the
 * `sessionStorage` mirror, which dies with that tab. A `BroadcastChannel` is not
 * a point-to-point pipe — every tab on the origin sees the offer — which is why
 * the offer is scoped by the requester's nonce and why the receiving side still
 * refuses a blob belonging to a different account.
 *
 * ── Why the decision is pure and the wiring is not ──
 * {@link decideVaultChannelAction} takes a message and a snapshot and answers
 * what to do. It touches no DOM, no channel and no key store, so every rule
 * below — an unlocked tab answers a request, a tab adopts only the offer it
 * asked for, a lock is honoured even by a tab holding nothing — is a test that
 * runs in milliseconds without a browser. Everything under it is plumbing.
 */

/**
 * The channel name, carrying its protocol version.
 *
 * In the name rather than in the messages: a future protocol is a *different
 * channel*, so a tab running an older build never receives a shape it will
 * mis-parse, and neither one has to carry compatibility code for the other.
 */
export const VAULT_CHANNEL_NAME = 'xecret.vault.v1';

export type VaultChannelMessage =
  /** "I have just opened and hold nothing. Does anybody have the keys?" */
  | { type: 'handoff-request'; nonce: string }
  /** "I do. Here they are." — addressed by echoing the requester's nonce. */
  | { type: 'handoff-offer'; nonce: string; blob: string }
  /** "The vault is locked." Sent by whichever tab locked it, heard by all. */
  | { type: 'lock' };

export type VaultChannelAction =
  | { kind: 'ignore' }
  | { kind: 'offer'; nonce: string }
  | { kind: 'adopt'; blob: string }
  | { kind: 'lock' };

/** What the deciding tab knows about itself when a message arrives. */
export interface VaultChannelState {
  /** Whether this tab currently holds key material. */
  held: boolean;
  /** The nonce of the request this tab is waiting on, or `null`. */
  pendingNonce: string | null;
}

/**
 * What a tab should do about a message it just heard.
 *
 * ── The three rules, and what each refuses ──
 * A **request** is answered only by a tab that actually holds keys; a locked tab
 * answering would send an empty offer that the requester would have to
 * distinguish from silence.
 *
 * An **offer** is adopted only when this tab asked for it, by nonce, and only
 * while it still holds nothing. Without the nonce a tab would adopt an offer
 * meant for a different tab — harmless today, since both would be the same
 * account, but it is the kind of "harmless" that stops being true the moment a
 * fourth message type is added. Without the `held` check a tab that unlocked by
 * passphrase in the second between asking and being answered would replace its
 * own fresh keys with an older copy.
 *
 * A **lock** is honoured unconditionally, including by a tab holding nothing.
 * That is not redundant: a tab that has been reloaded and not yet restored holds
 * no keys and still has a mirror in `sessionStorage`, and a lock that skipped it
 * would leave that blob for the next reload to adopt.
 *
 * Anything unrecognised is ignored rather than logged or thrown. The channel is
 * reachable by any script on the origin, so a malformed message is not evidence
 * of anything, and a handler that threw would take the listener down with it.
 */
export function decideVaultChannelAction(
  message: unknown,
  state: VaultChannelState,
): VaultChannelAction {
  if (typeof message !== 'object' || message === null) return { kind: 'ignore' };
  const candidate = message as Partial<VaultChannelMessage>;

  switch (candidate.type) {
    case 'handoff-request':
      if (!state.held) return { kind: 'ignore' };
      if (typeof candidate.nonce !== 'string' || candidate.nonce.length === 0) {
        return { kind: 'ignore' };
      }
      return { kind: 'offer', nonce: candidate.nonce };

    case 'handoff-offer':
      if (state.held || state.pendingNonce === null) return { kind: 'ignore' };
      if (candidate.nonce !== state.pendingNonce) return { kind: 'ignore' };
      if (typeof candidate.blob !== 'string' || candidate.blob.length === 0) {
        return { kind: 'ignore' };
      }
      return { kind: 'adopt', blob: candidate.blob };

    case 'lock':
      return { kind: 'lock' };

    default:
      return { kind: 'ignore' };
  }
}

/**
 * The transport, reduced to what this module needs.
 *
 * A seam rather than a direct `new BroadcastChannel(…)`, because the tests run
 * without a DOM and because a browser that does not implement it — or a document
 * where it throws — must degrade to "every tab types its own passphrase" rather
 * than to a broken provider.
 */
export interface VaultChannelPort {
  post(message: VaultChannelMessage): void;
  listen(handler: (message: unknown) => void): void;
  close(): void;
}

/** This browser's `BroadcastChannel`, or `null` where there is not one. */
export function browserVaultChannel(): VaultChannelPort | null {
  try {
    if (typeof BroadcastChannel === 'undefined') return null;

    const channel = new BroadcastChannel(VAULT_CHANNEL_NAME);
    return {
      post: (message) => {
        channel.postMessage(message);
      },
      listen: (handler) => {
        channel.onmessage = (event: MessageEvent) => {
          handler(event.data);
        };
      },
      close: () => {
        channel.close();
      },
    };
  } catch {
    return null;
  }
}

export interface VaultChannelHandle {
  /** Stops listening and releases the channel. Idempotent. */
  close(): void;
}

export interface InstallVaultChannelOptions {
  /** Whose keys this tab may ask for and may adopt. */
  userId: string;
  /** The transport. Defaults to this browser's `BroadcastChannel`. */
  port?: VaultChannelPort | null;
  /**
   * Whether to ask other tabs for a handoff on install.
   *
   * `false` for a tab that has already restored from its own mirror — it has the
   * keys, and asking would put an unnecessary copy of them on the channel.
   */
  request?: boolean;
}

/**
 * Wires this tab into the channel: ask, answer, and broadcast locks.
 *
 * ── Why the lock broadcast hangs off the key store rather than off `lockVault` ──
 * Because there is no single lock call site. The idle timer, the account menu,
 * the ⇧L shortcut, sign-out, the 401 path, a passphrase change superseding its
 * own keys and the server-said-locked reconciliation all end at
 * `releaseVaultKeys`. Broadcasting from a subscription means every one of them
 * is covered and a seventh added next year is covered too, which is not true of
 * a `channel.post` added to whichever of them somebody remembers.
 *
 * The guard around that is the only piece of state here: a tab that locks
 * *because* it heard a lock must not answer with another one, or two tabs would
 * volley a message back and forth for as long as both are open.
 */
export function installVaultChannel(options: InstallVaultChannelOptions): VaultChannelHandle {
  const port = options.port === undefined ? browserVaultChannel() : options.port;
  if (port === null) return { close: () => undefined };

  let closed = false;
  let applyingRemoteLock = false;
  let pendingNonce: string | null = null;
  let wasHeld = readVaultKeys() !== null;

  const unsubscribe = subscribeVaultKeys(() => {
    // Only the held → not-held edge is a lock. The other edge is an unlock, and
    // announcing that would be announcing that this tab is holding a User Key.
    const nowHeld = readVaultKeys() !== null;
    if (nowHeld) {
      wasHeld = true;
      return;
    }
    const locked = wasHeld;
    wasHeld = false;

    if (!locked || applyingRemoteLock || closed) return;
    port.post({ type: 'lock' });
  });

  port.listen((message) => {
    if (closed) return;

    const action = decideVaultChannelAction(message, {
      held: readVaultKeys() !== null,
      pendingNonce,
    });

    switch (action.kind) {
      case 'offer': {
        const keys = readVaultKeys();
        // Re-read rather than trusting the snapshot: a lock may have landed
        // between the decision and here, and an offer built from keys this tab
        // has just given up is an offer to unlock a vault its own user locked.
        if (keys !== null)
          port.post({ type: 'handoff-offer', nonce: action.nonce, blob: encodeMirror(keys) });
        return;
      }

      case 'adopt': {
        const keys = decodeMirror(action.blob, options.userId);
        // `null` when the offer belongs to a different account — two people
        // signed into the same browser in different tabs, which the channel
        // cannot prevent and this check makes harmless.
        if (keys === null) return;
        pendingNonce = null;
        holdVaultKeys(keys);
        return;
      }

      case 'lock': {
        applyingRemoteLock = true;
        try {
          releaseVaultKeys();
        } finally {
          applyingRemoteLock = false;
        }
        return;
      }

      case 'ignore':
        return;
    }
  });

  if (options.request !== false && readVaultKeys() === null) {
    pendingNonce = uuidv7();
    port.post({ type: 'handoff-request', nonce: pendingNonce });
  }

  return {
    close: () => {
      if (closed) return;
      closed = true;
      pendingNonce = null;
      unsubscribe();
      port.close();
    },
  };
}
