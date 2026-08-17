import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as SelectPrimitive from '@radix-ui/react-select';

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
 *
 * The first block below asserts the guard's own behaviour against roles typed
 * in by hand; the second asserts the premise those roles rest on. Only the
 * second can catch the regression happening again, and the note on it says
 * why.
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

/**
 * The premise the block above rests on, asserted against Radix itself.
 *
 * Every case above hands `ownsPlainKeys` a role string typed by hand, so they
 * all agree with `SELF_MANAGED_ROLES` for the uninteresting reason that both
 * were written from the same belief. If Radix stopped rendering the closed
 * trigger as `role="combobox"` — a major bump, or a `SelectTrigger` given
 * `asChild` over an element that does not carry the role — every one of them
 * would still pass while the Members page regressed exactly as before. The
 * belief is the fragile part, so it is the part worth pinning.
 *
 * There is no DOM in this suite (`vitest.config.mts` sets `environment:
 * 'node'`, and neither jsdom nor happy-dom is installed) and this does not add
 * one: a role is an attribute, and `react-dom/server` puts attributes into a
 * string without a browser anywhere. What the guard is fed below is therefore
 * the role Radix actually emits, not the role we assume it emits.
 *
 * The one thing this still cannot see is our own wrapper: `SelectTrigger` in
 * `components/ui/select.tsx` is a `.tsx` module and `tsconfig.json` sets `jsx:
 * "preserve"`, which Vite cannot parse, so the component that ships is out of
 * reach here without changing the build. It forwards to the primitive rendered
 * below and adds no `asChild`; if that ever changes, this suite will not
 * notice.
 */
describe('the Radix contract ownsPlainKeys depends on', () => {
  /** The closed trigger, reduced to the two things the guard looks at. */
  function renderClosedSelectTrigger(): { tagName: string; role: string | null } {
    const html = renderToStaticMarkup(
      createElement(
        SelectPrimitive.Root,
        null,
        createElement(SelectPrimitive.Trigger, null, 'Member'),
      ),
    );

    // Radix renders a hidden native `<select>` as a sibling for form
    // submission, so match the first element only — the trigger is what takes
    // focus and what `event.target` will be.
    const element = /^<([a-z]+)([^>]*)>/i.exec(html);
    if (element === null) throw new Error(`Radix rendered no element: ${html}`);

    const role = /\brole="([^"]*)"/.exec(element[2] as string);

    return {
      tagName: (element[1] as string).toUpperCase(),
      role: role === null ? null : (role[1] as string),
    };
  }

  it('renders the closed trigger as a button that announces itself as a combobox', () => {
    const { tagName, role } = renderClosedSelectTrigger();

    // Both halves are the regression. `BUTTON` is why looking at the tag alone
    // let the keystroke through, and `combobox` is the only thing on the
    // element that says it typeaheads — Radix consumes the letter without
    // calling `preventDefault`, so there is no second signal to fall back on.
    expect(tagName).toBe('BUTTON');
    expect(role).toBe('combobox');
  });

  it('stands down for the role that trigger actually carries', () => {
    const { tagName, role } = renderClosedSelectTrigger();

    // The end of the chain: whatever Radix emitted above is what the guard is
    // asked about here, so a Radix upgrade that renames the role fails this
    // even if `SELF_MANAGED_ROLES` is never touched.
    expect(ownsPlainKeys(tagName, role)).toBe(true);
  });
});
