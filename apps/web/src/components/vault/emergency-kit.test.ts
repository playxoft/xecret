import { describe, expect, it } from 'vitest';
import { generateRecoveryCode, generateRecoveryCodes } from '@xecret/core/crypto/client';

import {
  EMERGENCY_KIT_EXPLANATION,
  emergencyKitFilename,
  emergencyKitText,
  kitConfirmationProblem,
  promptedCodeIndex,
} from './emergency-kit';

/**
 * What the Emergency Kit says, and what it takes to leave the screen showing it.
 *
 * The file is the artefact that outlives everything else here — the tab, the
 * session, very likely the laptop — and it is read by somebody who has forgotten
 * what any of this was. So its contents are asserted rather than assumed: an
 * omitted account email makes a kit nobody can attribute, and an omitted
 * explanation makes five strings nobody will keep.
 */

const codes = generateRecoveryCodes();
const issuedAt = new Date('2026-09-08T11:22:33.000Z');
const kit = { email: 'ada@example.com', issuedAt, codes };

describe('the kit file', () => {
  const text = emergencyKitText(kit);

  it('names the account it belongs to', () => {
    expect(text).toContain('ada@example.com');
  });

  it('carries the date it was issued, unambiguously in every locale', () => {
    expect(text).toContain('2026-09-08');
  });

  it('lists every code in the grouped display form', () => {
    for (const code of codes) expect(text).toContain(code.displayForm);
  });

  it('numbers the codes, so a prompt for "code 3" means something', () => {
    expect(text).toContain(`1. ${codes[0]!.displayForm}`);
    expect(text).toContain(`5. ${codes[4]!.displayForm}`);
  });

  it('explains what the codes are and what losing them costs', () => {
    expect(text).toContain(EMERGENCY_KIT_EXPLANATION);
    expect(EMERGENCY_KIT_EXPLANATION).toMatch(
      /nothing can bring your secrets back — not even xecret/i,
    );
    expect(EMERGENCY_KIT_EXPLANATION).toMatch(/works once/i);
  });

  it('does not contain the passphrase, and says where it should be kept instead', () => {
    expect(text).toMatch(/passphrase is deliberately not written here/i);
  });

  it('names the file after the date it was issued', () => {
    expect(emergencyKitFilename(issuedAt)).toBe('xecret-emergency-kit-2026-09-08.txt');
  });
});

describe('the save-confirmation gate', () => {
  const prompted = codes[2]!;

  it('is satisfied outright by a download or a print', () => {
    expect(kitConfirmationProblem({ saved: true, prompted, typed: '' })).toBeNull();
  });

  it('asks for one or the other when nothing has happened', () => {
    expect(kitConfirmationProblem({ saved: false, prompted, typed: '' })).toMatch(
      /download or print/i,
    );
  });

  it('accepts the prompted code typed back exactly', () => {
    expect(
      kitConfirmationProblem({ saved: false, prompted, typed: prompted.displayForm }),
    ).toBeNull();
  });

  it.each([
    ['lower case', (value: string) => value.toLowerCase()],
    ['no hyphens', (value: string) => value.replaceAll('-', '')],
    ['stray spacing', (value: string) => ` ${value.replaceAll('-', ' ')} `],
  ])('forgives %s, which is what copying off paper produces', (_name, mangle) => {
    expect(
      kitConfirmationProblem({ saved: false, prompted, typed: mangle(prompted.displayForm) }),
    ).toBeNull();
  });

  it('refuses a different code from the same kit', () => {
    // The point of asking for a *specific* code: copying one and ignoring the
    // rest must not satisfy the gate.
    expect(
      kitConfirmationProblem({ saved: false, prompted, typed: codes[0]!.displayForm }),
    ).toMatch(/does not match/i);
  });

  it('refuses a near miss', () => {
    const typed = `${prompted.displayForm.slice(0, -1)}${prompted.displayForm.endsWith('0') ? '1' : '0'}`;
    expect(kitConfirmationProblem({ saved: false, prompted, typed })).toMatch(/does not match/i);
  });
});

describe('which code is asked for', () => {
  it('stays inside the kit', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const index = promptedCodeIndex(5);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(5);
    }
  });

  it('is not always the first one', () => {
    const seen = new Set(Array.from({ length: 200 }, () => promptedCodeIndex(5)));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('a code from another kit entirely', () => {
  it('is refused', () => {
    expect(
      kitConfirmationProblem({
        saved: false,
        prompted: codes[1]!,
        typed: generateRecoveryCode().displayForm,
      }),
    ).toMatch(/does not match/i);
  });
});
