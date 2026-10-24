import { describe, expect, it } from 'vitest';

import { referencesFor } from '@/components/envkeys/secret-io';
import { crossesTemplateBoundary, describeReference, readTemplate } from './template-references';

/**
 * What a template value field shows as it is typed, and what a write of it
 * declares — which have to be the same list, or the person checks one thing
 * and the server is told another.
 */

describe('readTemplate', () => {
  it('says nothing for a value that is not a template, or an empty one', () => {
    expect(readTemplate('${HOME}', 'string')).toEqual({ kind: 'none' });
    expect(readTemplate('', 'template')).toEqual({ kind: 'none' });
  });

  it('lists each distinct reference once, in order of first appearance', () => {
    const reading = readTemplate(
      'postgres://${DB_USER}:${DB_PASSWORD}@${shared.DB_HOST}/${core.prod.DB_NAME}?u=${DB_USER}',
      'template',
    );
    expect(reading.kind).toBe('references');
    if (reading.kind !== 'references') return;
    expect(reading.references.map((entry) => entry.written)).toEqual([
      '${DB_USER}',
      '${DB_PASSWORD}',
      '${shared.DB_HOST}',
      '${core.prod.DB_NAME}',
    ]);
  });

  it('reads `$${` as a literal, never as a reference', () => {
    const reading = readTemplate('literal $${HOME} and ${REAL}', 'template');
    expect(
      reading.kind === 'references' && reading.references.map((entry) => entry.written),
    ).toEqual(['${REAL}']);
  });

  it('accepts a template with no references at all', () => {
    expect(readTemplate('plain text', 'template')).toEqual({ kind: 'references', references: [] });
  });

  it('reports a syntax error with its offset, and never quotes the value', () => {
    const reading = readTemplate('hunter2 ${not valid}', 'template');
    expect(reading.kind).toBe('invalid');
    if (reading.kind !== 'invalid') return;
    expect(reading.offset).toBe(8);
    expect(reading.message).not.toContain('hunter2');

    const unclosed = readTemplate('sk_live_x ${KEY', 'template');
    expect(unclosed.kind).toBe('invalid');
    expect(JSON.stringify(unclosed)).not.toContain('sk_live_x');
  });

  it('describes where each kind of reference resolves', () => {
    expect(describeReference({ name: 'KEY' })).toMatch(/as the environment being read sees it/);
    expect(describeReference({ environment: 'staging', name: 'KEY' })).toBe(
      'KEY in staging, in this project',
    );
    expect(describeReference({ project: 'core', environment: 'prod', name: 'KEY' })).toBe(
      'KEY in core/prod',
    );
  });
});

describe('referencesFor — what a write declares', () => {
  it('declares exactly the list the field shows', () => {
    const value = 'a=${A} b=${env.B} c=${proj.env.C} again=${A}';
    const reading = readTemplate(value, 'template');
    const declared = referencesFor('template', value).references;
    expect(declared).toEqual([
      { name: 'A' },
      { environment: 'env', name: 'B' },
      { project: 'proj', environment: 'env', name: 'C' },
    ]);
    expect(
      reading.kind === 'references' && reading.references.map((entry) => entry.reference),
    ).toEqual(declared);
  });

  it('declares nothing for any other type, however much `${…}` the text holds', () => {
    expect(referencesFor('string', '${A}')).toEqual({});
    expect(referencesFor(undefined, '${A}')).toEqual({});
  });

  it('refuses to declare a template that does not parse', () => {
    expect(() => referencesFor('template', 'broken ${')).toThrow();
  });
});

describe('crossesTemplateBoundary', () => {
  it('is true exactly when a value becomes, or stops being, a template', () => {
    expect(crossesTemplateBoundary('string', 'template')).toBe(true);
    expect(crossesTemplateBoundary('template', 'url')).toBe(true);
    expect(crossesTemplateBoundary('string', 'int')).toBe(false);
    expect(crossesTemplateBoundary('template', 'template')).toBe(false);
  });
});
