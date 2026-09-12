import { describe, expect, it } from 'vitest';

import { applyDigits, deleteBackward, deleteForward, entryIndex, typedDigits } from './pin-entry';

/**
 * The six boxes, tested as arithmetic.
 *
 * ── Why these assertions exist ──
 * None of this is visible: a paste that lands its last digit in the first box,
 * or a `Backspace` that deletes the wrong one, produces six digits that *look*
 * complete and are not the ones the person typed. On the lock screen that costs
 * one of five attempts and reads as a forgotten PIN; on the enrolment form it
 * silently enrols something nobody can retype. The component that renders these
 * rules cannot be tested here — the web app's suite runs without a DOM — which
 * is precisely why the rules are not inside it.
 */

describe('what a box makes of the characters it was handed', () => {
  it('takes the digit, in a box that was empty', () => {
    expect(typedDigits('7', '')).toBe('7');
  });

  it('drops the mask a controlled box was already showing', () => {
    // The box holds `•` and the caret is after it, so the browser reports both.
    expect(typedDigits('•7', '')).toBe('7');
  });

  it('drops the digit a box was showing, once, and by identity', () => {
    // Mid-reveal: the previous digit is legible, so it comes back with the new
    // one. Removing it by value rather than by position is what makes typing a
    // `7` over a `7` mean seven rather than nothing.
    expect(typedDigits('37', '3')).toBe('7');
    expect(typedDigits('73', '3')).toBe('7');
    expect(typedDigits('77', '7')).toBe('7');
  });

  it('refuses everything that is not an ASCII digit', () => {
    // `isDevicePin` rejects the Arabic-Indic block for the reason a PIN typed on
    // one keyboard and retyped on another must derive the same key. A box that
    // accepted them would build a value the validator then calls too short.
    for (const raw of ['a', ' ', '-', '١', '１', '']) {
      expect(typedDigits(raw, ''), raw).toBe('');
    }
  });

  it('hands back every digit of a paste rather than picking one', () => {
    // The bug this returns a string for: taking the last character puts a pasted
    // PIN's sixth digit in the first box.
    expect(typedDigits('123456', '')).toBe('123456');
  });
});

describe('where a keystroke lands', () => {
  it('stays in the box that was aimed at, inside what has been typed', () => {
    expect(entryIndex('1234', 2, 6)).toBe(2);
    expect(entryIndex('1234', 4, 6)).toBe(4);
  });

  it('is pulled back to the end rather than leaving a hole', () => {
    expect(entryIndex('12', 5, 6)).toBe(2);
    expect(entryIndex('', 3, 6)).toBe(0);
  });

  it('never leaves the six boxes', () => {
    expect(entryIndex('123456', 6, 6)).toBe(5);
    expect(entryIndex('123456', -1, 6)).toBe(0);
  });
});

describe('writing digits into the value', () => {
  it('appends at the end', () => {
    expect(applyDigits('12', 2, '3', 6)).toBe('123');
  });

  it('overwrites one box when the caret is inside what was typed', () => {
    expect(applyDigits('123456', 2, '9', 6)).toBe('129456');
  });

  it('distributes a paste across the boxes from the caret', () => {
    expect(applyDigits('', 0, '123456', 6)).toBe('123456');
    expect(applyDigits('12', 2, '3456', 6)).toBe('123456');
  });

  it('never grows past the six boxes', () => {
    expect(applyDigits('', 0, '12345678', 6)).toBe('123456');
    expect(applyDigits('12345', 5, '99', 6)).toBe('123459');
  });

  it('leaves the value alone when nothing typed was a digit', () => {
    expect(applyDigits('123', 3, 'abc', 6)).toBe('123');
  });

  it('keeps the value a prefix even when aimed past the end', () => {
    // The state after a failed attempt clears the entry while the caret is
    // still in the sixth box.
    expect(applyDigits('', 5, '4', 6)).toBe('4');
  });
});

describe('deleting', () => {
  it('takes the digit in the box, when there is one', () => {
    expect(deleteBackward('123456', 2)).toBe('12456');
  });

  it('takes the one before, from the empty box the caret rests in', () => {
    expect(deleteBackward('123', 3)).toBe('12');
    expect(deleteBackward('123456', 6)).toBe('12345');
  });

  it('does nothing at the start of an empty entry, and does not throw', () => {
    expect(deleteBackward('', 0)).toBe('');
    expect(deleteBackward('', -1)).toBe('');
  });

  it('takes only this box going forwards', () => {
    expect(deleteForward('123456', 0)).toBe('23456');
    expect(deleteForward('123', 3)).toBe('123');
  });
});
