import { describe, expect, it } from 'vitest';
import {
  affectedContexts,
  checkContexts,
  checkEnvironment,
  contextsReferencing,
  descendantsOf,
  environmentView,
  escapeTemplateText,
  formatReference,
  inheritanceChain,
  lookupInView,
  MAX_INHERITANCE_DEPTH,
  MAX_REFERENCE_DEPTH,
  MAX_REFERENCES_PER_SECRET,
  parseTemplate,
  planResolution,
  referenceKey,
  resolveEnvironment,
  ResolutionError,
  sameReferenceSet,
  templateReferences,
  TemplateSyntaxError,
  withParent,
  withSecret,
} from './index';
import type { DeclaredReference, GraphEnvironment, ReferenceGraph, ValuedSecret } from './index';

/* ── fixtures ────────────────────────────────────────────────────────────── */

type Env = GraphEnvironment<ValuedSecret>;

let counter = 0;
const id = (prefix: string): string => `${prefix}-${(counter += 1)}`;

/** A plain value. */
function value(text: string): ValuedSecret {
  return { id: id('s'), template: false, references: [], value: text };
}

/**
 * A template whose declaration is derived from its text, the way an honest
 * client derives it, with qualified references pointed at environment ids.
 */
function template(text: string, targets: Record<string, string> = {}): ValuedSecret {
  const references: DeclaredReference[] = templateReferences(text).map((reference) => {
    if (reference.environment === undefined) return { ...reference, environmentId: null };
    const key = referenceKey(reference);
    const environmentId = targets[key.slice(0, key.lastIndexOf('.'))];
    if (environmentId === undefined) throw new Error(`fixture: no target for ${key}`);
    return { ...reference, environmentId };
  });
  return { id: id('t'), template: true, references, value: text };
}

function env(
  envId: string,
  parentId: string | null,
  secrets: Record<string, ValuedSecret>,
): [string, Env] {
  return [envId, { id: envId, parentId, secrets: new Map(Object.entries(secrets)) }];
}

function graph(...environments: [string, Env][]): ReferenceGraph<ValuedSecret> {
  return new Map(environments);
}

function resolutionError(run: () => unknown): ResolutionError {
  try {
    run();
  } catch (error) {
    if (error instanceof ResolutionError) return error;
    throw error;
  }
  throw new Error('expected a ResolutionError');
}

/* ── the template grammar ─────────────────────────────────────────────────── */

describe('parseTemplate', () => {
  it('reads text, and all three reference forms', () => {
    expect(parseTemplate('postgres://${DB_USER}@${shared.DB_HOST}/${core.prod.DB_NAME}')).toEqual([
      { kind: 'text', text: 'postgres://' },
      { kind: 'reference', reference: { name: 'DB_USER' } },
      { kind: 'text', text: '@' },
      { kind: 'reference', reference: { environment: 'shared', name: 'DB_HOST' } },
      { kind: 'text', text: '/' },
      { kind: 'reference', reference: { project: 'core', environment: 'prod', name: 'DB_NAME' } },
    ]);
  });

  it('treats $${ as a literal ${, and a lone $ as a dollar', () => {
    expect(parseTemplate('cost $5, literal $${HOME}, and ${A}')).toEqual([
      { kind: 'text', text: 'cost $5, literal ${HOME}, and ' },
      { kind: 'reference', reference: { name: 'A' } },
    ]);
    expect(parseTemplate('$$ and $')).toEqual([{ kind: 'text', text: '$$ and $' }]);
  });

  it('parses an empty template to nothing', () => {
    expect(parseTemplate('')).toEqual([]);
  });

  it('takes the environment grammar for an environment and the project grammar for a project', () => {
    // Environment slugs may hold an underscore; project slugs may not.
    expect(parseTemplate('${review_app.KEY}')).toEqual([
      { kind: 'reference', reference: { environment: 'review_app', name: 'KEY' } },
    ]);
    expect(parseTemplate('${core.eu_west.KEY}')).toEqual([
      { kind: 'reference', reference: { project: 'core', environment: 'eu_west', name: 'KEY' } },
    ]);
    expect(() => parseTemplate('${my_project.prod.KEY}')).toThrow(TemplateSyntaxError);
  });

  it.each([
    ['an unterminated reference', 'a ${KEY'],
    ['an empty reference', '${}'],
    ['whitespace inside a reference', '${ KEY }'],
    ['four parts', '${a.b.c.KEY}'],
    ['a name that starts with a digit', '${1KEY}'],
    ['an uppercase slug', '${Staging.KEY}'],
    ['an empty part', '${staging..KEY}'],
  ])('refuses %s, at the offset of the ${', (_label, text) => {
    expect(() => parseTemplate(text)).toThrow(TemplateSyntaxError);
    try {
      parseTemplate(text);
    } catch (error) {
      expect((error as TemplateSyntaxError).offset).toBe(text.indexOf('${'));
    }
  });

  it('never puts any part of the value in the error', () => {
    const secret = 'hunter2-correct-horse';
    try {
      parseTemplate(`${secret} \${not valid}`);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain('not valid');
    }
  });
});

describe('templateReferences', () => {
  it('lists each reference once, in order of first appearance', () => {
    expect(templateReferences('${B}${A}${B}${x.A}')).toEqual([
      { name: 'B' },
      { name: 'A' },
      { environment: 'x', name: 'A' },
    ]);
  });

  it('refuses more references than a template may hold', () => {
    const text = Array.from(
      { length: MAX_REFERENCES_PER_SECRET + 1 },
      (_, index) => `\${K${index}}`,
    ).join('');
    expect(() => templateReferences(text)).toThrow(TemplateSyntaxError);
    expect(templateReferences(text.slice(0, text.lastIndexOf('${'))).length).toBe(
      MAX_REFERENCES_PER_SECRET,
    );
  });
});

describe('reference identity', () => {
  it('formats and keys each form', () => {
    expect(referenceKey({ name: 'K' })).toBe('K');
    expect(referenceKey({ environment: 'e', name: 'K' })).toBe('e.K');
    expect(referenceKey({ project: 'p', environment: 'e', name: 'K' })).toBe('p.e.K');
    expect(formatReference({ project: 'p', environment: 'e', name: 'K' })).toBe('${p.e.K}');
  });

  it('compares declarations as sets', () => {
    expect(sameReferenceSet([{ name: 'A' }, { name: 'B' }], [{ name: 'B' }, { name: 'A' }])).toBe(
      true,
    );
    expect(sameReferenceSet([{ name: 'A' }], [{ name: 'A' }, { name: 'A' }])).toBe(true);
    expect(sameReferenceSet([{ name: 'A' }], [{ environment: 'e', name: 'A' }])).toBe(false);
    expect(sameReferenceSet([{ name: 'A' }], [{ name: 'A' }, { name: 'B' }])).toBe(false);
  });

  it('escapes literal text so it survives a parse', () => {
    for (const text of ['${HOME}', '$${x}', 'a $ b ${', '$$${A}']) {
      const parsed = parseTemplate(escapeTemplateText(text));
      expect(parsed).toEqual(text === '' ? [] : [{ kind: 'text', text }]);
    }
  });
});

/* ── inheritance ─────────────────────────────────────────────────────────── */

describe('inheritance', () => {
  const g = graph(
    env('base', null, { HOST: value('base.example'), PORT: value('5432'), ONLY_BASE: value('b') }),
    env('staging', 'base', { HOST: value('staging.example') }),
    env('review', 'staging', { PORT: value('6543') }),
  );

  it('lays a child over its parent: overrides win, unset names fall through', () => {
    expect([...resolveEnvironment(g, 'review')]).toEqual([
      ['HOST', 'staging.example'],
      ['ONLY_BASE', 'b'],
      ['PORT', '6543'],
    ]);
    expect(lookupInView(g, 'review', 'HOST')?.environment.id).toBe('staging');
    expect(lookupInView(g, 'review', 'MISSING')).toBeUndefined();
  });

  it('lists the chain nearest first', () => {
    expect(inheritanceChain(g, 'review').map((entry) => entry.id)).toEqual([
      'review',
      'staging',
      'base',
    ]);
  });

  it('refuses a chain that loops', () => {
    const looped = graph(env('a', 'b', {}), env('b', 'a', {}));
    expect(resolutionError(() => inheritanceChain(looped, 'a')).kind).toBe('inheritanceCycle');
  });

  it(`allows ${MAX_INHERITANCE_DEPTH} ancestors and refuses one more`, () => {
    const chain = (length: number) =>
      graph(
        ...Array.from({ length: length + 1 }, (_, index) =>
          env(`e${index}`, index === length ? null : `e${index + 1}`, {}),
        ),
      );
    expect(inheritanceChain(chain(MAX_INHERITANCE_DEPTH), 'e0')).toHaveLength(
      MAX_INHERITANCE_DEPTH + 1,
    );
    expect(
      resolutionError(() => inheritanceChain(chain(MAX_INHERITANCE_DEPTH + 1), 'e0')).kind,
    ).toBe('inheritanceTooDeep');
  });

  it('refuses a parent the graph does not hold, and names it', () => {
    const error = resolutionError(() => inheritanceChain(graph(env('a', 'gone', {})), 'a'));
    expect(error.kind).toBe('missingEnvironment');
    expect(error.missingEnvironmentId).toBe('gone');
  });

  it('sorts the view by code unit, not by locale', () => {
    const sorted = graph(env('x', null, { b: value('1'), B: value('2'), a: value('3') }));
    expect([...environmentView(sorted, 'x').keys()]).toEqual(['B', 'a', 'b']);
  });
});

/* ── references ──────────────────────────────────────────────────────────── */

describe('references', () => {
  it('resolves an unqualified reference in the environment being read', () => {
    // The whole reason a template goes in a parent: `base` writes the shape of
    // the URL once, and each child's own HOST fills it in.
    const g = graph(
      env('base', null, {
        HOST: value('base.example'),
        URL: template('postgres://${HOST}/app'),
      }),
      env('staging', 'base', { HOST: value('staging.example') }),
    );

    expect(resolveEnvironment(g, 'base').get('URL')).toBe('postgres://base.example/app');
    expect(resolveEnvironment(g, 'staging').get('URL')).toBe('postgres://staging.example/app');
  });

  it("resolves a qualified reference in the target's own view", () => {
    const g = graph(
      env('shared-root', null, { REGION: value('eu-west-1') }),
      env('shared', 'shared-root', { DB_HOST: template('db.${REGION}.internal') }),
      env('app', null, {
        REGION: value('us-east-1'),
        URL: template('${shared.DB_HOST}', { shared: 'shared' }),
      }),
    );

    // `REGION` inside the referenced template is `shared`'s, not `app`'s.
    expect(resolveEnvironment(g, 'app').get('URL')).toBe('db.eu-west-1.internal');
  });

  it('leaves the text of a non-template alone, references and all', () => {
    const g = graph(env('e', null, { SCRIPT: value('echo ${HOME}'), HOME: value('/root') }));
    expect(resolveEnvironment(g, 'e').get('SCRIPT')).toBe('echo ${HOME}');
  });

  it('renders an escaped ${ in a template as a literal', () => {
    const g = graph(env('e', null, { A: value('1'), T: template('${A} and $${A}') }));
    expect(resolveEnvironment(g, 'e').get('T')).toBe('1 and ${A}');
  });

  it('refuses a cycle and names every hop', () => {
    const g = graph(
      env('e', null, { A: template('${B}'), B: template('x${C}'), C: template('${A}') }),
    );
    const error = resolutionError(() => resolveEnvironment(g, 'e'));
    expect(error.kind).toBe('cycle');
    expect(error.message).toContain('A → B → C → A');
  });

  it('refuses a secret that refers to itself', () => {
    const g = graph(env('e', null, { A: template('a${A}') }));
    expect(resolutionError(() => checkEnvironment(g, 'e')).kind).toBe('cycle');
  });

  it('refuses a cycle that only exists through inheritance', () => {
    // Harmless in `base` (URL → HOST, a value). In `child`, HOST is overridden
    // by a template pointing back at URL — which is base's template, read as
    // the child sees it.
    const g = graph(
      env('base', null, { HOST: value('h'), URL: template('${HOST}') }),
      env('child', 'base', { HOST: template('${URL}') }),
    );
    expect(() => checkEnvironment(g, 'base')).not.toThrow();
    expect(resolutionError(() => checkEnvironment(g, 'child')).kind).toBe('cycle');
  });

  it('refuses a cycle across environments', () => {
    const g = graph(
      env('a', null, { X: template('${b.Y}', { b: 'b' }) }),
      env('b', null, { Y: template('${a.X}', { a: 'a' }) }),
    );
    expect(resolutionError(() => checkEnvironment(g, 'a')).kind).toBe('cycle');
  });

  it(`follows ${MAX_REFERENCE_DEPTH} hops and refuses a sixth`, () => {
    const chain = (hops: number) => {
      const secrets: Record<string, ValuedSecret> = { [`K${hops}`]: value('end') };
      for (let index = 0; index < hops; index += 1) {
        secrets[`K${index}`] = template(`\${K${index + 1}}`);
      }
      return graph(env('e', null, secrets));
    };

    expect(resolveEnvironment(chain(MAX_REFERENCE_DEPTH), 'e').get('K0')).toBe('end');
    expect(
      resolutionError(() => resolveEnvironment(chain(MAX_REFERENCE_DEPTH + 1), 'e')).kind,
    ).toBe('tooDeep');
  });

  it('measures depth through a node it has already finished, not only on first sight', () => {
    // `SHORT` reaches `K1` at depth 1 and finishes it (height 4, legal). `LONG`
    // reaches the same `K1` at depth 3, where 3 + 4 is past the limit. A memo
    // that only recorded "done" would skip `K1` the second time and let LONG
    // through at seven hops.
    const secrets: Record<string, ValuedSecret> = { K5: value('end') };
    for (let index = 1; index < 5; index += 1) {
      secrets[`K${index}`] = template(`\${K${index + 1}}`);
    }
    secrets['A_SHORT'] = template('${K1}');
    secrets['B_LONG'] = template('${L1}');
    secrets['L1'] = template('${L2}');
    secrets['L2'] = template('${K1}');

    const error = resolutionError(() => checkEnvironment(graph(env('e', null, secrets)), 'e'));
    expect(error.kind).toBe('tooDeep');
  });

  it('resolves a diamond once and identically on both sides', () => {
    const g = graph(
      env('e', null, {
        LEAF: value('v'),
        LEFT: template('${LEAF}-l'),
        RIGHT: template('${LEAF}-r'),
        TOP: template('${LEFT}+${RIGHT}'),
      }),
    );
    expect(resolveEnvironment(g, 'e').get('TOP')).toBe('v-l+v-r');
  });

  it('refuses a reference nothing in the view sets', () => {
    const g = graph(env('e', null, { A: template('${NOWHERE}') }));
    const error = resolutionError(() => checkEnvironment(g, 'e'));
    expect(error.kind).toBe('unresolved');
    expect(error.message).toContain('NOWHERE');
  });

  it('refuses a reference into an environment the graph does not hold', () => {
    const g = graph(env('e', null, { A: template('${gone.K}', { gone: 'gone' }) }));
    const error = resolutionError(() => checkEnvironment(g, 'e'));
    expect(error.kind).toBe('missingEnvironment');
    expect(error.missingEnvironmentId).toBe('gone');
  });

  it('refuses a template whose text holds a reference it did not declare', () => {
    const forged: ValuedSecret = { id: 'x', template: true, references: [], value: '${B}' };
    const g = graph(env('e', null, { A: forged, B: value('b') }));
    expect(resolutionError(() => resolveEnvironment(g, 'e')).kind).toBe('undeclared');
  });

  it('refuses a template that declared a reference its text does not hold', () => {
    const forged: ValuedSecret = {
      id: 'x',
      template: true,
      references: [{ name: 'B', environmentId: null }],
      value: 'plain',
    };
    const g = graph(env('e', null, { A: forged, B: value('b') }));
    expect(resolutionError(() => resolveEnvironment(g, 'e')).kind).toBe('undeclared');
  });

  it('reports a template that will not parse as a syntax error, without its text', () => {
    const broken: ValuedSecret = {
      id: 'x',
      template: true,
      references: [{ name: 'B', environmentId: null }],
      value: 'secret-ish ${B',
    };
    const g = graph(env('e', null, { A: broken, B: value('b') }));
    const error = resolutionError(() => resolveEnvironment(g, 'e'));
    expect(error.kind).toBe('syntax');
    expect(error.message).not.toContain('secret-ish');
  });

  it('never puts a value in any resolution error', () => {
    const g = graph(
      env('e', null, { A: template('top-secret-${B}'), B: template('${A}-also-secret') }),
    );
    const error = resolutionError(() => resolveEnvironment(g, 'e'));
    expect(error.message).not.toContain('secret');
  });
});

/* ── the write-time checks ────────────────────────────────────────────────── */

describe('write-time checks', () => {
  const g = graph(
    env('base', null, { HOST: value('h'), URL: template('${HOST}') }),
    env('staging', 'base', {}),
    env('review', 'staging', {}),
    env('other', null, { REMOTE: template('${staging.HOST}', { staging: 'staging' }) }),
    env('unrelated', null, { X: value('x') }),
  );

  it('finds every descendant, however deep', () => {
    expect(descendantsOf(g, 'base').sort()).toEqual(['review', 'staging']);
    expect(descendantsOf(g, 'review')).toEqual([]);
  });

  it('finds the contexts that can see a template pointing into a set', () => {
    expect(contextsReferencing(g, new Set(['staging']))).toEqual(['other']);
    expect(contextsReferencing(g, new Set(['unrelated']))).toEqual([]);
  });

  it('affects the environment, its descendants, and what points into them', () => {
    expect(affectedContexts(g, 'base').sort()).toEqual(['base', 'other', 'review', 'staging']);
    expect(affectedContexts(g, 'unrelated')).toEqual(['unrelated']);
  });

  it('refuses a deletion that would leave a template dangling, through any context', () => {
    // Deleting base's HOST breaks base's URL — and `other`, which reads HOST
    // through staging's view, which inherits it.
    const without = withSecret(g, 'base', 'HOST', null);
    expect(resolutionError(() => checkContexts(without, affectedContexts(g, 'base'))).kind).toBe(
      'unresolved',
    );
  });

  it('allows a deletion a parent still covers', () => {
    const shadowed = withSecret(g, 'staging', 'HOST', value('staging-host'));
    const without = withSecret(shadowed, 'staging', 'HOST', null);
    expect(() => checkContexts(without, affectedContexts(shadowed, 'staging'))).not.toThrow();
  });

  it('refuses a new parent that closes a loop', () => {
    const looped = withParent(g, 'base', 'review');
    expect(resolutionError(() => checkContexts(looped, ['base'])).kind).toBe('inheritanceCycle');
  });

  it('checks a hypothetical without touching the original', () => {
    withSecret(g, 'base', 'HOST', null);
    withParent(g, 'base', 'review');
    expect(g.get('base')?.secrets.has('HOST')).toBe(true);
    expect(g.get('base')?.parentId).toBeNull();
    expect(withSecret(g, 'missing', 'X', null)).toBe(g);
    expect(withParent(g, 'missing', null)).toBe(g);
  });
});

/* ── what a pull carries ──────────────────────────────────────────────────── */

describe('planResolution', () => {
  it('carries the whole chain and only the referenced secrets from elsewhere', () => {
    const g = graph(
      env('shared-root', null, { REGION: value('eu'), UNRELATED: value('u') }),
      env('shared', 'shared-root', { DB_HOST: template('db.${REGION}'), NOISE: value('n') }),
      env('base', null, { A: value('a') }),
      env('app', 'base', { URL: template('${shared.DB_HOST}', { shared: 'shared' }) }),
    );

    const plan = planResolution(g, 'app');
    expect(plan.chain).toEqual(['base']);
    expect(
      [...plan.referenced.entries()]
        .map(([key, names]) => [key, [...names]])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ).toEqual([
      ['shared', ['DB_HOST']],
      ['shared-root', ['REGION']],
    ]);
    expect([...plan.contexts].sort()).toEqual(['shared', 'shared-root']);
    expect(plan.visited.map((node) => node.name).sort()).toEqual(['DB_HOST', 'REGION', 'URL']);
  });

  it('carries a referenced context’s chain to the root, past the layer that answered', () => {
    // `shared` takes DB_HOST from its parent `mid`, which itself has a parent.
    // The client walks `shared`'s whole chain to repeat the lookup, so `top`
    // must travel too, even though it contributes nothing.
    const g = graph(
      env('top', null, { OTHER: value('o') }),
      env('mid', 'top', { DB_HOST: value('db') }),
      env('shared', 'mid', {}),
      env('app', null, { URL: template('${shared.DB_HOST}', { shared: 'shared' }) }),
    );

    const plan = planResolution(g, 'app');
    expect([...plan.contexts].sort()).toEqual(['mid', 'shared', 'top']);
    expect([...(plan.referenced.get('mid') ?? [])]).toEqual(['DB_HOST']);
    expect(plan.referenced.has('top')).toBe(false);

    // And what was carried is enough: the subgraph of the plan resolves.
    const carried = new Map(
      [...g].filter(([key]) => key === 'app' || plan.contexts.has(key) || plan.chain.includes(key)),
    );
    expect(resolveEnvironment(carried, 'app').get('URL')).toBe('db');
  });

  it('carries nothing extra for an environment that needs nothing', () => {
    const plan = planResolution(graph(env('e', null, { A: value('a') })), 'e');
    expect(plan.chain).toEqual([]);
    expect(plan.referenced.size).toBe(0);
    expect(plan.contexts.size).toBe(0);
  });
});
