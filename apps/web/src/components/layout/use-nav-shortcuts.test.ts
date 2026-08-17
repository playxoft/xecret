import { describe, expect, it } from 'vitest';

import { ownsPlainKeys } from './use-nav-shortcuts';

/**
 * The guard that decides whether an unmodified letter is ours to act on.
 *
 * This is the half of the shortcut hook worth pinning down in a test: getting
 * it wrong does not fail loudly, it navigates the user off the page they were
 * working on, and only for the one keystroke that happened to collide. The
 * regression that prompted these cases was a role filter on the Members page —
 * tab to the `Select`, press `M` to reach "Member", and the letter went to the
 * router instead, because the trigger is a `<button>` and the tag was all this
 * looked at.
 */

describe('ownsPlainKeys', () => {
  it('stands down on a widget that only announces itself through its role', () => {
    // The Radix `Select` trigger, exactly as it renders while closed. Radix
    // typeaheads on the letter and never calls `preventDefault`, so there is
    // no second signal to fall back on if this one is missed.
    expect(ownsPlainKeys('BUTTON', 'combobox')).toBe(true);
    expect(ownsPlainKeys('DIV', 'listbox')).toBe(true);
    expect(ownsPlainKeys('DIV', 'menu')).toBe(true);
  });

  it('stands down on the item inside a widget, not just its container', () => {
    // Composites move focus onto their children, so the child is what
    // `event.target` reports once the user is navigating within one.
    expect(ownsPlainKeys('DIV', 'option')).toBe(true);
    expect(ownsPlainKeys('DIV', 'menuitem')).toBe(true);
    expect(ownsPlainKeys('BUTTON', 'tab')).toBe(true);
    expect(ownsPlainKeys('LI', 'treeitem')).toBe(true);
  });

  it('still stands down for the text controls that never regressed', () => {
    expect(ownsPlainKeys('INPUT', null)).toBe(true);
    expect(ownsPlainKeys('TEXTAREA', null)).toBe(true);
    expect(ownsPlainKeys('SELECT', null)).toBe(true);
    // A `<div role="textbox">` is a text field to everyone but the tag check.
    expect(ownsPlainKeys('DIV', 'textbox')).toBe(true);
  });

  it('reads role as the token list it is', () => {
    // `role="combobox listbox"` is a fallback chain, not a typo: a user agent
    // takes the first token it recognises. Either one landing on a widget is
    // reason enough to leave the keystroke alone.
    expect(ownsPlainKeys('DIV', 'combobox listbox')).toBe(true);
    expect(ownsPlainKeys('DIV', 'doc-subtitle  menuitem')).toBe(true);
    expect(ownsPlainKeys('DIV', 'ComboBox')).toBe(true);
  });

  it('leaves the shortcut alone for anything that does not read letters', () => {
    // The point of the guard is to be narrow. A page of ordinary content and
    // ordinary buttons is where the key caps in the sidebar have to work, so
    // over-suppressing here would quietly delete the feature.
    expect(ownsPlainKeys('BUTTON', null)).toBe(false);
    expect(ownsPlainKeys('BODY', null)).toBe(false);
    expect(ownsPlainKeys('A', null)).toBe(false);
    expect(ownsPlainKeys('DIV', 'button')).toBe(false);
    expect(ownsPlainKeys('DIV', 'checkbox')).toBe(false);
    expect(ownsPlainKeys('DIV', 'presentation')).toBe(false);
    expect(ownsPlainKeys('TD', 'none')).toBe(false);
  });
});
