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
    { media: '(prefers-color-scheme: dark)', color: '#0b0e13' },
    { media: '(prefers-color-scheme: light)', color: '#f7f9fb' },
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
