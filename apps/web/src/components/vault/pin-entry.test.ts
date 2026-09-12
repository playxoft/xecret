import { describe, expect, it } from 'vitest';

import { caretBox, maskedBoxes, pinDigits, revealedBox } from './pin-entry';

/**
 * The six boxes, tested as arithmetic.
 *
 * ── Why these assertions exist ──
 * None of this is visible: a filter that drops a digit, or a mask that reveals
 * one it should not, produces six boxes that *look* right and are not what the
 * person typed. On the lock screen that costs one of five attempts and reads as
 * a forgotten PIN; on the enrolment form it silently enrols something nobody can
 * retype. The component that renders these rules cannot be tested here — the web
 * app's suite runs without a DOM — which is precisely why the rules are not
 * inside it.
 */

describe('the digits a field contributes', () => {
  it('keeps every digit of a change event, not just one of them', () => {
    // The regression. The first version of this entry was six one-character
    // inputs, and typing `274` at a normal speed reliably produced two digits:
    // each keystroke re-rendered and moved focus while the next was already in
    // flight, so characters arrived at an element that was no longer the one
    // being typed into — and the rule that read them took a single character
    // from each event. One input and an order-preserving filter is the fix, and
    // this is the assertion that would have caught it: several characters in one
    // event are several digits, in order.
    expect(pinDigits('274', 6)).toBe('274');
    expect(pinDigits('274913', 6)).toBe('274913');
  });

  it('holds every digit through a burst typed faster than a render', () => {
    // What the browser hands back when React has not repainted between
    // keystrokes: the field's whole value, growing, rather than one character at
    // a time. Folding the events must reach the same six digits as typing them
    // slowly, and no event may lose the characters that arrived before it.
    let value = '';
    for (const raw of ['2', '27', '274', '2749', '27491', '274913']) {
      value = pinDigits(raw, 6);
    }

    expect(value).toBe('274913');
  });

  it('drops everything that is not an ASCII digit, and keeps the order of what is', () => {
    // `isDevicePin` rejects the Arabic-Indic block for the reason a PIN typed on
    // one keyboard and retyped on another must derive the same key.
    expect(pinDigits('a2b7c4', 6)).toBe('274');
    expect(pinDigits('27 49-13', 6)).toBe('274913');
    for (const raw of ['abc', '١٢٣', '１２３', ' ', '']) {
      expect(pinDigits(raw, 6), raw).toBe('');
    }
  });

  it('never accepts more than the six boxes can show', () => {
    expect(pinDigits('12345678', 6)).toBe('123456');
  });
});

describe('deleting, which is not a keystroke here', () => {
  /**
   * There is no `Backspace` case anywhere in this feature, deliberately.
   *
   * GBoard reports most keys as `Unidentified` with `keyCode` 229, backspace
   * included, so an entry that implemented deletion by watching for the key name
   * had no working delete key on Android at all. Deletion is a *shorter value*,
   * which every keyboard, IME and autofill path agrees on, and these are the
   * rules that have to hold for it.
   */
  it('is just a shorter value, from any key that produced it', () => {
    expect(pinDigits('27491', 6)).toBe('27491');
    expect(pinDigits('', 6)).toBe('');
  });

  it('moves the caret back to the end of what is left', () => {
    expect(caretBox(pinDigits('27491', 6), 6)).toBe(5);
    expect(caretBox(pinDigits('2', 6), 6)).toBe(1);
  });

  it('reveals nothing, so a deleted digit is never shown on its way out', () => {
    expect(revealedBox('274913', '27491')).toBeNull();
  });

  it('leaves no digit behind that the next keystroke could overwrite', () => {
    // The old six-input entry deleted at one box and moved the caret to
    // another, so the next digit landed on a digit nobody had deleted — and on
    // the lock screen that auto-submitted a PIN the user never typed. A value
    // and a caret derived from its length cannot express that state.
    const afterDelete = pinDigits('27491', 6);

    expect(pinDigits(`${afterDelete}3`, 6)).toBe('274913');
  });
});

describe('which box the caret is in front of', () => {
  it('is the one after the last digit typed', () => {
    expect(caretBox('', 6)).toBe(0);
    expect(caretBox('27', 6)).toBe(2);
  });

  it('stays on the last box once all six are full', () => {
    // Rather than pointing past the end of the group, where the highlight would
    // simply disappear at the moment the entry is complete.
    expect(caretBox('274913', 6)).toBe(5);
  });
});

describe('which digit is legible', () => {
  it('reveals the digit that was just added', () => {
    expect(revealedBox('27', '274')).toBe(2);
    expect(revealedBox('', '2')).toBe(0);
  });

  it('reveals the last of several arriving at once', () => {
    expect(revealedBox('', '274913')).toBe(5);
  });

  it('reveals nothing on a deletion, or on a value that did not grow', () => {
    // Showing the character somebody has just backspaced over is the one moment
    // they have said they do not want to see it.
    expect(revealedBox('274', '27')).toBeNull();
    expect(revealedBox('274913', '')).toBeNull();
    expect(revealedBox('274', '274')).toBeNull();
  });
});

describe('what the boxes read', () => {
  it('masks everything entered except the one being revealed', () => {
    expect(maskedBoxes('274', 2, 6)).toEqual(['•', '•', '4', '', '', '']);
  });

  it('masks everything once the reveal has expired', () => {
    expect(maskedBoxes('274', null, 6)).toEqual(['•', '•', '•', '', '', '']);
  });

  it('always renders exactly six boxes', () => {
    expect(maskedBoxes('', null, 6)).toHaveLength(6);
    expect(maskedBoxes('274913', 5, 6)).toEqual(['•', '•', '•', '•', '•', '3']);
  });

  it('ignores a reveal pointing at a box with nothing in it', () => {
    // The state between a cleared entry and the timer that has not fired yet.
    expect(maskedBoxes('27', 4, 6)).toEqual(['•', '•', '', '', '', '']);
  });
});
