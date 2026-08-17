'use client';

import { useCallback, useRef } from 'react';

/**
 * The rendered article, plus the one behaviour its HTML cannot supply itself.
 *
 * Every code block carries a copy button rendered as plain markup by
 * `markdown.ts`. Rather than hydrate one React component per block — a page
 * with twenty samples would ship twenty islands — a single click handler on the
 * wrapper catches them all by delegation and reads the code straight out of the
 * DOM. The text is therefore never duplicated into a `data-` attribute, which
 * on this site would mean shipping every command twice.
 *
 * `dangerouslySetInnerHTML` is safe here in the way the API name asks you to
 * justify: the HTML is produced at build time from repository files by our own
 * renderer, which escapes every fragment of document text. No request data
 * reaches it.
 */
export function DocBody({ html }: { html: string }) {
  const container = useRef<HTMLDivElement>(null);

  const onClick = useCallback(async (event: React.MouseEvent<HTMLDivElement>) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-copy]');
    if (!button) return;

    const element = button.closest('figure')?.querySelector('code');
    const code = element?.textContent;
    if (!element || !code) return;

    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard access can be refused: an insecure origin, a permissions
      // policy, a browser that simply says no. Claiming success would be a lie,
      // and doing nothing leaves somebody clicking a button that appears
      // broken — so select the code instead and let them press the shortcut
      // they already know.
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return;
    }

    button.dataset.copied = 'true';
    window.setTimeout(() => delete button.dataset.copied, 1600);
  }, []);

  return (
    <div
      ref={container}
      onClick={onClick}
      className="doc-prose"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
