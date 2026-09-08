import type { AuthorizeRequest } from './authorize-screen';

/**
 * Validation of the consent screen's query parameters.
 *
 * Everything here is **attacker-suppliable** — anyone can construct the URL
 * and send it to a victim — so nothing is rendered or acted on until it has
 * passed these checks. Separated from `page.tsx` so it can be unit-tested;
 * a page file may only export what Next.js expects of it.
 */

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STATE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const DEVICE_PATTERN = /^\P{C}{1,100}$/u;

/** A 32-byte X25519 public key, base64url. Same shape as the challenge. */
const HANDOFF_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function firstValue(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  return null;
}

export function parseAuthorizeRequest(
  params: Record<string, string | string[] | undefined>,
): AuthorizeRequest | null {
  const challenge = firstValue(params.challenge);
  const port = firstValue(params.port);
  const device = firstValue(params.device);
  const state = firstValue(params.state);
  /*
   * `undefined` and "repeated" must not collapse.
   *
   * Every other parameter here is required, so `firstValue` returning null for
   * both an absent value and an array is the same refusal either way. This one
   * is optional, and treating a repeated `handoff` as absent would silently
   * downgrade the login to the no-hand-off flow — an ambiguity in the value that
   * decides where a User Key gets sealed, answered by guessing. Refused whole,
   * for the same reason a repeated `port` is.
   */
  if (Array.isArray(params.handoff)) return null;
  const handoff = firstValue(params.handoff);

  if (!challenge || !CHALLENGE_PATTERN.test(challenge)) return null;
  if (!device || !DEVICE_PATTERN.test(device)) return null;
  if (!state || !STATE_PATTERN.test(state)) return null;

  // The listener binds an ephemeral port; anything below 1024 was not it.
  if (!port || !/^[0-9]{4,5}$/.test(port)) return null;
  const portNumber = Number(port);
  if (portNumber < 1024 || portNumber > 65535) return null;

  /*
   * The hand-off key is optional, and its absence is not an error.
   *
   * A CLI that asks for one gets its User Key sealed to it on the loopback
   * redirect (spec §13.2), which is what lets a headless process open member
   * grants. A CLI that does not — an older binary, or one that only ever reads
   * `server`-mode environments — gets exactly the flow it always had. Refusing
   * the request instead would break every already-installed version the day this
   * ships, for a capability those versions cannot use.
   *
   * A *malformed* one is refused, because it is a request this page cannot
   * satisfy: sealing to 20 bytes of key produces something the CLI will fail to
   * open, after the code has been minted and the tab has closed.
   */
  if (handoff !== null && !HANDOFF_PATTERN.test(handoff)) return null;

  return { challenge, port: portNumber, device, state, handoff };
}
