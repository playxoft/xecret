import { checkEnvironment, inheritanceChain } from './resolve';
import type { GraphEnvironment, GraphSecret, ReferenceGraph, VisitedSecret } from './resolve';

/**
 * The write-time half of P19 §1: what has to be re-checked when something
 * that a view depends on changes, and the overlays that let a check run against
 * the state a write *would* produce, before it is stored.
 *
 * "A cycle discovered during `xecret run` is an outage; a cycle refused at write
 * is a validation error." Everything here exists to make the second sentence
 * true for every way a view can change: a template written, a secret deleted or
 * renamed, a parent set or cleared.
 */

/** Every environment whose chain passes through `environmentId`, excluding it. */
export function descendantsOf<S extends GraphSecret>(
  graph: ReferenceGraph<S>,
  environmentId: string,
): string[] {
  const children = new Map<string, string[]>();
  for (const environment of graph.values()) {
    if (environment.parentId === null) continue;
    const list = children.get(environment.parentId) ?? [];
    list.push(environment.id);
    children.set(environment.parentId, list);
  }

  const found: string[] = [];
  const seen = new Set<string>([environmentId]);
  const queue = [...(children.get(environmentId) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    found.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return found;
}

/**
 * The graph as it would be with one secret set, replaced or removed.
 *
 * Copy-on-write: the original graph is untouched, so a check that refuses
 * leaves nothing behind, and the caller can run the same graph through several
 * hypotheticals.
 */
export function withSecret<S extends GraphSecret>(
  graph: ReferenceGraph<S>,
  environmentId: string,
  name: string,
  secret: S | null,
): ReferenceGraph<S> {
  const environment = graph.get(environmentId);
  if (environment === undefined) return graph;

  const secrets = new Map(environment.secrets);
  if (secret === null) secrets.delete(name);
  else secrets.set(name, secret);

  const next = new Map(graph);
  next.set(environmentId, { ...environment, secrets });
  return next;
}

/** The graph as it would be with one environment's parent changed. */
export function withParent<S extends GraphSecret>(
  graph: ReferenceGraph<S>,
  environmentId: string,
  parentId: string | null,
): ReferenceGraph<S> {
  const environment = graph.get(environmentId);
  if (environment === undefined) return graph;

  const next = new Map(graph);
  next.set(environmentId, { ...environment, parentId } satisfies GraphEnvironment<S>);
  return next;
}

/**
 * Environments whose views include a template that references, by name, one of
 * `targets` — the qualified edges *into* a set of environments.
 *
 * What makes a deletion or a parent change safe to check without walking the
 * whole organisation: only the contexts that can see a template pointing at the
 * changed environments can be broken by the change, and these are they.
 */
export function contextsReferencing<S extends GraphSecret>(
  graph: ReferenceGraph<S>,
  targets: ReadonlySet<string>,
): string[] {
  const definers = new Set<string>();
  for (const environment of graph.values()) {
    for (const secret of environment.secrets.values()) {
      if (!secret.template) continue;
      if (
        secret.references.some(
          (reference) => reference.environmentId !== null && targets.has(reference.environmentId),
        )
      ) {
        definers.add(environment.id);
      }
    }
  }

  const contexts = new Set<string>();
  for (const definer of definers) {
    contexts.add(definer);
    for (const descendant of descendantsOf(graph, definer)) contexts.add(descendant);
  }
  return [...contexts];
}

/**
 * Every context a change to `environmentId` can affect: itself, everything that
 * inherits from it, and everything that can see a template pointing into either.
 */
export function affectedContexts<S extends GraphSecret>(
  graph: ReferenceGraph<S>,
  environmentId: string,
): string[] {
  const changed = new Set([environmentId, ...descendantsOf(graph, environmentId)]);
  const contexts = new Set(changed);
  for (const context of contextsReferencing(graph, changed)) contexts.add(context);
  return [...contexts];
}

/**
 * Checks every context in `contextIds`, throwing the first `ResolutionError`.
 *
 * The chain itself is checked first, for every context, so an inheritance loop
 * is reported as one even in an environment that holds no template at all.
 */
export function checkContexts<S extends GraphSecret>(
  graph: ReferenceGraph<S>,
  contextIds: readonly string[],
): void {
  for (const contextId of contextIds) {
    inheritanceChain(graph, contextId);
    checkEnvironment(graph, contextId);
  }
}

/**
 * What a pull of one environment must carry, beyond the environment itself.
 *
 *  - `chain` — every ancestor, nearest first. Their secrets are part of the view
 *    and travel whole.
 *  - `referenced` — the secrets outside the chain that some template reaches,
 *    by the environment that holds each. Only these travel from those
 *    environments: a reference to `shared.DB_HOST` discloses `DB_HOST`, not
 *    every other secret in `shared`.
 *  - `contexts` — the environments whose views a referenced secret was looked up
 *    in. A client needs each one's chain to repeat the lookup, so each must be
 *    in the bundle even when it contributes no secret of its own.
 *  - `visited` — every node of the walk, for the audit trail: a secret reached
 *    through a reference is a secret that was read.
 */
export interface ResolutionPlan {
  chain: string[];
  referenced: Map<string, Set<string>>;
  contexts: Set<string>;
  visited: VisitedSecret[];
}

export function planResolution<S extends GraphSecret>(
  graph: ReferenceGraph<S>,
  contextId: string,
): ResolutionPlan {
  const chain = inheritanceChain(graph, contextId).map((environment) => environment.id);
  const inChain = new Set(chain);
  const visited = checkEnvironment(graph, contextId);

  const referenced = new Map<string, Set<string>>();
  const contexts = new Set<string>();

  for (const node of visited) {
    if (inChain.has(node.definedIn) && inChain.has(node.contextId)) continue;
    // The context's whole chain, to the root — not only as far as the layer that
    // defined the secret. A client repeats the lookup by walking the chain, and
    // `inheritanceChain` refuses a chain with a missing link however far below it
    // the answer was found.
    for (const environment of inheritanceChain(graph, node.contextId)) {
      contexts.add(environment.id);
    }
    const names = referenced.get(node.definedIn) ?? new Set<string>();
    names.add(node.name);
    referenced.set(node.definedIn, names);
  }

  for (const id of chain) contexts.delete(id);
  return { chain: chain.slice(1), referenced, contexts, visited };
}
