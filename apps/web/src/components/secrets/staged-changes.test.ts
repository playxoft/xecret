import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api';
import {
  describeWriteFailure,
  draftNameProblem,
  draftProblem,
  draftTargets,
  dropSeeds,
  lowerFirst,
  hasNewValue,
  isBlankDraft,
  isTouched,
  wantsRename,
} from './staged-changes';
import type { Draft, PendingEdit, TargetClaims } from './staged-changes';

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
    placement: 'end',
    name: '',
    value: '',
    note: '',
    valueType: 'string',
    extraValues: {},
    error: null,
    ...patch,
  };
}

/**
 * A row carrying a value for another environment and none for this one.
 *
 * The multi-environment view makes that a deliberate state — "staging needs this
 * key, production does not yet" — and two things have to agree about it: the
 * save bar must count the row, and the save must not refuse it for having an
 * empty box here.
 */
function edit(patch: Partial<PendingEdit> = {}): PendingEdit {
  return { value: '', error: null, ...patch };
}

const NO_NAMES: ReadonlySet<string> = new Set();

describe('hasNewValue', () => {
  it('treats an editor opened on the stored value as no change', () => {
    // The editor is seeded by an audited reveal, so a row opened to *read* a
    // value arrives holding it. That must not light the save bar, and it must
    // not produce a write the server would only answer `unchanged`.
    const opened = 'postgres://localhost/app';
    expect(hasNewValue(edit({ value: opened, baseline: opened }))).toBe(false);
  });

  it('treats one changed character as a change', () => {
    expect(hasNewValue(edit({ value: 'b', baseline: 'a' }))).toBe(true);
  });

  it('treats a value typed into an editor that was never seeded as a change', () => {
    // The reveal can fail — a permission error in production, a dropped
    // connection. The editor stays open and empty, and what is typed into it is
    // still a new value.
    expect(hasNewValue(edit({ value: 'typed' }))).toBe(true);
  });

  it('treats an emptied editor as nothing to write', () => {
    expect(hasNewValue(edit({ value: '', baseline: 'a' }))).toBe(false);
  });
});

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

  it('counts a value typed for another environment on screen', () => {
    // The multi-environment view makes "staging needs this key, production does
    // not yet" a row with an empty box here and a full one there. Reading that as
    // blank would have the save bar ignore it and Discard throw it away without
    // asking.
    expect(isBlankDraft(draft({ name: 'API_KEY', extraValues: { staging: 'x' } }))).toBe(false);
    // And an emptied box is blank again: `setDraftValueIn` deletes the entry, but
    // nothing stops a caller from storing the empty string.
    expect(isBlankDraft(draft({ extraValues: { staging: '' } }))).toBe(true);
  });
});

describe('lowerFirst', () => {
  it('joins a stand-alone sentence onto the end of another', () => {
    expect(lowerFirst('Could not save this secret.')).toBe('could not save this secret.');
  });

  it('leaves an initialism alone', () => {
    // "Not written to production — API key not found" must not become "aPI".
    expect(lowerFirst('API key not found.')).toBe('API key not found.');
  });

  it('is safe on an empty message', () => {
    expect(lowerFirst('')).toBe('');
  });
});

describe('draftTargets', () => {
  it('lists only the environments with something to write', () => {
    expect(
      draftTargets(draft({ extraValues: { staging: 'x', production: '', dev: 'y' } })),
    ).toEqual([
      { slug: 'staging', value: 'x' },
      { slug: 'dev', value: 'y' },
    ]);
  });

  it('is empty for the ordinary single-environment row', () => {
    expect(draftTargets(draft({ name: 'API_KEY', value: 'x' }))).toEqual([]);
  });
});

describe('wantsRename', () => {
  it('says no when no name is staged at all', () => {
    expect(wantsRename('API_KEY', edit())).toBe(false);
  });

  it('says no when the staged name is the stored one', () => {
    // The row stages on every keystroke, so a name typed and restored arrives
    // here as a staged field that changes nothing.
    expect(wantsRename('API_KEY', edit({ name: 'API_KEY' }))).toBe(false);
  });

  it('ignores surrounding whitespace, exactly as the save loop does', () => {
    // The bug this closes: the count said "1 unsaved change", the badge said
    // "Unsaved", and Save then wrote nothing and reported "Nothing to save".
    expect(wantsRename('API_KEY', edit({ name: 'API_KEY  ' }))).toBe(false);
    expect(wantsRename('API_KEY', edit({ name: '  API_KEY' }))).toBe(false);
  });

  it('says yes to a real rename', () => {
    expect(wantsRename('API_KEY', edit({ name: 'API_TOKEN' }))).toBe(true);
  });

  it('treats an emptied name as a rename, so the save reports it as illegal', () => {
    // Not silently dropped: an empty name is a change the user made, and the
    // name check is what tells them it cannot be saved.
    expect(wantsRename('API_KEY', edit({ name: '' }))).toBe(true);
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

/**
 * What a row is refused for at save time, and — in the multi-environment view —
 * *which box* it is refused for.
 *
 * A row there carries one value field per environment on screen. A single
 * message at the bottom of the cell made the reader guess which of four values
 * the complaint was about, and the obvious guess — the one they had just typed
 * into — was usually wrong.
 */
describe('draftProblem', () => {
  function claims(patch: Partial<TargetClaims> = {}): TargetClaims {
    return { slug: 'production', name: 'Production', claimed: new Set(), ...patch };
  }

  it('asks for a name before anything else', () => {
    expect(draftProblem(draft({ value: 'x' }), '', NO_NAMES)).toEqual({
      field: 'name',
      message: 'Enter a name.',
    });
  });

  it('accepts a row with a value only for another environment', () => {
    // "Staging needs this key, production does not yet" is a deliberate state,
    // and refusing it would make the other boxes unusable.
    const row = draft({ name: 'API_KEY', extraValues: { staging: 'x' } });
    expect(draftProblem(row, 'API_KEY', NO_NAMES)).toBeNull();
  });

  it('refuses a row with no value anywhere', () => {
    expect(draftProblem(draft({ name: 'API_KEY' }), 'API_KEY', NO_NAMES)).toEqual({
      field: 'value',
      message: 'Enter a value.',
    });
  });

  it('reports this environment’s own bad value with no slug', () => {
    // `undefined` is how the row knows the message belongs under the box for
    // the environment the page is about.
    const row = draft({ name: 'PORT', value: 'abc', valueType: 'int' });
    const problem = draftProblem(row, 'PORT', NO_NAMES);

    expect(problem?.field).toBe('value');
    expect(problem?.slug).toBeUndefined();
  });

  it('names the environment whose value is the wrong shape', () => {
    // The bug: this used to check every value in one loop and report the
    // failure against this environment's field, which was showing a perfectly
    // good integer.
    const row = draft({
      name: 'PORT',
      value: '8080',
      valueType: 'int',
      extraValues: { production: 'not-a-number' },
    });
    const problem = draftProblem(row, 'PORT', NO_NAMES);

    expect(problem?.field).toBe('value');
    expect(problem?.slug).toBe('production');
  });

  it('blocks a name the target environment already holds, before the 409', () => {
    const row = draft({ name: 'API_KEY', extraValues: { production: 'x' } });
    const problem = draftProblem(row, 'API_KEY', NO_NAMES, [
      claims({ claimed: new Set(['API_KEY']) }),
    ]);

    expect(problem?.slug).toBe('production');
    expect(problem?.message).toMatch(/Production already has a secret called API_KEY/);
  });

  it('says nothing about a name taken only in an environment this row skips', () => {
    // Production holding `API_KEY` is not a problem for a row that writes to
    // staging. That is what environments are.
    const row = draft({ name: 'API_KEY', extraValues: { staging: 'x' } });
    expect(
      draftProblem(row, 'API_KEY', NO_NAMES, [claims({ claimed: new Set(['API_KEY']) })]),
    ).toBeNull();
  });

  it('still refuses a name this environment already holds', () => {
    const row = draft({ name: 'API_KEY', value: 'x' });
    expect(draftProblem(row, 'API_KEY', new Set(['API_KEY']))).toEqual({
      field: 'name',
      message: 'That name is already taken in this environment.',
    });
  });
});

describe('describeWriteFailure', () => {
  const conflict = new ApiError({
    code: 'conflict',
    message: 'already exists',
    status: 409,
    requestId: null,
  });

  it('names the environment that refused', () => {
    // A compared write is a write to somewhere else. "This environment" on a
    // page about dev, describing a 409 from production, is a sentence that
    // sends somebody to check the wrong environment by hand.
    expect(describeWriteFailure(conflict, 'Production').message).toBe(
      'A secret with this name already exists in Production.',
    );
  });

  it('falls back to the environment the page is about', () => {
    expect(describeWriteFailure(conflict).message).toBe(
      'A secret with this name already exists in this environment.',
    );
  });

  it('keeps nothing from a non-API failure', () => {
    // An arbitrary exception's message may have been built from the request
    // payload, which on this path is a credential.
    expect(describeWriteFailure(new Error('postgres://user:hunter2@host'))).toEqual({
      field: 'value',
      message: 'Could not save this secret.',
    });
  });
});

/**
 * The reveal window, enforced where the plaintext actually is.
 *
 * `dropSeeds` backs both the sweep and `forgetSeeds`, so an editor has to come
 * out of it the same way whichever one ran. What it must never do is take work
 * the user has not saved.
 */
describe('isTouched', () => {
  const OPENED = 'postgres://localhost/app';

  it('counts an emptied seeded editor as the user at work', () => {
    // The distinction the whole function exists for. Selecting all and deleting,
    // on the way to pasting a replacement, writes nothing — an empty value is not
    // a value — but the editor must not then behave as though it were untouched
    // and close while somebody is in their password manager.
    const emptied = edit({ value: '', baseline: OPENED });
    expect(isTouched(emptied)).toBe(true);
    expect(hasNewValue(emptied)).toBe(false);
  });

  it('leaves an editor opened and not typed in untouched', () => {
    expect(isTouched(edit({ value: OPENED, baseline: OPENED }))).toBe(false);
  });

  it('counts a typed value as work whether or not it was seeded', () => {
    expect(isTouched(edit({ value: 'new', baseline: OPENED }))).toBe(true);
    // Never seeded: an editor on a row whose value was never revealed.
    expect(isTouched(edit({ value: 'new' }))).toBe(true);
  });

  it('leaves an empty editor that was never seeded untouched', () => {
    // Nothing was put there and nothing was taken away.
    expect(isTouched(edit({ value: '' }))).toBe(false);
  });
});

describe('dropSeeds', () => {
  const ALL = () => true;
  const SEEDED = { value: 'postgres://old', baseline: 'postgres://old', seededAt: 1_000 };

  it('leaves an editor whose seed has not expired alone', () => {
    const edits = new Map([['DATABASE_URL', edit(SEEDED)]]);
    expect(dropSeeds(edits, () => false)).toBeNull();
  });

  it('drops an expired editor nobody typed into', () => {
    // Opened to read a value and left open: that is a reveal wearing a different
    // shape, and it forgets on the same schedule.
    const edits = new Map([['DATABASE_URL', edit(SEEDED)]]);
    const next = dropSeeds(edits, ALL);
    expect(next?.has('DATABASE_URL')).toBe(false);
  });

  it('keeps a staged rename while dropping the seed under it', () => {
    const edits = new Map([['DATABASE_URL', edit({ ...SEEDED, name: 'DB_URL' })]]);
    const kept = dropSeeds(edits, ALL)?.get('DATABASE_URL');

    expect(kept?.name).toBe('DB_URL');
    expect(kept?.value).toBe('');
    expect(kept?.baseline).toBeUndefined();
    expect(kept?.seededAt).toBeUndefined();
  });

  it('keeps what the user typed and drops only the credential under it', () => {
    const edits = new Map([['DATABASE_URL', edit({ ...SEEDED, value: 'postgres://new' })]]);
    const kept = dropSeeds(edits, ALL)?.get('DATABASE_URL');

    expect(kept?.value).toBe('postgres://new');
    expect(kept?.baseline).toBeUndefined();
    expect(kept?.seededAt).toBeUndefined();
  });

  it('does not close an editor the user has emptied', () => {
    // Selecting all and deleting, on the way to pasting a replacement, is the
    // user at work — `isTouched`, not `hasNewValue`. Asking the narrower
    // question here deleted the entry, which closed the box and remasked the
    // row while somebody was in their password manager fetching the new value.
    const edits = new Map([['DATABASE_URL', edit({ ...SEEDED, value: '' })]]);
    expect(dropSeeds(edits, ALL)).toBeNull();
  });
});
