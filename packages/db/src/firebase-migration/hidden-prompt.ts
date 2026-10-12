/**
 * Reads one line from an interactive terminal without echoing it.
 *
 * For the two checks that need a real person's password: `--check-hash-params`
 * and `--check-sign-in`. The password never appears on screen, in the
 * process's arguments, in its environment, or in shell history.
 *
 * The terminal is put in raw mode, so the terminal itself echoes nothing and
 * this reads key by key: Enter finishes, Backspace erases, Ctrl-U clears,
 * Ctrl-C (and Ctrl-D on an empty line) cancels, escape sequences (arrow keys)
 * and other control characters are ignored. Nothing is printed per key — not
 * even an asterisk, which would show the length.
 *
 * A stdin that is not a terminal is refused rather than read. A pipe is not
 * necessarily silent: in Git Bash's default window (mintty) a native program
 * sees a pipe while the terminal still echoes what is typed into it, and a
 * password echoed there is on screen and in the scrollback. Run these checks
 * in PowerShell, or in any shell inside Windows Terminal — Git Bash included —
 * where stdin is a console. `winpty` is no way round mintty: `winpty npm …`
 * fails ("npm: Not found in PATH"), because npm is a `.cmd` shim. Verified
 * 2026-10-12 through a Windows pseudo console (ConPTY, which is what Windows
 * Terminal uses), under `phase run`, and from Git Bash inside one.
 */

/** The part of `process.stdin` this needs, so a test can stand in for it. */
export interface HiddenInput {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding(encoding: 'utf8'): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: string) => void): unknown;
}

export interface HiddenOutput {
  write(text: string): unknown;
}

export class HiddenInputUnavailable extends Error {
  constructor() {
    super(
      'This needs an interactive terminal, and stdin is not one. Run it in PowerShell, or in any shell ' +
        "inside Windows Terminal (Git Bash's own window, mintty, will not do, with or without winpty). " +
        'It will not read a password from a pipe.',
    );
    this.name = 'HiddenInputUnavailable';
  }
}

export class HiddenInputCancelled extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'HiddenInputCancelled';
  }
}

const ENTER = new Set(['\r', '\n']);
const BACKSPACE = new Set(['\b', '\x7f']);
const CTRL_C = '\x03';
const CTRL_D = '\x04';
const CTRL_U = '\x15';
const ESC = '\x1b';

export function readHiddenLine(
  input: HiddenInput,
  output: HiddenOutput,
  prompt: string,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new HiddenInputUnavailable());
  }
  const setRawMode = input.setRawMode.bind(input);
  return new Promise<string>((resolve, reject) => {
    let typed: string[] = [];
    const finish = (error: Error | null) => {
      input.removeListener('data', onData);
      setRawMode(false);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(typed.join(''));
      typed = [];
    };
    const onData = (chunk: string) => {
      // A whole escape sequence arrives as one chunk; none of it is input.
      if (chunk.startsWith(ESC)) return;
      for (const char of Array.from(chunk)) {
        if (ENTER.has(char)) return finish(null);
        if (char === CTRL_C) return finish(new HiddenInputCancelled());
        if (char === CTRL_D) {
          if (typed.length === 0) return finish(new HiddenInputCancelled());
          continue;
        }
        if (BACKSPACE.has(char)) {
          typed.pop();
          continue;
        }
        if (char === CTRL_U) {
          typed = [];
          continue;
        }
        if (char < ' ') continue;
        typed.push(char);
      }
    };
    output.write(prompt);
    setRawMode(true);
    input.setEncoding('utf8');
    input.on('data', onData);
    input.resume();
  });
}
