import Link from 'next/link';

import { PlayxoftMark, Wordmark } from '@/components/layout/logo';

/**
 * The frame every authentication screen shares.
 *
 * A Server Component: nothing here needs the browser, and keeping the frame on
 * the server means only the form itself ships as client JavaScript.
 */
export default function AuthLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="relative flex min-h-dvh flex-col">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="bg-accent/12 absolute top-[-14rem] left-1/2 size-[38rem] -translate-x-1/2 rounded-full blur-[140px]" />
        <div className="absolute inset-0 [background-image:linear-gradient(to_right,var(--line-subtle)_1px,transparent_1px),linear-gradient(to_bottom,var(--line-subtle)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_at_top,black,transparent_65%)] [background-size:56px_56px]" />
      </div>

      <header className="relative px-6 py-6">
        <Link href="/" className="inline-flex rounded-md" aria-label="xecret home">
          <Wordmark />
        </Link>
      </header>

      <main className="relative flex flex-1 items-start justify-center px-4 pb-10 sm:items-center">
        <div className="w-full max-w-[25.5rem]">{children}</div>
      </main>

      <footer className="relative flex justify-center px-4 pb-8">
        <PlayxoftMark />
      </footer>
    </div>
  );
}
