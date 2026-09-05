import { describe, expect, it } from 'vitest';

import { interceptedHref, isPlainLeftClick } from './leave-guard';
import type { AnchorFacts, ClickFlags } from './leave-guard';

/**
 * The two rules `UnsavedChangesGuard` stands on.
 *
 * They are worth pinning precisely because both failure directions are silent.
 * A false negative loses whatever was staged — in this product, plaintext
 * credentials somebody may have pasted from somewhere they cannot get again. A
 * false positive breaks ordinary navigation with a dialog about work that does
 * not exist.
 */

const PLAIN: ClickFlags = {
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};

const HERE = 'https://xecret.app/acme/api-gateway/production';

function anchor(patch: Partial<AnchorFacts> = {}): AnchorFacts {
  return { href: 'https://xecret.app/acme/projects', hasDownload: false, target: '', ...patch };
}

describe('isPlainLeftClick', () => {
  it('claims an unmodified left click', () => {
    expect(isPlainLeftClick(PLAIN)).toBe(true);
  });

  it('leaves a click someone nearer has already decided', () => {
    expect(isPlainLeftClick({ ...PLAIN, defaultPrevented: true })).toBe(false);
  });

  it('leaves middle and right clicks alone', () => {
    expect(isPlainLeftClick({ ...PLAIN, button: 1 })).toBe(false);
    expect(isPlainLeftClick({ ...PLAIN, button: 2 })).toBe(false);
  });

  it.each(['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const)(
    'leaves %s-click alone, which opens elsewhere and leaves this page standing',
    (modifier) => {
      expect(isPlainLeftClick({ ...PLAIN, [modifier]: true })).toBe(false);
    },
  );
});

describe('interceptedHref', () => {
  it('takes a link to another page in this app', () => {
    expect(interceptedHref(anchor(), HERE)).toBe('/acme/projects');
  });

  it('keeps the query and the hash of the destination', () => {
    expect(
      interceptedHref(anchor({ href: 'https://xecret.app/acme/audit?actor=me#row-3' }), HERE),
    ).toBe('/acme/audit?actor=me#row-3');
  });

  it('resolves a relative href against the current page', () => {
    expect(interceptedHref(anchor({ href: '/acme/settings' }), HERE)).toBe('/acme/settings');
  });

  it('lets a download through: a file is not a navigation', () => {
    expect(interceptedHref(anchor({ hasDownload: true }), HERE)).toBeNull();
  });

  it('lets a link that opens in another frame through', () => {
    expect(interceptedHref(anchor({ target: '_blank' }), HERE)).toBeNull();
  });

  it('still claims an explicit _self, which navigates this frame', () => {
    expect(interceptedHref(anchor({ target: '_self' }), HERE)).toBe('/acme/projects');
  });

  it('lets another origin through — that is `beforeunload`\u2019s business', () => {
    // Intercepting it would replace the browser's own guarantee with a dialog
    // the user could not act on.
    expect(interceptedHref(anchor({ href: 'https://example.com/docs' }), HERE)).toBeNull();
  });

  it('lets a hash jump within this screen through', () => {
    expect(interceptedHref(anchor({ href: `${HERE}#secrets` }), HERE)).toBeNull();
  });

  it('lets a link to the page it is already on through', () => {
    expect(interceptedHref(anchor({ href: HERE }), HERE)).toBeNull();
  });

  it('claims a link that changes only the query', () => {
    // A different query is a different view of the environment, and the staged
    // work does not survive it.
    expect(interceptedHref(anchor({ href: `${HERE}?compare=staging` }), HERE)).toBe(
      '/acme/api-gateway/production?compare=staging',
    );
  });

  it('lets an unparseable href through rather than guessing', () => {
    expect(interceptedHref(anchor({ href: 'http://[' }), HERE)).toBeNull();
  });
});
