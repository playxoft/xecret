import {
  MAX_INHERITANCE_DEPTH,
  MAX_REFERENCE_DEPTH,
  parseTemplate,
  referenceKey,
} from './template';
import type { SecretReference } from './template';

/**
 * Inheritance and reference resolution, as one traversal shared by every party.
 *
 * ── The resolution order, written down (P19 §1) ──
 *
 *  1. **An environment's view** is its own secrets laid over its parent's view,
 *     recursively: a child's value overrides, a name the child does not set falls
 *     through to the nearest ancestor that does. The chain is at most
 *     {@link MAX_INHERITANCE_DEPTH} ancestors long and may not loop.
 *  2. **A non-template secret** resolves to its value, verbatim.
 *  3. **A template** resolves to its text with every reference replaced:
 *       - `${KEY}` by KEY in the view of the environment **being read** — so a
 *         template inherited from `base` sees the child's overrides, which is
 *         the point of putting a template in a parent;
 *       - `${env.KEY}` and `${project.env.KEY}` by KEY in the view of that
 *         environment, resolved as if that environment were being read.
 *  4. **References nest** up to {@link MAX_REFERENCE_DEPTH} hops, and a loop is
 *     an error, never an infinite expansion.
 *
 * ── Who runs this ──
 * Three callers, one algorithm. The server walks it over *metadata* — names and
 * the references each template declared, never a value — to refuse a cycle, a
 * dangling reference or an over-deep chain **before it is stored**, and to work
 * out which ciphertexts a pull must carry. The dashboard and the Go CLI walk it
 * over decrypted values to produce the bundle `xecret run` injects. A cycle
 * found by the server is a validation error at write time; the same cycle found
 * by a client is the backstop for a state the server should never have allowed,
 * and is reported as an error rather than resolved partially — a partial
 * environment injected into a process is worse than none.
 */

/**
 * Where a declared reference points, once its slugs have been resolved.
 *
 * `environmentId: null` is an unqualified `${KEY}`: it means "the environment
 * being read", which is only known at resolution time and is exactly why it is
 * not stored as an id.
 */
export interface ReferenceTarget {
  readonly environmentId: string | null;
  readonly name: string;
}

/** A reference as a writer declared it: the text it wrote, and where that points. */
export interface DeclaredReference extends SecretReference, ReferenceTarget {}

/** What the traversal needs to know about one secret. */
export interface GraphSecret {
  readonly id: string;
  /** Only a template's text is read for references; anything else is literal. */
  readonly template: boolean;
  /** The references the writer declared. Empty for a non-template. */
  readonly references: readonly DeclaredReference[];
}

export interface GraphEnvironment<S extends GraphSecret = GraphSecret> {
  readonly id: string;
  readonly parentId: string | null;
  /** The environment's own secrets, by name. Inherited ones are not repeated here. */
  readonly secrets: ReadonlyMap<string, S>;
}

/** Every environment a resolution may touch, by id. */
export type ReferenceGraph<S extends GraphSecret = GraphSecret> = ReadonlyMap<
  string,
  GraphEnvironment<S>
>;

export type ResolutionErrorKind =
  /** An environment's parent chain returns to itself. */
  | 'inheritanceCycle'
  /** An environment has more than `MAX_INHERITANCE_DEPTH` ancestors. */
  | 'inheritanceTooDeep'
  /** A chain or a reference names an environment this graph does not hold. */
  | 'missingEnvironment'
  /** A reference names a secret the target view does not hold. */
  | 'unresolved'
  /** Following references returns to a secret already being resolved. */
  | 'cycle'
  /** More than `MAX_REFERENCE_DEPTH` hops. */
  | 'tooDeep'
  /** A template's text holds a reference its declaration does not, or the reverse. */
  | 'undeclared'
  /** A template's text is not valid template syntax. */
  | 'syntax';

/**
 * Why a resolution failed.
 *
 * Carries reference keys and secret names — identifiers the caller can already
 * list — and never a value. `path` is the chain of `environmentId:NAME` nodes
 * that led here, so a cycle report can name every hop.
 */
export class ResolutionError extends Error {
  constructor(
    readonly kind: ResolutionErrorKind,
    message: string,
    readonly path: readonly string[] = [],
    /**
     * For `missingEnvironment`: the environment the graph did not hold. A
     * caller building the graph lazily loads it and tries again; one holding
     * the whole graph reports it.
     */
    readonly missingEnvironmentId: string | null = null,
  ) {
    super(message);
    this.name = 'ResolutionError';
  }
}

/** One node of a resolution: a name, as one environment sees it. */
export interface VisitedSecret {
  /** The environment whose view the name was looked up in. */
  readonly contextId: string;
  readonly name: string;
  /** The environment whose own secret it turned out to be. */
  readonly definedIn: string;
  readonly secretId: string;
}

/**
 * The parent chain of an environment, nearest first and including itself.
 *
 * Refuses a loop and a chain past the depth limit rather than truncating it:
 * a truncated chain is a view with names silently missing.
 */
export function inheritanceChain<S extends GraphSecret>(
  graph: ReferenceGraph<S>,
  environmentId: string,
): GraphEnvironment<S>[] {
  const chain: GraphEnvironment<S>[] = [];
  const seen = new Set<string>();
  let current: string | null = environmentId;

  while (current !== null) {
    if (seen.has(current)) {
      throw new ResolutionError(
        'inheritanceCycle',
        'This environment inherits from itself through its parents.',
        chain.map((environment) => environment.id),
      );
    }
    seen.add(current);

    const environment = graph.get(current);
    if (environment === undefined) {
      throw new ResolutionError(
        'missingEnvironment',
        'An environment in this inheritance chain is not available.',
        [current],
        current,
      );
    }

    chain.push(environment);
    // More than `MAX_INHERITANCE_DEPTH` *ancestors*: the environment itself is
    // the first entry, so the chain may be one longer than the limit.
    if (chain.length > MAX_INHERITANCE_DEPTH + 1) {
      throw new ResolutionError(
        'inheritanceTooDeep',
        `An environment may inherit through at most ${MAX_INHERITANCE_DEPTH} parents.`,
        chain.map((entry) => entry.id),
      );
    }
    current = environment.parentId;
  }

  return chain;
}

/** A name as an environment sees it, or `undefined` when no layer of its chain sets it. */
export function lookupInView<S extends GraphSecret>(
  graph: ReferenceGraph<S>,
  contextId: string,
  name: string,
): { environment: GraphEnvironment<S>; secret: S } | undefined {
  for (const environment of inheritanceChain(graph, contextId)) {
    const secret = environment.secrets.get(name);
    if (secret !== undefined) return { environment, secret };
  }
  return undefined;
}

/**
 * Every name an environment sees, with the layer that supplies it.
 *
 * The nearest layer wins, which is the "child overrides parent" half of the
 * resolution order. Returned in name order — by code unit, never by locale — so
 * two runs of the same resolution produce the same document.
 */
export function environmentView<S extends GraphSecret>(
  graph: ReferenceGraph<S>,
  contextId: string,
): Map<string, { environment: GraphEnvironment<S>; secret: S }> {
  const view = new Map<string, { environment: GraphEnvironment<S>; secret: S }>();
  for (const environment of inheritanceChain(graph, contextId)) {
    for (const [name, secret] of environment.secrets) {
      if (!view.has(name)) view.set(name, { environment, secret });
    }
  }
  return new Map([...view.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function nodeKey(contextId: string, name: string): string {
  return `${contextId}:${name}`;
}

/**
 * Walks every reference reachable from one name, as one environment sees it.
 *
 * Calls `visit` once per node, after its references have been walked — so a
 * value renderer can build a node from nodes already built. Throws a
 * `ResolutionError` for a loop, an over-deep chain or a dangling reference.
 *
 * `memo` is shared across calls so that a diamond — two templates referring to
 * the same third — walks the third once, and so that resolving a whole
 * environment is linear in the number of edges rather than in the number of
 * paths. It records each finished node's *height* — the longest chain of hops
 * beneath it — because a node first finished at depth 1 may be reached again at
 * depth 4, and skipping it then without asking how deep its subtree goes would
 * let a chain past the limit through by the back door.
 */
export function walkReferences<S extends GraphSecret>(
  graph: ReferenceGraph<S>,
  contextId: string,
  name: string,
  visit: (node: VisitedSecret, secret: S) => void,
  memo: Map<string, number> = new Map(),
): void {
  walk(graph, contextId, name, 0, [], memo, visit);
}

function tooDeep(name: string, path: string[]): ResolutionError {
  return new ResolutionError(
    'tooDeep',
    `References may nest at most ${MAX_REFERENCE_DEPTH} deep, and ${name} is past that.`,
    path,
  );
}

/** Returns the node's height: 0 for a value, 1 + the tallest reference for a template. */
function walk<S extends GraphSecret>(
  graph: ReferenceGraph<S>,
  contextId: string,
  name: string,
  depth: number,
  stack: string[],
  memo: Map<string, number>,
  visit: (node: VisitedSecret, secret: S) => void,
): number {
  const key = nodeKey(contextId, name);
  const finished = memo.get(key);
  if (finished !== undefined) {
    if (depth + finished > MAX_REFERENCE_DEPTH) throw tooDeep(name, [...stack, key]);
    return finished;
  }

  if (stack.includes(key)) {
    throw new ResolutionError(
      'cycle',
      `These references form a loop: ${[...stack.slice(stack.indexOf(key)), key].map(describeNode).join(' → ')}.`,
      [...stack, key],
    );
  }

  const found = lookupInView(graph, contextId, name);
  if (found === undefined) {
    const via =
      stack.length > 0 ? ` (referenced by ${describeNode(stack[stack.length - 1]!)})` : '';
    throw new ResolutionError(
      'unresolved',
      `The reference to ${name} cannot be resolved${via}: no environment in its view sets it.`,
      [...stack, key],
    );
  }

  const { environment, secret } = found;
  let height = 0;

  if (secret.template && secret.references.length > 0) {
    if (depth >= MAX_REFERENCE_DEPTH) throw tooDeep(name, [...stack, key]);

    const next = [...stack, key];
    for (const reference of secret.references) {
      const target = reference.environmentId ?? contextId;
      if (reference.environmentId !== null && !graph.has(reference.environmentId)) {
        throw new ResolutionError(
          'missingEnvironment',
          `The reference ${referenceKey(reference)} in ${name} names an environment that is not available.`,
          [...next, nodeKey(reference.environmentId, reference.name)],
          reference.environmentId,
        );
      }
      height = Math.max(
        height,
        1 + walk(graph, target, reference.name, depth + 1, next, memo, visit),
      );
    }
  }

  memo.set(key, height);
  visit({ contextId, name, definedIn: environment.id, secretId: secret.id }, secret);
  return height;
}

/** `environmentId:NAME` → `NAME` for messages; the id is in `path` for whoever needs it. */
function describeNode(key: string): string {
  const separator = key.lastIndexOf(':');
  return separator === -1 ? key : key.slice(separator + 1);
}

/**
 * Checks every template an environment sees, as that environment sees it.
 *
 * What the server runs before storing anything that could change a view: a new
 * template, a deletion, a new parent. Returns every node visited, which is the
 * set of secrets a pull of `contextId` must carry.
 */
export function checkEnvironment<S extends GraphSecret>(
  graph: ReferenceGraph<S>,
  contextId: string,
): VisitedSecret[] {
  const visited: VisitedSecret[] = [];
  const memo = new Map<string, number>();

  for (const [name, { secret }] of environmentView(graph, contextId)) {
    if (!secret.template) continue;
    walkReferences(graph, contextId, name, (node) => visited.push(node), memo);
  }

  return visited;
}

/** A secret whose value is in hand — a client's decrypted bundle. */
export interface ValuedSecret extends GraphSecret {
  readonly value: string;
}

/**
 * Resolves every name an environment sees to the value a process should get.
 *
 * The client half of the algorithm. Every template's text is parsed and checked
 * against what its writer declared: a reference in the text that the
 * declaration lacks — or one declared and absent — fails the whole resolution,
 * because the server validated the declaration and nothing else, and resolving
 * an undeclared reference would follow an edge no cycle check has ever seen.
 */
export function resolveEnvironment<S extends ValuedSecret>(
  graph: ReferenceGraph<S>,
  contextId: string,
): Map<string, string> {
  const resolved = new Map<string, string>();
  const values = new Map<string, string>();

  const render = (node: VisitedSecret, secret: S): void => {
    const key = nodeKey(node.contextId, node.name);
    if (!secret.template) {
      values.set(key, secret.value);
      return;
    }
    values.set(key, renderTemplate(secret, node, values));
  };

  const memo = new Map<string, number>();
  for (const [name] of environmentView(graph, contextId)) {
    walkReferences(graph, contextId, name, render, memo);
    const value = values.get(nodeKey(contextId, name));
    // Unreachable: the walk visits the root last, and `render` always sets it.
    if (value === undefined) {
      throw new ResolutionError('unresolved', `${name} could not be resolved.`);
    }
    resolved.set(name, value);
  }

  return resolved;
}

function renderTemplate(
  secret: ValuedSecret,
  node: VisitedSecret,
  values: ReadonlyMap<string, string>,
): string {
  let segments;
  try {
    segments = parseTemplate(secret.value);
  } catch {
    throw new ResolutionError('syntax', `${node.name} is a template that cannot be parsed.`, [
      nodeKey(node.contextId, node.name),
    ]);
  }

  const declared = new Map(
    secret.references.map((reference) => [referenceKey(reference), reference]),
  );
  const used = new Set<string>();
  let out = '';

  for (const segment of segments) {
    if (segment.kind === 'text') {
      out += segment.text;
      continue;
    }

    const key = referenceKey(segment.reference);
    const reference = declared.get(key);
    if (reference === undefined) {
      throw new ResolutionError(
        'undeclared',
        `${node.name} contains \${${key}}, which its writer did not declare. Save the template again to fix it.`,
        [nodeKey(node.contextId, node.name)],
      );
    }
    used.add(key);

    const value = values.get(nodeKey(reference.environmentId ?? node.contextId, reference.name));
    if (value === undefined) {
      // Unreachable: the walk resolves every declared reference before the node.
      throw new ResolutionError('unresolved', `The reference \${${key}} could not be resolved.`);
    }
    out += value;
  }

  if (used.size !== declared.size) {
    throw new ResolutionError(
      'undeclared',
      `${node.name} declares a reference its text does not contain. Save the template again to fix it.`,
      [nodeKey(node.contextId, node.name)],
    );
  }

  return out;
}
