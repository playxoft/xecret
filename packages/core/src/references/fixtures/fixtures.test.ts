import { describe, expect, it } from 'vitest';
import {
  MAX_INHERITANCE_DEPTH,
  MAX_REFERENCE_DEPTH,
  parseTemplate,
  resolveEnvironment,
  ResolutionError,
  TemplateSyntaxError,
} from '../index';
import type { DeclaredReference, GraphEnvironment, ValuedSecret } from '../index';
import fixtures from './resolution-fixtures.json';

/**
 * The shared fixtures, read by this suite and by the Go CLI's
 * (`cli/internal/references`), so that the browser and the CLI resolve a
 * template the same way — the property that matters, because a value resolved
 * one way in the dashboard's preview and another in `xecret run` is a bug
 * nobody would find until a deploy.
 */

interface FixtureSecret {
  value: string;
  template?: boolean;
  references?: DeclaredReference[];
}

interface FixtureEnvironment {
  id: string;
  parentId: string | null;
  secrets: Record<string, FixtureSecret>;
}

interface ResolveCase {
  name: string;
  context: string;
  environments: FixtureEnvironment[];
  expected?: Record<string, string>;
  error?: string;
}

interface ParseCase {
  template: string;
  segments?: ({ text: string } | { reference: Record<string, string> })[];
  error?: string;
}

describe('the shared resolution fixtures', () => {
  it('state the limits this implementation enforces', () => {
    expect(fixtures.maxReferenceDepth).toBe(MAX_REFERENCE_DEPTH);
    expect(fixtures.maxInheritanceDepth).toBe(MAX_INHERITANCE_DEPTH);
  });

  it.each(fixtures.parse as ParseCase[])('parses $template', (testCase) => {
    if (testCase.error !== undefined) {
      expect(() => parseTemplate(testCase.template)).toThrow(TemplateSyntaxError);
      return;
    }
    const segments = parseTemplate(testCase.template).map((segment) =>
      segment.kind === 'text' ? { text: segment.text } : { reference: { ...segment.reference } },
    );
    expect(segments).toEqual(testCase.segments);
  });

  it.each(fixtures.resolve as ResolveCase[])('$name', (testCase) => {
    const graph = new Map<string, GraphEnvironment<ValuedSecret>>(
      testCase.environments.map((environment) => [
        environment.id,
        {
          id: environment.id,
          parentId: environment.parentId,
          secrets: new Map(
            Object.entries(environment.secrets).map(([name, secret]) => [
              name,
              {
                id: `${environment.id}:${name}`,
                value: secret.value,
                template: secret.template === true,
                references: secret.references ?? [],
              },
            ]),
          ),
        },
      ]),
    );

    if (testCase.error !== undefined) {
      try {
        resolveEnvironment(graph, testCase.context);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ResolutionError);
        expect((error as ResolutionError).kind).toBe(testCase.error);
      }
      return;
    }
    expect(Object.fromEntries(resolveEnvironment(graph, testCase.context))).toEqual(
      testCase.expected,
    );
  });
});
