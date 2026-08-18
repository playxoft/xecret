import type { Metadata } from 'next';

import { parseAuthorizeRequest } from './authorize-request';
import { AuthorizeScreen } from './authorize-screen';

export const metadata: Metadata = {
  title: 'Authorize CLI',
  description: 'Approve command-line access to xecret.',
};

/**
 * The consent screen `xecret login` opens.
 *
 * The CLI starts a loopback listener, generates a PKCE pair, and sends the
 * browser here with the challenge, the listener's port, a device name and an
 * opaque state value. Everything in the query string is attacker-suppliable,
 * which drives two decisions:
 *
 *  1. Every parameter is validated *on the server*, before the client
 *     component renders anything from it — see `authorize-request.ts`. The
 *     device name is the one free-text field, and it is bounded and stripped
 *     of control characters so this page cannot present arbitrary content
 *     under our origin.
 *  2. The redirect target is never taken from a parameter. It is always
 *     `http://127.0.0.1:{port}/callback`, constructed from a validated port
 *     number — this page cannot be used as an open redirector, because
 *     loopback is the only destination that exists.
 *
 * The residual risk is the one every loopback OAuth flow carries: a user can
 * be socially engineered into approving a login they did not start. The
 * screen says so, plainly, and approval requires an unlocked, signed-in
 * session with CSRF — there is nothing to click through silently.
 */
export default async function CliAuthorizePage({ searchParams }: PageProps<'/cli/authorize'>) {
  const request = parseAuthorizeRequest(await searchParams);
  return <AuthorizeScreen request={request} />;
}
