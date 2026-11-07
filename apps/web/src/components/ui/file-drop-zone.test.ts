import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { carriesFiles, FileDropZone, guardFileDrag, nextDragDepth } from './file-drop-zone';
import type { GuardedDragEvent } from './file-drop-zone';

/**
 * The drop zone both imports draw, and the guard their dialogs mount. Their
 * handlers need a DOM to fire, so the rules they stand on are pinned here as
 * the pure functions they call.
 */

describe('carriesFiles', () => {
  it('is true only for a drag that carries files', () => {
    expect(carriesFiles(['Files'])).toBe(true);
    expect(carriesFiles(['text/uri-list', 'Files'])).toBe(true);
    // Text or a link is no offer of a file.
    expect(carriesFiles(['text/plain'])).toBe(false);
    expect(carriesFiles(['text/uri-list', 'text/html'])).toBe(false);
    expect(carriesFiles([])).toBe(false);
    expect(carriesFiles(null)).toBe(false);
    expect(carriesFiles(undefined)).toBe(false);
  });
});

describe('nextDragDepth', () => {
  it('stays inside the zone while a drag crosses its own children', () => {
    // The browser fires `dragenter` on the new element before `dragleave` on
    // the old one, so crossing onto a child is enter-then-leave.
    let depth = 0;
    depth = nextDragDepth(depth, 'dragenter'); // onto the zone
    depth = nextDragDepth(depth, 'dragenter'); // onto its button…
    depth = nextDragDepth(depth, 'dragleave'); // …off the zone itself
    expect(depth).toBe(1);
    depth = nextDragDepth(depth, 'dragenter'); // back onto the zone…
    depth = nextDragDepth(depth, 'dragleave'); // …off the button
    expect(depth).toBe(1);
    depth = nextDragDepth(depth, 'dragleave'); // out of the zone
    expect(depth).toBe(0);
  });

  it('never goes below zero, and a drop ends the drag wherever it was', () => {
    expect(nextDragDepth(0, 'dragleave')).toBe(0);
    expect(nextDragDepth(3, 'drop')).toBe(0);
  });
});

describe('guardFileDrag', () => {
  function dragEvent(
    type: 'dragover' | 'drop',
    types: readonly string[],
    defaultPrevented = false,
  ): GuardedDragEvent & { dataTransfer: { dropEffect: string } } {
    const event = {
      type,
      defaultPrevented,
      dataTransfer: { types, dropEffect: 'copy' },
      preventDefault() {
        event.defaultPrevented = true;
      },
    };
    return event as never;
  }

  it('cancels a file dragged or dropped anywhere nothing nearer took it, so the tab is not replaced', () => {
    const over = dragEvent('dragover', ['Files']);
    guardFileDrag(over);
    expect(over.defaultPrevented).toBe(true);
    // …and says so with the cursor: nothing can be dropped there.
    expect(over.dataTransfer.dropEffect).toBe('none');

    const drop = dragEvent('drop', ['Files']);
    guardFileDrag(drop);
    expect(drop.defaultPrevented).toBe(true);
  });

  it('leaves text and links alone, so they still land in a field', () => {
    for (const types of [['text/plain'], ['text/uri-list', 'text/html']]) {
      const over = dragEvent('dragover', types);
      guardFileDrag(over);
      expect(over.defaultPrevented).toBe(false);
      expect(over.dataTransfer.dropEffect).toBe('copy');
    }
  });

  it('leaves a drag the drop zone already took as the zone left it', () => {
    const over = dragEvent('dragover', ['Files'], true);
    guardFileDrag(over);
    expect(over.dataTransfer.dropEffect).toBe('copy');
  });
});

describe('FileDropZone', () => {
  it('draws its children in the untinted panel until a file is dragged over it', () => {
    const html = renderToStaticMarkup(
      createElement(FileDropZone, { onFiles: () => {} }, createElement('p', null, 'Drop here')),
    );
    expect(html).toContain('<p>Drop here</p>');
    expect(html).toContain('border-dashed');
    expect(html).toContain('border-line bg-canvas-inset');
    expect(html).not.toContain('bg-accent-tint');
  });
});
