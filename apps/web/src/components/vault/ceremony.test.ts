import { describe, expect, it } from 'vitest';
import { generateRecoveryCode } from '@xecret/core/crypto/client';

import {
  CONSENT_STATEMENT,
  nextSetupStep,
  setupStepPosition,
  setupStepProblem,
  VAULT_SETUP_STEPS,
} from './ceremony';
import type { VaultSetupState } from './ceremony';

/**
 * The gates that decide whether somebody may create an unrecoverable vault.
 *
 * Both of them exist to stop the same failure: a user clicking through a screen
 * they did not read, and discovering months later what it said. The consent box
 * is the one that makes the trade explicit; the kit gate is the one that makes
 * sure the escape hatch actually left the tab.
 */

const code = generateRecoveryCode();

const base: VaultSetupState = {
  consented: false,
  passphrase: '',
  confirm: '',
  score: null,
  kitSaved: false,
  promptedCode: null,
  typedCode: '',
};

describe('the consent step', () => {
  it('refuses to advance until the box is ticked', () => {
    expect(setupStepProblem('explain', base)).toMatch(/tick the box/i);
  });

  it('advances once it is', () => {
    expect(setupStepProblem('explain', { ...base, consented: true })).toBeNull();
  });

  it('states the consequence without hedging', () => {
    // The wording is the control. "May be unable to" would describe a different
    // product: there is no key on the server side, so there is no case in which
    // anyone can help.
    expect(CONSENT_STATEMENT).toContain('unrecoverable');
    expect(CONSENT_STATEMENT).toContain('no one can help');
    expect(CONSENT_STATEMENT).not.toMatch(/may |might |usually |in most cases/i);
  });
});

describe('the passphrase step', () => {
  const consented = { ...base, consented: true };

  it('asks for a passphrase before anything else', () => {
    expect(setupStepProblem('passphrase', consented)).toMatch(/choose a master passphrase/i);
  });

  it('reports the length floor before it reports strength', () => {
    // A "too weak" message on a four-character string tells the user nothing
    // they did not already know.
    const problem = setupStepProblem('passphrase', {
      ...consented,
      passphrase: 'short',
      confirm: 'short',
      score: 0,
    });
    expect(problem).toMatch(/at least 12 characters/i);
  });

  it('refuses a long passphrase that has not been scored yet', () => {
    // The estimate is asynchronous. Being wrong in the direction of "wait" is
    // the safe one.
    expect(
      setupStepProblem('passphrase', {
        ...consented,
        passphrase: 'a passphrase long enough',
        confirm: 'a passphrase long enough',
        score: null,
      }),
    ).toMatch(/checking/i);
  });

  it.each([0, 1, 2, 3])('refuses score %i, one short of the bar included', (score) => {
    expect(
      setupStepProblem('passphrase', {
        ...consented,
        passphrase: 'a passphrase long enough',
        confirm: 'a passphrase long enough',
        score,
      }),
    ).toMatch(/guessable/i);
  });

  it('asks for the confirmation once the passphrase itself passes', () => {
    expect(
      setupStepProblem('passphrase', {
        ...consented,
        passphrase: 'a passphrase long enough',
        confirm: '',
        score: 4,
      }),
    ).toMatch(/type the passphrase again/i);
  });

  it('refuses a mismatched confirmation', () => {
    expect(
      setupStepProblem('passphrase', {
        ...consented,
        passphrase: 'a passphrase long enough',
        confirm: 'a passphrase long enougi',
        score: 4,
      }),
    ).toMatch(/do not match/i);
  });

  it('accepts a strong, long, confirmed passphrase and nothing less', () => {
    expect(
      setupStepProblem('passphrase', {
        ...consented,
        passphrase: 'a passphrase long enough',
        confirm: 'a passphrase long enough',
        score: 4,
      }),
    ).toBeNull();
  });
});

describe('the recovery-kit step', () => {
  const issued = { ...base, consented: true, promptedCode: code };

  it('refuses to continue before the kit is saved or a code is typed back', () => {
    expect(setupStepProblem('kit', issued)).toMatch(/download or print/i);
  });

  it('continues once the kit has been downloaded or printed', () => {
    expect(setupStepProblem('kit', { ...issued, kitSaved: true })).toBeNull();
  });

  it('continues when the prompted code is typed back exactly', () => {
    expect(setupStepProblem('kit', { ...issued, typedCode: code.displayForm })).toBeNull();
  });

  it('refuses a code that does not match the one shown', () => {
    const other = generateRecoveryCode();
    expect(setupStepProblem('kit', { ...issued, typedCode: other.displayForm })).toMatch(
      /does not match/i,
    );
  });

  it('refuses to continue at all before codes exist', () => {
    expect(setupStepProblem('kit', { ...base, promptedCode: null })).toMatch(/not been issued/i);
  });
});

describe('the steps that gate nothing', () => {
  it('never blocks the generating screen, which has nothing to decide', () => {
    expect(setupStepProblem('generating', base)).toBeNull();
  });

  it('never blocks passkey enrolment, which is genuinely optional', () => {
    // Making it mandatory would turn "this authenticator does not support PRF"
    // into a vault its owner cannot finish creating.
    expect(setupStepProblem('passkey', base)).toBeNull();
  });
});

describe('step order', () => {
  it('runs explain → passphrase → generating → kit → passkey', () => {
    expect(VAULT_SETUP_STEPS).toEqual(['explain', 'passphrase', 'generating', 'kit', 'passkey']);
  });

  it('ends after the passkey step', () => {
    expect(nextSetupStep('passkey')).toBeNull();
    expect(nextSetupStep('explain')).toBe('passphrase');
  });

  it('does not count the generating screen when numbering the steps', () => {
    expect(setupStepPosition('explain')).toEqual({ current: 1, total: 4 });
    expect(setupStepPosition('kit')).toEqual({ current: 3, total: 4 });
  });
});
