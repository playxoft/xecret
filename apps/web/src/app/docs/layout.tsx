import { SiteFooter } from '@/components/layout/site-footer';
import { SiteHeader } from '@/components/layout/site-header';
import { DocsSidebar } from './_components/docs-sidebar';
import { loadNav } from './_lib/content';
import './docs.css';

/**
 * The frame every documentation page renders inside.
 *
 * Reads the navigation once and hands it to the sidebar as plain data, so the
 * only JavaScript the reader downloads for the index is the filter box and the
 * mobile drawer — not the twenty-odd documents themselves.
 */
export default async function DocsLayout({ children }: LayoutProps<'/docs'>) {
  const sections = await loadNav();

  return (
    <div className="bg-canvas flex min-h-dvh flex-col">
      <a
        href="#doc-content"
        className="bg-surface text-fg border-line sr-only z-50 rounded-md border px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:top-3 focus:left-3"
      >
        Skip to content
      </a>

      <SiteHeader current="docs" wide />

      <div className="mx-auto flex w-full max-w-[88rem] flex-1 flex-col lg:flex-row lg:items-start lg:px-5">
        <DocsSidebar
          sections={sections.map((section) => ({
            title: section.title,
            items: section.items.map((item) => ({
              href: item.href,
              navTitle: item.navTitle,
              description: item.description,
              keywords: item.keywords,
            })),
          }))}
        />
        <div className="min-w-0 flex-1">{children}</div>
      </div>

      <SiteFooter gradientId="xecret-mark-gradient-docs-footer" />
    </div>
  );
}
