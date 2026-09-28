import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LevelToggle } from './level-toggle';

/**
 * The level capsule, rendered to static markup. What matters about a segment
 * above what the viewer can grant is that it stays reachable and says why —
 * `aria-disabled`, not `disabled`, which would drop it from the tab order and
 * its explanation with it — and that the lit segment, whose click clears the
 * level, is never taken away.
 */

function render(level: 'none' | 'read' | 'write' | 'admin', maxLevel?: 'none' | 'read') {
  return renderToStaticMarkup(
    createElement(LevelToggle, {
      level,
      maxLevel,
      disabled: false,
      scopeLabel: 'API Production',
      onSelect: () => {},
    }),
  );
}

/** The opening tag of the segment whose label starts with `label`. */
function segment(html: string, label: string): string {
  const match = new RegExp(`<button[^>]*aria-label="${label}[^"]*"[^>]*>`).exec(html);
  if (match === null) throw new Error(`no segment labelled ${label} in ${html}`);
  return match[0];
}

describe('LevelToggle with maxLevel', () => {
  it('marks segments above it unavailable, focusable, and says why', () => {
    const html = render('none', 'read');
    const write = segment(html, 'Read &amp; write access to API Production');
    const admin = segment(html, 'Admin access to API Production');

    for (const button of [write, admin]) {
      expect(button).toContain('aria-disabled="true"');
      expect(button).not.toMatch(/\sdisabled=""/);
      expect(button).toContain('more than you can grant here');
      expect(button).toContain('title="More than you can grant here"');
    }
    expect(segment(html, 'Read access to API Production')).not.toContain('aria-disabled');
  });

  it('keeps the lit segment clickable, since clearing takes access away', () => {
    // An owner-written `admin` the viewer could only grant `read` of: they may
    // still take it away.
    const html = render('admin', 'read');
    const admin = segment(html, 'Admin access to API Production');

    expect(admin).not.toContain('aria-disabled');
    expect(admin).not.toMatch(/\sdisabled=""/);
    expect(admin).toContain('aria-pressed="true"');
  });

  it('offers every segment when what the viewer can grant is not known', () => {
    const html = render('none');

    expect(html).not.toContain('aria-disabled');
    expect(html).not.toContain('more than you can grant');
  });
});
