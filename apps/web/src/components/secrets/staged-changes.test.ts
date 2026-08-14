import { describe, expect, it } from 'vitest';

import { draftNameProblem, isBlankDraft } from './staged-changes';
import type { Draft } from './staged-changes';

/**
 * The validation the inline editor runs as the user types.
 *
 * The server is still the authority on every one of these — a duplicate name is
 * decided by `secrets_env_name_idx`, not by anything here. What these checks buy
 * is the message arriving under the field being typed into rather than after a
 * round trip, and a batch save not wasting a write on a row that cannot succeed.
 */

function draft(patch: Partial<Draft> = {}): Draft {
  return {
    id: 'draft-1',
    name: '',
    value: '',
    note: '',
    valueType: 'string',
    error: null,
    ...patch,
  };
}

const NO_NAMES: ReadonlySet<string> = new Set();

describe('isBlankDraft', () => {
  it('treats an untouched row as no change at all', () => {
    // The table always keeps an empty row available to type into. It must not
    // count as pending work, or the save bar would never go away.
    expect(isBlankDraft(draft())).toBe(true);
    expect(isBlankDraft(draft({ name: '  ' }))).toBe(true);
  });

  it('treats anything typed as work', () => {
    expect(isBlankDraft(draft({ name: 'A' }))).toBe(false);
    expect(isBlankDraft(draft({ value: 'x' }))).toBe(false);
    expect(isBlankDraft(draft({ note: 'rotated quarterly' }))).toBe(false);
  });
});

describe('draftNameProblem', () => {
  it('says nothing about a name that has not been typed yet', () => {
    const row = draft();
    expect(draftNameProblem(row, [row], NO_NAMES)).toBeNull();
  });

  it('accepts a legal, unused name', () => {
    const row = draft({ name: 'DATABASE_URL' });
    expect(draftNameProblem(row, [row], new Set(['OTHER']))).toBeNull();
  });

  it('rejects a name that could not be an environment variable', () => {
    const row = draft({ name: 'my-api-key' });
    expect(draftNameProblem(row, [row], NO_NAMES)).toMatch(/letters, digits and underscores/);
  });

  it('rejects a name the operating system has already claimed', () => {
    const row = draft({ name: 'PATH' });
    expect(draftNameProblem(row, [row], NO_NAMES)).toMatch(/reserved/);
  });

  it('catches a clash with a secret this environment already holds', () => {
    const row = draft({ name: 'DATABASE_URL' });
    expect(draftNameProblem(row, [row], new Set(['DATABASE_URL']))).toMatch(/already has a secret/);
  });

  it('catches two new rows claiming the same name', () => {
    // Without this the second row reaches the unique index and comes back as a
    // 409, which reads like a server fault rather than the typo it is.
    const first = draft({ id: 'draft-1', name: 'API_KEY' });
    const second = draft({ id: 'draft-2', name: 'API_KEY' });
    const rows = [first, second];

    expect(draftNameProblem(first, rows, NO_NAMES)).toMatch(/Another new row/);
    expect(draftNameProblem(second, rows, NO_NAMES)).toMatch(/Another new row/);
  });

  it('does not accuse a row of clashing with itself', () => {
    const row = draft({ name: 'API_KEY' });
    expect(draftNameProblem(row, [row], NO_NAMES)).toBeNull();
  });

  it('ignores surrounding whitespace when comparing', () => {
    const first = draft({ id: 'draft-1', name: 'API_KEY' });
    const second = draft({ id: 'draft-2', name: '  API_KEY  ' });

    expect(draftNameProblem(second, [first, second], NO_NAMES)).toMatch(/Another new row/);
    expect(draftNameProblem(second, [second], new Set(['API_KEY']))).toMatch(
      /already has a secret/,
    );
  });
});
