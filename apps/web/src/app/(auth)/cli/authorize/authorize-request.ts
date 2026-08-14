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

  if (!challenge || !CHALLENGE_PATTERN.test(challenge)) return null;
  if (!device || !DEVICE_PATTERN.test(device)) return null;
  if (!state || !STATE_PATTERN.test(state)) return null;

  // The listener binds an ephemeral port; anything below 1024 was not it.
  if (!port || !/^[0-9]{4,5}$/.test(port)) return null;
  const portNumber = Number(port);
  if (portNumber < 1024 || portNumber > 65535) return null;

  return { challenge, port: portNumber, device, state };
}
