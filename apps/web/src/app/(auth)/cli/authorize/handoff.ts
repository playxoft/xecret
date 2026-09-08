'use client';

import { cliHandoffAad, decodePublicKey, sealToPublicKey } from '@xecret/core/crypto/client';
import type { Bytes } from '@xecret/core/crypto/client';

/**
 * Handing the User Key to `xecret login`, over the loopback redirect.
 *
 * ── The problem ──
 * A CLI token acts as its user, and that user's environment grants are sealed to
 * their X25519 public key — whose private half exists only as a wrap under the
 * User Key. So a CLI process that finishes `xecret login` holding nothing but a
 * bearer token can authenticate perfectly and decrypt nothing. The User Key has
 * to cross from this browser, which has just unlocked it, to a process that
 * cannot.
 *
 * ── Why it can cross safely ──
 * It crosses as a sealed box (spec §5) to an ephemeral X25519 key the CLI
 * generated for this login and put in the authorize URL, and it rides the same
 * `http://127.0.0.1:<port>/callback` redirect that already carries the
 * authorization code. **The server is not on that path.** It produced neither
 * half, sees neither half, and `/api/cli/authorize` carries no key material of
 * any kind — §8's prohibition is unchanged.
 *
 * The AAD binds the PKCE code challenge and the recipient key, so a wrap
 * captured from one login cannot be replayed into another, and a page cannot
 * substitute a wrap sealed to a key of its own choosing without knowing a
 * challenge it never saw.
 *
 * ── Why a query parameter and not a fragment ──
 * Fragments are not transmitted. That is exactly why browsers use them, and
 * exactly why one is useless here: the CLI's callback listener is an HTTP
 * server, and a fragment would never reach it. The request never leaves the
 * machine, and its payload is a sealed box that is worthless to anything but the
 * process holding the private key — which is the process listening on that port.
 */
export async function sealHandoff(params: {
  /** The 32-byte User Key. Sealed, never copied anywhere else. */
  userKey: Bytes;
  /** The PKCE challenge from the authorize URL, base64url. */
  codeChallenge: string;
  /** The CLI's ephemeral X25519 public key, base64url. */
  handoffPublicKey: string;
}): Promise<string> {
  return sealToPublicKey({
    // Decoded rather than trusted: the query parameter has already been shape-
    // checked by `parseAuthorizeRequest`, and this is what turns 43 characters
    // into the 32 bytes the seal requires or refuses.
    recipientPublicKey: decodePublicKey(params.handoffPublicKey),
    plaintext: params.userKey,
    aad: cliHandoffAad({
      codeChallenge: params.codeChallenge,
      handoffPublicKey: params.handoffPublicKey,
    }),
  });
}
