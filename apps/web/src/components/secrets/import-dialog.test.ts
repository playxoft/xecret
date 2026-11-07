import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The dialog portals its content, and a server render has nowhere to portal
// to; rendering it in place is what lets the markup be asserted.
vi.mock('@/components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui')>();
  const { createElement: h } = await import('react');
  return {
    ...actual,
    DialogContent: ({ children }: { children?: unknown }) => h('div', null, children as never),
  };
});

const { Toaster } = await import('@/components/ui');
const { ImportDialog } = await import('./import-dialog');

/** The secrets import's file step: a drop zone, and a keyboard path through it. */

function render(): string {
  return renderToStaticMarkup(
    createElement(
      Toaster,
      null,
      createElement(ImportDialog, {
        orgSlug: 'acme',
        projectSlug: 'api',
        envSlug: 'staging',
        isProduction: false,
        io: null,
        open: true,
        onOpenChange: () => {},
        onImported: () => {},
      }),
    ),
  );
}

describe('the import dialog', () => {
  it('asks for the file with a drop zone and a button', () => {
    const html = render();
    expect(html).toContain('Drag a file here');
    expect(html).toMatch(/<button[^>]*>.*?Choose a file.*?<\/button>/);
  });

  it('keeps its hidden file input out of the tab order: the button is the keyboard path', () => {
    // `sr-only` clips the input's focus ring to nothing, so in the tab order
    // it would be a stop nobody can see.
    const inputs = render().match(/<input[^>]*type="file"[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('class="sr-only"');
    expect(inputs[0]).toContain('aria-label="Choose a file to import"');
    expect(inputs[0]).toContain('tabindex="-1"');
  });
});
