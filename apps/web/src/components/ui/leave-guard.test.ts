import { describe, expect, it } from 'vitest';

import {
  armLeaveGuard,
  askBeforeLeaving,
  interceptedHref,
  isLeaveGuardArmed,
  isPlainLeftClick,
} from './leave-guard';
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

describe('the armed slot', () => {
  it('is unarmed until a guard claims it, and again once it lets go', () => {
    expect(isLeaveGuardArmed()).toBe(false);

    const disarm = armLeaveGuard(() => {});
    expect(isLeaveGuardArmed()).toBe(true);

    disarm();
    expect(isLeaveGuardArmed()).toBe(false);
  });

  it('stays armed when a guard that has already been replaced disarms', () => {
    // The unmount ordering React gives on a route change: the outgoing guard's
    // cleanup runs after the incoming one has armed. Reporting "unarmed" there
    // would let the lock chord fire over a table that has just staged work.
    const disarmFirst = armLeaveGuard(() => {});
    armLeaveGuard(() => {});

    disarmFirst();

    expect(isLeaveGuardArmed()).toBe(true);
  });

  it('tells the lock chord to stand down without answering for it', () => {
    // ── The finding ──
    // `⇧L` called `onLock` directly, which zeroizes the vault and unmounts the
    // secret table — the same loss a navigation causes, through a door the
    // guard cannot watch. It cannot be handed to `askBeforeLeaving` either:
    // that path ends in `router.push`, so confirming would navigate instead of
    // locking. So the chord asks whether anything is at stake and declines.
    const asked: string[] = [];
    const disarm = armLeaveGuard((href) => asked.push(href));

    expect(isLeaveGuardArmed()).toBe(true);
    // Asking does not consume or move the guard: the Lock item in the account
    // menu is still there, and the next real navigation still gets its dialog.
    expect(askBeforeLeaving('/acme/projects')).toBe(true);
    expect(asked).toEqual(['/acme/projects']);

    disarm();
    expect(askBeforeLeaving('/acme/projects')).toBe(false);
  });
});
