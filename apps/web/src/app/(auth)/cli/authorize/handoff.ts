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
 * ── What the AAD binds, precisely ──
 * Two things, and it is worth being exact because this comment used to imply a
 * third. It binds the **PKCE code challenge**, so a wrap captured from one login
 * cannot be replayed into another; and it binds the **recipient public key**, so
 * the sealed box cannot be re-labelled as addressed to a different key than the
 * one it was actually sealed to.
 *
 * ── What it does not bind ──
 * *Which process* holds that key. It could not: both values exist before anybody
 * has authenticated, and there is nothing about a locally-generated X25519 key
 * that identifies its owner. So an unprivileged process running as the same user
 * can start its own authorization flow, put its own hand-off public key in the
 * URL, and open a browser at it — and somebody who approves that consent screen
 * because they had just typed `xecret login` seals their User Key to the impostor
 * and posts it to the impostor's loopback port. The cryptography is intact; the
 * consent is what was taken. The screen therefore shows the fingerprint of the
 * key it is about to seal to, and the CLI prints the fingerprint of its own key
 * before opening the browser, so the two can be compared by eye. ADR 0009 records
 * this as a residual risk rather than a solved problem.
 *
 * ── Why a query parameter and not a fragment ──
 * Fragments are not transmitted. That is exactly why browsers use them, and
 * exactly why one is useless here: the CLI's callback listener is an HTTP
 * server, and a fragment would never reach it. The request never leaves the
 * machine, and its payload is a sealed box that is worthless to anything but the
 * process holding the private key — which is the process listening on that port.
 *
 * The consequence, stated rather than glossed: the sealed blob rides a redirect,
 * so a copy of it lands in the browser's history and in anything that syncs it.
 * It is ciphertext to an ephemeral key that is wiped when the login ends and was
 * never written down — but "the User Key never touches disk" is a claim people
 * make about this flow, and this is the footnote on it.
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
