import Link from 'next/link';

import { PlayxoftMark, Wordmark } from './logo';

const REPO_URL = 'https://github.com/playxoft/xecret';

/** The footer on every public page. Paired with `SiteHeader`. */
export function SiteFooter({ gradientId }: { gradientId?: string | undefined }) {
  return (
    <footer className="border-line-subtle mt-auto border-t">
      <div className="mx-auto flex w-full max-w-[88rem] flex-col gap-4 px-5 py-8 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Wordmark gradientId={gradientId} />
          <PlayxoftMark />
        </div>
        <nav
          aria-label="Footer"
          className="text-fg-muted flex flex-wrap items-center gap-x-5 gap-y-2 text-sm"
        >
          <Link href="/docs" className="hover:text-fg rounded-sm">
            Docs
          </Link>
          <Link href="/docs/cli/commands" className="hover:text-fg rounded-sm">
            CLI reference
          </Link>
          <Link href="/docs/self-hosting" className="hover:text-fg rounded-sm">
            Self-hosting
          </Link>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="hover:text-fg rounded-sm"
          >
            GitHub
          </a>
          <Link href="/sign-in" className="hover:text-fg rounded-sm">
            Sign in
          </Link>
          <span className="text-fg-subtle text-sm">AGPL-3.0</span>
        </nav>
      </div>
    </footer>
  );
}
