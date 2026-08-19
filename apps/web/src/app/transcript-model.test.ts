import { describe, expect, it } from 'vitest';

import {
  lineLifetime,
  nextTabIndex,
  scriptDurationMs,
  scriptSignature,
  transcriptGates,
  transcriptMinHeight,
} from './transcript-model';
import type { Line, TranscriptPlan } from './transcript-model';
import { DWELL_TICKS, SCRIPT, TICK_MS } from './cli-demo-script';

/**
 * Each block below is a bug that shipped, or nearly did, on the landing page's
 * two terminal transcripts. They are here rather than in a rendered-component
 * test because this workspace's vitest runs in `node` — the logic was
 * extracted precisely so that the parts that got these wrong are reachable
 * without a DOM.
 */

describe('transcriptGates', () => {
  it('never animates under a reduced-motion preference, whatever the reader does', () => {
    // The bug this guards: an earlier version let a tab click re-enable the
    // animation, which would have overridden a stated accessibility
    // preference on the one path that exists to honour it.
    for (const interacted of [false, true]) {
      for (const started of [false, true]) {
        expect(transcriptGates('print', interacted, started)).toEqual({
          enabled: false,
          running: false,
        });
      }
    }
  });

  it('leaves a panel that was on screen at hydration exactly as the server drew it', () => {
    // The bug this guards: the transcript is server-rendered whole, so
    // switching into type-out mode empties a panel the reader is looking at.
    expect(transcriptGates('settled', false, false).enabled).toBe(false);
    expect(transcriptGates('settled', false, true).enabled).toBe(false);
  });

  it('replays when the reader picks a different tab on a settled panel', () => {
    // The bug this guards: an earlier fix for the wipe above disabled the
    // animation for the whole session, so tab switching silently stopped
    // replaying — and did not come back until the page was reloaded.
    expect(transcriptGates('settled', true, false)).toEqual({ enabled: true, running: true });
  });

  it('renders a below-the-fold panel empty from hydration but waits to type', () => {
    // Empty is safe here precisely because nobody can see it; the clock is
    // what waits, not the decision.
    expect(transcriptGates('type', false, false)).toEqual({ enabled: true, running: false });
    expect(transcriptGates('type', false, true)).toEqual({ enabled: true, running: true });
  });

  it('does not make a reader who picked a tab wait on the scroll observer', () => {
    expect(transcriptGates('type', true, false).running).toBe(true);
  });

  it('answers the whole truth table exactly', () => {
    // Spelled out rather than asserted as a property: an earlier version of
    // this test checked `off && !on === false`, which is vacuously true for
    // the two plans where `off` is false and so said nothing about them.
    const table: Array<[TranscriptPlan, boolean, boolean, boolean, boolean]> = [
      // plan,      interacted, started, enabled, running
      ['print', false, false, false, false],
      ['print', false, true, false, false],
      ['print', true, false, false, false],
      ['print', true, true, false, false],
      ['type', false, false, true, false],
      ['type', false, true, true, true],
      ['type', true, false, true, true],
      ['type', true, true, true, true],
      ['settled', false, false, false, false],
      ['settled', false, true, false, false],
      ['settled', true, false, true, true],
      ['settled', true, true, true, true],
    ];

    for (const [plan, interacted, started, enabled, running] of table) {
      expect({ plan, ...transcriptGates(plan, interacted, started) }).toEqual({
        plan,
        enabled,
        running,
      });
    }
  });

  it('never runs the clock without being enabled', () => {
    for (const plan of ['print', 'type', 'settled'] as const) {
      for (const interacted of [false, true]) {
        for (const started of [false, true]) {
          const { enabled, running } = transcriptGates(plan, interacted, started);
          expect(running && !enabled).toBe(false);
        }
      }
    }
  });
});

describe('lineLifetime', () => {
  it('types a command one character at a time, then dwells', () => {
    expect(lineLifetime({ kind: 'command', text: 'xecret login' }, 8)).toBe(12 + 8);
  });

  it('shows every other kind whole, for the dwell only', () => {
    for (const kind of ['success', 'info', 'comment', 'child', 'file'] as const) {
      expect(lineLifetime({ kind, text: 'a much longer line than the dwell' }, 8)).toBe(8);
    }
  });

  it('spends a single beat on a blank line', () => {
    expect(lineLifetime({ kind: 'blank' }, 8)).toBe(1);
  });
});

describe('scriptDurationMs', () => {
  it('counts the tick each line spends advancing, not just its lifetime', () => {
    // The off-by-one that makes a hand-counted duration wrong: `ticks` has to
    // reach `lifetime` before the line advances, so each line costs one more.
    expect(scriptDurationMs([{ kind: 'blank' }], 10, 8)).toBe(20);
    expect(scriptDurationMs([{ kind: 'info', text: 'x' }], 10, 8)).toBe(90);
  });

  /**
   * WCAG SC 2.2.2: motion that starts by itself, runs past five seconds and
   * sits beside other content must be pausable. The hero's transcript starts
   * on load next to the headline and both calls to action, and the page
   * carries no pause control — so this is the constraint that sets its tick
   * rate. At the 45ms it originally ran at, this run was 5985ms.
   *
   * Asserted against the real `SCRIPT` and the real constants, not a copy, so
   * that adding a line to the hero fails here rather than passing quietly. If
   * it does fail, the fix is the tick rate or a pause control — not this
   * number.
   */
  it('keeps the hero under the five seconds SC 2.2.2 allows', () => {
    expect(scriptDurationMs(SCRIPT, TICK_MS, DWELL_TICKS)).toBeLessThan(5000);
  });

  it('shows why the original 45ms tick did not qualify', () => {
    expect(scriptDurationMs(SCRIPT, 45, DWELL_TICKS)).toBeGreaterThan(5000);
  });

  it('leaves usable headroom, so a slow frame does not breach the limit', () => {
    // `setInterval` only ever runs late, so the computed figure is a floor.
    const ms = scriptDurationMs(SCRIPT, TICK_MS, DWELL_TICKS);
    expect(ms).toBeLessThan(4900);
  });
});

describe('transcriptMinHeight', () => {
  // `leading-6` per line, `gap-0.5` between, `py-3.5` top and bottom. Both
  // callers had hand-written a value short of their own longest script, so the
  // panel grew at the end of every animation and shoved the page down.
  it('matches the install panel and the hero', () => {
    expect(transcriptMinHeight(7)).toBe('13rem');
    expect(transcriptMinHeight(11)).toBe('19.5rem');
  });

  it('charges no gap for a single line, and nothing sensible for none', () => {
    expect(transcriptMinHeight(1)).toBe('3.25rem');
    expect(transcriptMinHeight(0)).toBe('1.75rem');
  });
});

describe('scriptSignature', () => {
  it('is equal for equal content, so an unmemoised caller cannot loop', () => {
    // Keying the reset on object identity meant an inline array literal
    // produced a new script every render, and React threw "Too many
    // re-renders".
    const build = (): Line[] => [{ kind: 'command', text: 'xecret login' }, { kind: 'blank' }];
    expect(build()).not.toBe(build());
    expect(scriptSignature(build())).toBe(scriptSignature(build()));
  });

  it('separates on something a transcript line cannot contain', () => {
    // On a space these two would agree, and a transcript is mostly spaces.
    const joined: Line[] = [{ kind: 'info', text: 'a b' }];
    const split: Line[] = [
      { kind: 'info', text: 'a' },
      { kind: 'info', text: 'b' },
    ];
    expect(scriptSignature(joined)).not.toBe(scriptSignature(split));
  });

  it('tells the four install channels apart', () => {
    const scripts: Line[][] = [
      [{ kind: 'command', text: 'brew install playxoft/tap/xecret' }],
      [{ kind: 'command', text: 'curl -fsSL https://x/install.sh | sh' }],
      [{ kind: 'command', text: 'xecret version' }],
      [{ kind: 'file', text: 'FROM ghcr.io/playxoft/xecret:1.2.0 AS xecret' }],
    ];
    const signatures = scripts.map(scriptSignature);
    expect(new Set(signatures).size).toBe(scripts.length);
  });
});

describe('nextTabIndex', () => {
  it('wraps in both directions', () => {
    expect(nextTabIndex('ArrowRight', 3, 3)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(3);
    expect(nextTabIndex('ArrowRight', 0, 3)).toBe(1);
    expect(nextTabIndex('ArrowLeft', 2, 3)).toBe(1);
  });

  it('jumps to the ends', () => {
    expect(nextTabIndex('Home', 2, 3)).toBe(0);
    expect(nextTabIndex('End', 1, 3)).toBe(3);
  });

  it('returns null for keys that are not navigation, so they keep their meaning', () => {
    for (const key of ['Tab', 'Enter', ' ', 'a', 'ArrowUp', 'Escape']) {
      expect(nextTabIndex(key, 1, 3)).toBeNull();
    }
  });

  /**
   * `Home` on the first tab and `End` on the last return the index that is
   * already active. That is legitimate — the key did navigate — so the caller
   * is the one that must not treat it as the reader choosing a *different*
   * platform. Doing so flipped `enabled` with the script unchanged and wiped
   * the transcript on screen.
   */
  it('can return the current index, which the caller has to handle', () => {
    expect(nextTabIndex('Home', 0, 3)).toBe(0);
    expect(nextTabIndex('End', 3, 3)).toBe(3);
  });
});
