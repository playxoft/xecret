import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';

// Imported from their own modules rather than the barrels: a barrel makes
// the root layout depend on every component in it, which is how the Firebase
// SDK ends up in the bundle for a static marketing page.
import { ThemeProvider } from '@/components/layout/theme-provider';
import { Toaster } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEFAULT_RESOLVED_THEME, THEME_BOOTSTRAP_SCRIPT } from '@/lib/theme';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: {
    default: 'xecret — secret management for developers',
    template: '%s · xecret',
  },
  description:
    'Open-source, developer-first secret management. Encrypted per environment, audited on every read, and wired into your app with one command.',
  applicationName: 'xecret',
  // The public pages are indexable. Pages that must not be — anything reached
  // through a single-use link, such as password reset — override this in their
  // own `metadata`, and every dashboard route sits behind a session so a
  // crawler collects nothing but redirects.
  robots: { index: true, follow: true },
  // ── Keep "force dark mode" extensions off this page ──
  //
  // Dark Reader and its imitators repaint a site by inverting or rotating its
  // computed colours. That is a kindness to a page with only a light theme; it
  // is a regression here. Every token in `globals.css` is hand-tuned and
  // annotated with a measured contrast ratio, and an extension recomputing them
  // hits the two things this product cannot afford to have shuffled: the
  // production orange and the danger red, whose whole job is to be instantly
  // and unambiguously distinguishable from everything else on screen. A user
  // who mistakes production for staging because an extension mapped them to
  // neighbouring browns has been failed by us, not by the extension.
  //
  // Dark Reader's documented opt-out is the presence of this tag — it tests for
  // `meta[name="darkreader-lock"]` and stands down, leaving our own dark theme
  // (which the toggle in the account menu already offers) to do the job.
  //
  // The value is `'true'` and not `''` on purpose: Next drops any `other` entry
  // whose content is an empty string, so a lock written the way the tag is
  // usually shown — bare, with no content — would silently never render.
  // Nothing reads the value; only the tag's presence is checked.
  other: { 'darkreader-lock': 'true' },
  openGraph: {
    type: 'website',
    siteName: 'xecret',
    title: 'xecret — secret management for developers',
    description: 'Open-source, developer-first secret management. Powered by Playxoft.',
  },
};

export const viewport: Viewport = {
  // Matches --canvas in each theme, so the browser chrome on mobile does not
  // sit as a bright band above a dark page.
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
  ],
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      // Dark is the server-rendered default; the bootstrap script below
      // rewrites this before first paint from the stored preference. React
      // then hydrates against a value it did not render, which is exactly what
      // `suppressHydrationWarning` is for.
      data-theme={DEFAULT_RESOLVED_THEME}
      data-sidebar="expanded"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/* Must be inline and render-blocking — see THEME_BOOTSTRAP_SCRIPT for
            why. Its content is a module constant, not user input. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          <TooltipProvider>
            <Toaster>{children}</Toaster>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
