import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { HiddenInputCancelled, HiddenInputUnavailable, readHiddenLine } from './hidden-prompt';

/** A terminal stand-in: records raw-mode changes and what was written to the screen. */
function fakeTerminal(isTTY = true) {
  const emitter = new EventEmitter();
  const rawModes: boolean[] = [];
  let paused = false;
  const input = {
    isTTY,
    setRawMode: (mode: boolean) => rawModes.push(mode),
    setEncoding: () => undefined,
    resume: () => {
      paused = false;
    },
    pause: () => {
      paused = true;
    },
    on: (event: 'data', listener: (chunk: string) => void) => emitter.on(event, listener),
    removeListener: (event: 'data', listener: (chunk: string) => void) =>
      emitter.removeListener(event, listener),
  };
  let screen = '';
  const output = { write: (text: string) => (screen += text) };
  return {
    input,
    output,
    type: (...chunks: string[]) => chunks.forEach((chunk) => emitter.emit('data', chunk)),
    rawModes,
    screen: () => screen,
    paused: () => paused,
    listeners: () => emitter.listenerCount('data'),
  };
}

describe('readHiddenLine', () => {
  it('returns what was typed, echoing nothing but the prompt, and restores the terminal', async () => {
    const t = fakeTerminal();
    const line = readHiddenLine(t.input, t.output, 'Password: ');
    t.type('hun', 'ter2', '\r');
    expect(await line).toBe('hunter2');
    expect(t.screen()).toBe('Password: \n');
    expect(t.rawModes).toEqual([true, false]);
    expect(t.paused()).toBe(true);
    expect(t.listeners()).toBe(0);
  });

  it('handles a paste arriving in one chunk with the Enter', async () => {
    const t = fakeTerminal();
    const line = readHiddenLine(t.input, t.output, '');
    t.type('correct horse battery staple\r\n');
    expect(await line).toBe('correct horse battery staple');
  });

  it('erases with Backspace (either code), clears with Ctrl-U', async () => {
    const t = fakeTerminal();
    const line = readHiddenLine(t.input, t.output, '');
    t.type('abcX', '\x7f', 'Y\b', 'd', '\x15', 'pass', '\x7f\x7f\x7f\x7f\x7f', 'word', '\n');
    expect(await line).toBe('word');
  });

  it('keeps non-ASCII characters whole, and backspace removes one character, not one code unit', async () => {
    const t = fakeTerminal();
    const line = readHiddenLine(t.input, t.output, '');
    t.type('pä🔑ss🔑', '\x7f', '\r');
    expect(await line).toBe('pä🔑ss');
  });

  it('ignores arrow keys and other control characters', async () => {
    const t = fakeTerminal();
    const line = readHiddenLine(t.input, t.output, '');
    t.type('se', '\x1b[D', '\t', 'cret', '\x1b[A', '\r');
    expect(await line).toBe('secret');
  });

  it('cancels on Ctrl-C, and on Ctrl-D at an empty line, restoring the terminal', async () => {
    for (const keys of [['ab', '\x03'], ['\x04']]) {
      const t = fakeTerminal();
      const line = readHiddenLine(t.input, t.output, '');
      t.type(...keys);
      await expect(line).rejects.toBeInstanceOf(HiddenInputCancelled);
      expect(t.rawModes).toEqual([true, false]);
      expect(t.listeners()).toBe(0);
    }
  });

  it('ignores Ctrl-D once something is typed', async () => {
    const t = fakeTerminal();
    const line = readHiddenLine(t.input, t.output, '');
    t.type('ab\x04c\r');
    expect(await line).toBe('abc');
  });

  it('refuses a stdin that is not a terminal, before printing anything', async () => {
    const t = fakeTerminal(false);
    await expect(readHiddenLine(t.input, t.output, 'Password: ')).rejects.toBeInstanceOf(
      HiddenInputUnavailable,
    );
    expect(t.screen()).toBe('');
    expect(t.rawModes).toEqual([]);
  });
});
