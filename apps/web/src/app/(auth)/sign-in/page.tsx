import type { Metadata } from 'next';

import { POST_SIGN_IN_PATH, safeRedirectPath } from '@/lib/api';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to xecret.',
};

/**
 * `?next=` is read here, on the server, and validated before it reaches the
 * client. Reading it in the form with `useSearchParams` would force the whole
 * subtree out of prerendering into a Suspense boundary for no gain.
 */
export default async function SignInPage({ searchParams }: PageProps<'/sign-in'>) {
  const params = await searchParams;
  const next = typeof params.next === 'string' ? params.next : null;

  return <SignInForm next={safeRedirectPath(next, POST_SIGN_IN_PATH)} />;
}
