import type { Metadata } from 'next';

import { ResetPinForm } from './reset-pin-form';

export const metadata: Metadata = {
  title: 'Choose a new PIN',
  description: 'Set a new unlock PIN for your xecret account.',
  // The URL carries a single-use token. Keeping it out of search indexes costs
  // nothing and stops a link leaked into a referrer header being crawled.
  robots: { index: false, follow: false },
};

/**
 * The target of the emailed reset link: `/reset-pin?token=…`.
 *
 * Unlike the password reset beside it, this one needs a **session as well as the
 * token**. That is not an oversight to be smoothed over — it is the design. The
 * token proves control of the mailbox; the cookie proves which account. Either
 * alone is insufficient, so a forwarded link is useless to whoever receives it,
 * and a stolen cookie cannot reset the PIN without the mailbox.
 *
 * The practical consequence, handled by the form: somebody who opens the link in
 * a browser where they are not signed in is asked to sign in first, and the
 * token survives the round trip in the URL.
 */
export default async function ResetPinPage({ searchParams }: PageProps<'/reset-pin'>) {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : null;

  return <ResetPinForm token={token} />;
}
