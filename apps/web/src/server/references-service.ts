import { can } from '@xecret/core/authz';
import type { Action } from '@xecret/core/authz';
import {
  affectedContexts,
  checkContexts,
  descendantsOf,
  lookupInView,
  planResolution,
  referenceKey,
  ResolutionError,
  withParent,
  withSecret,
} from '@xecret/core/references';
import type {
  DeclaredReference,
  GraphEnvironment,
  GraphSecret,
  ReferenceGraph,
  ResolutionPlan,
  SecretReference,
} from '@xecret/core/references';
import {
  countUsableServiceTokens,
  findEnvironmentsBySlugs,
  findProjectsReferencingEnvironments,
  listChildEnvironments,
  listProductionChildEnvironments,
  listProductionEnvironmentsReferencing,
  listUserEmails,
  loadEnvironmentsByIds,
  loadEnvironmentsOfProjects,
  loadOrganizationAuthorizationContexts,
  loadSecretGraphMetadata,
  lockReferenceGraph,
} from '@xecret/db/repositories';
import type { Executor, GraphEnvironmentRecord, GraphSecretRecord } from '@xecret/db/repositories';
import type { Principal } from './actor';
import type { ServiceContext } from './context';
import { errors } from './errors';
import { toGrantContext } from './tenancy';
import type { EnvironmentScope } from './tenancy';

/**
 * Secret references and environment inheritance, on the server (P19 §1).
 *
 * ── What the server can do here, and what it cannot ──
 * It cannot read a template — the value is ciphertext — so it cannot resolve
 * one. What it holds is the *declared* graph: every template's references, as
 * its writer stated them in plaintext beside the ciphertext, and every
 * environment's parent. Over that graph it does three things, all with the one
 * traversal in `@xecret/core/references` that the clients also run:
 *
 *  1. **Refuses, before anything is stored**, a write that would leave any view
 *     with a loop, a chain past the depth limit, or a reference nothing in its
 *     view resolves — a template written, a secret deleted or renamed, an
 *     environment re-parented or deleted. "A cycle discovered during `xecret run`
 *     is an outage; a cycle refused at write is a validation error."
 *  2. **Works out what a pull must carry** beyond the environment itself: its
 *     ancestors whole, and from anywhere else exactly the secrets a template
 *     reaches — nothing more.
 *  3. **Authorises every one of those reads** against the caller's own access,
 *     so a reference is never a way to read an environment you cannot read
 *     directly. A developer with write access to staging who points a template
 *     at production writes nothing (the write is refused) and, had it been
 *     stored some other way, would read nothing (the pull is refused). The
 *     cryptography agrees independently: without a grant on production, nobody's
 *     client could open production's ciphertext whatever the server sent.
 *
 * ── Service tokens ──
 * A token is pinned to one environment and can read no other (threat T5) — so it
 * can resolve `${KEY}` within its own environment and nothing else. Rather than
 * let that surface as a failed CI run, the configurations that would need more
 * are refused at write time: an environment with a usable service token may not
 * be given a parent or a template referring outside itself, and an environment
 * that has either may not be given a service token (`assertTokenReach`).
 */

/** The graph's view of one secret: what the traversal needs, plus what messages name. */
export interface ServerGraphSecret extends GraphSecret {
  readonly name: string;
  readonly valueType: string;
  readonly version: number;
}

/** How many times a lazy graph may grow before the walk is abandoned as malformed. */
const MAX_GRAPH_EXPANSIONS = 24;

/**
 * Builds the reference graph from the database, as much of it as a question
 * needs, and grows it when a walk reaches an environment it has not loaded.
 *
 * An environment is in `graph` only once its secrets are loaded too, because an
 * environment present with an empty secret map would read as a layer that sets
 * nothing — a view with names silently missing, which is the one wrong answer
 * this must never give.
 */
class GraphLoader {
  readonly records = new Map<string, GraphEnvironmentRecord>();
  readonly graph = new Map<string, GraphEnvironment<ServerGraphSecret>>();
  readonly #projects = new Set<string>();

  constructor(
    private readonly exec: Executor,
    private readonly orgId: string,
  ) {}

  /** Every environment of these projects, with their secrets. */
  async loadProjects(projectIds: readonly string[]): Promise<void> {
    const fresh = [...new Set(projectIds)].filter((id) => !this.#projects.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) this.#projects.add(id);

    const rows = await loadEnvironmentsOfProjects(this.exec, this.orgId, fresh);
    for (const row of rows) this.records.set(row.id, row);
    await this.loadSecrets(rows.map((row) => row.id));
  }

  /** The named environments' secrets, for environments whose rows are already known. */
  async loadSecrets(environmentIds: readonly string[]): Promise<void> {
    const fresh = environmentIds.filter((id) => !this.graph.has(id) && this.records.has(id));
    if (fresh.length === 0) return;

    const metadata = await loadSecretGraphMetadata(this.exec, this.orgId, fresh);
    const byEnvironment = new Map<string, Map<string, ServerGraphSecret>>();
    for (const id of fresh) byEnvironment.set(id, new Map());
    for (const row of metadata)
      byEnvironment.get(row.environmentId)?.set(row.name, toGraphSecret(row));

    for (const id of fresh) {
      const record = this.records.get(id)!;
      this.graph.set(id, {
        id,
        parentId: record.parentEnvironmentId,
        secrets: byEnvironment.get(id) ?? new Map(),
      });
    }
  }

  /**
   * Makes one environment available — its row, and its secrets — answering
   * `false` when it is not a live environment of this organisation.
   *
   * Loads its whole project's rows (cheap, and its chain is inside that
   * project), and the secrets of the environment alone: a chain walk asks for
   * each ancestor in turn, so loading only what was asked keeps a pull from
   * reading every environment of a large project.
   */
  async ensure(environmentId: string): Promise<boolean> {
    if (this.graph.has(environmentId)) return true;
    if (!this.records.has(environmentId)) {
      const [row] = await loadEnvironmentsByIds(this.exec, this.orgId, [environmentId]);
      if (row === undefined) return false;
      const rows = await loadEnvironmentsOfProjects(this.exec, this.orgId, [row.projectId]);
      for (const each of rows) this.records.set(each.id, each);
    }
    await this.loadSecrets([environmentId]);
    return this.graph.has(environmentId);
  }

  /**
   * Runs `question` against the graph, loading whatever environment it turns out
   * to need and asking again. A genuinely absent environment — deleted, or not
   * this organisation's — is re-thrown as the `missingEnvironment` it is.
   */
  async ask<T>(question: (graph: ReferenceGraph<ServerGraphSecret>) => T): Promise<T> {
    const tried = new Set<string>();
    for (let expansion = 0; expansion <= MAX_GRAPH_EXPANSIONS; expansion += 1) {
      try {
        return question(this.graph);
      } catch (cause) {
        if (!(cause instanceof ResolutionError) || cause.kind !== 'missingEnvironment') throw cause;
        const missing = cause.missingEnvironmentId;
        if (missing === null || tried.has(missing)) throw cause;
        tried.add(missing);
        if (!(await this.ensure(missing))) throw cause;
      }
    }
    throw new ResolutionError('tooDeep', 'This reference graph is too large to resolve.');
  }
}

function toGraphSecret(row: GraphSecretRecord): ServerGraphSecret {
  const template = row.valueType === 'template';
  return {
    id: row.secretId,
    name: row.name,
    valueType: row.valueType,
    version: row.version,
    template,
    references: template ? (row.declaredReferences ?? []) : [],
  };
}

/* ── authorising a read of another environment ───────────────────────────── */

/**
 * Whether the caller may perform `action` on another environment of the same
 * organisation — the same `can()` every request goes through, asked of the
 * caller's own membership against that environment's row.
 */
export function mayActOn(
  scope: EnvironmentScope,
  principal: Principal,
  target: Pick<GraphEnvironmentRecord, 'id' | 'projectId' | 'isProduction'>,
  action: Action,
): boolean {
  return can(
    scope.actor,
    action,
    {
      kind: 'environment',
      orgId: scope.organization.id,
      projectId: target.projectId,
      environmentId: target.id,
    },
    {
      membership: scope.membership ? toGrantContext(scope.membership) : undefined,
      serviceToken:
        principal.kind === 'serviceToken' ? { accessLevel: principal.accessLevel } : undefined,
      isProduction: target.isProduction,
    },
  ).allowed;
}

/** The slug of an environment's parent, for a payload that speaks slugs. */
export async function parentSlugOf(
  services: ServiceContext,
  orgId: string,
  environment: { parentEnvironmentId: string | null },
): Promise<string | null> {
  const parentId = environment.parentEnvironmentId ?? null;
  if (parentId === null) return null;
  const [parent] = await loadEnvironmentsByIds(services.db, orgId, [parentId]);
  return parent?.slug ?? null;
}

/* ── declaring references ────────────────────────────────────────────────── */

/**
 * Turns the references a client parsed out of a template into what is stored:
 * each with the environment its slugs name, resolved inside this organisation.
 *
 * Refused, field by field, when a reference names an environment that does not
 * exist, is not end-to-end encrypted, or **is one the writer may not read** — and
 * those three are deliberately one message, so a template cannot be used to
 * learn which environments exist beyond the writer's reach.
 */
export async function declareReferences(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
  parsed: readonly SecretReference[],
): Promise<DeclaredReference[]> {
  if (parsed.length === 0) return [];

  const pairs = new Map<string, { projectSlug: string; environmentSlug: string }>();
  for (const reference of parsed) {
    if (reference.environment === undefined) continue;
    const projectSlug = reference.project ?? scope.project.slug;
    pairs.set(`${projectSlug}/${reference.environment}`, {
      projectSlug,
      environmentSlug: reference.environment,
    });
  }

  const found = await findEnvironmentsBySlugs(services.db, scope.organization.id, [
    ...pairs.values(),
  ]);
  const bySlug = new Map(found.map((row) => [`${row.projectSlug}/${row.slug}`, row]));

  const problems: { field: string; message: string }[] = [];
  const declared: DeclaredReference[] = [];

  for (const reference of parsed) {
    if (reference.environment === undefined) {
      declared.push({ name: reference.name, environmentId: null });
      continue;
    }

    const projectSlug = reference.project ?? scope.project.slug;
    const target = bySlug.get(`${projectSlug}/${reference.environment}`);
    if (
      target === undefined ||
      target.encryptionMode !== 'e2ee' ||
      !mayActOn(scope, principal, target, 'secret.read')
    ) {
      problems.push({
        field: 'references',
        message: `\${${referenceKey(reference)}} names an environment that does not exist, or that you cannot read.`,
      });
      continue;
    }

    declared.push({
      ...(reference.project === undefined ? {} : { project: reference.project }),
      environment: reference.environment,
      name: reference.name,
      environmentId: target.id,
    });
  }

  if (problems.length > 0) throw errors.validation(problems);
  return declared;
}

/** Whether a declaration reaches outside the environment that holds it. */
export function reachesOutside(
  environmentId: string,
  references: readonly DeclaredReference[],
): boolean {
  return references.some(
    (reference) => reference.environmentId !== null && reference.environmentId !== environmentId,
  );
}

/* ── links that cross production's protection ─────────────────────────────── */

/**
 * A link that would make a production environment read values from one that is
 * not production (review round 1, M3).
 *
 * ── Why it is confirmed rather than refused ──
 * Inheriting from, or referring into, an environment is a statement that its
 * values may flow here. When *here* is production and the source is not, that
 * flow is a write path onto production for everybody who can write the source:
 * a developer who may change staging's `DB_HOST` but not production's changes
 * what production reads the moment production inherits it — without
 * production's grants, production's deny-by-default, or anybody with production
 * access being asked. That is sometimes exactly the design (a shared base of
 * non-secret defaults), so it is not refused. It is made deliberate: the request
 * has to say it knows (`confirmCrossesProtection: true`), the refusal that asks
 * names who would be able to write production's values through the link, and a
 * confirmed link files its own `environment.link_crosses_protection`.
 *
 * Only the link being made is asked about — a parent, or a reference the write
 * adds. A template re-saved with the reference it already declared is not asked
 * again; a production environment that inherits from another production one is
 * not asked at all, whatever that one inherits from, because that link was asked
 * about when it was made.
 */
export interface ProtectionCrossing {
  source: GraphEnvironmentRecord;
  via: 'parent' | 'reference';
}

/**
 * The references in `declared` that cross production's protection and are new —
 * not already declared by `previous`, the version the write replaces. No query
 * for a write that is not into production.
 */
export async function referenceCrossings(
  scope: EnvironmentScope,
  services: ServiceContext,
  declared: readonly DeclaredReference[],
  previous: readonly DeclaredReference[] | null,
): Promise<ProtectionCrossing[]> {
  if (!scope.environment.isProduction) return [];
  const already = new Set((previous ?? []).map((reference) => reference.environmentId));
  const targets = [
    ...new Set(
      declared
        .map((reference) => reference.environmentId)
        .filter(
          (id): id is string => id !== null && id !== scope.environment.id && !already.has(id),
        ),
    ),
  ];
  if (targets.length === 0) return [];
  const records = await loadEnvironmentsByIds(services.db, scope.organization.id, targets);
  return records
    .filter((record) => !record.isProduction)
    .map((source) => ({ source, via: 'reference' as const }));
}

/** Whether making `parent` this environment's parent crosses production's protection. */
export function parentCrossing(
  scope: EnvironmentScope,
  parent: GraphEnvironmentRecord,
): ProtectionCrossing[] {
  return scope.environment.isProduction && !parent.isProduction
    ? [{ source: parent, via: 'parent' }]
    : [];
}

/** How many named people a crossing refusal lists before it says "and N others". */
const NAMED_WRITERS = 5;

/**
 * The refusal an unconfirmed crossing gets: a 409 naming the production
 * environment, the source, and who can write the source — so the person
 * confirming knows whom they are letting change production's values.
 *
 * Every name in it is one the caller may see: the source is an environment they
 * may read (the parent route and `declareReferences` both require it), and the
 * people are members of their own organisation.
 */
export async function crossingRefusal(
  scope: EnvironmentScope,
  services: ServiceContext,
  crossings: readonly ProtectionCrossing[],
): Promise<never> {
  const here = `${scope.project.slug}/${scope.environment.slug}`;
  const parts: string[] = [];
  for (const { source } of crossings) {
    parts.push(
      `${source.projectSlug}/${source.slug} (${await describeWriters(scope, services, source)})`,
    );
  }
  const how = crossings.some((crossing) => crossing.via === 'parent')
    ? 'inherit values from'
    : 'read values through a template from';
  const sources = crossings.map(({ source }) => `${source.projectSlug}/${source.slug}`).join(', ');
  const one = crossings.length === 1;

  throw errors.conflict(
    `link_crosses_protection: This would make the production environment ${here} ${how} ` +
      `${sources}, which ${one ? 'is' : 'are'} not production. Anyone who can change ` +
      `${one ? 'its' : 'their'} secrets — ${parts.join('; ')} — would change what ${here} reads, ` +
      `without ${here}'s own access rules being asked. Confirm the link ` +
      '(confirmCrossesProtection: true) to make it anyway.',
  );
}

/**
 * Who may change secrets in `source`, as a phrase: up to five people by address,
 * how many more, and how many write tokens are pinned to it. Asked with the same
 * `can()` every write goes through, of every active member's own context.
 */
async function describeWriters(
  scope: EnvironmentScope,
  services: ServiceContext,
  source: GraphEnvironmentRecord,
): Promise<string> {
  const contexts = await loadOrganizationAuthorizationContexts(services.db, {
    orgId: scope.organization.id,
    projectId: source.projectId,
  });
  const writers = contexts
    .filter(
      (context) =>
        can(
          { kind: 'user', userId: context.userId, orgId: scope.organization.id },
          'secret.update',
          {
            kind: 'environment',
            orgId: scope.organization.id,
            projectId: source.projectId,
            environmentId: source.id,
          },
          { membership: toGrantContext(context), isProduction: source.isProduction },
        ).allowed,
    )
    .map((context) => context.userId);
  const named = await listUserEmails(services.db, writers.slice(0, NAMED_WRITERS));
  const tokens = await countUsableServiceTokens(
    services.db,
    scope.organization.id,
    [source.id],
    'write',
  );

  const people =
    writers.length === 0
      ? 'nobody at present'
      : writers.length > named.length
        ? `${named.join(', ')} and ${writers.length - named.length} other${writers.length - named.length === 1 ? '' : 's'}`
        : named.join(', ');
  return tokens === 0
    ? people
    : `${people}, and ${tokens} write service token${tokens === 1 ? '' : 's'}`;
}

/**
 * The crossings produced by turning *on* an environment's `is_production`
 * flag (review round 2, F1): its own parent, if it has one that is not
 * production, and every reference one of its own templates already declares
 * into an environment that is not production.
 *
 * `parentCrossing` and `referenceCrossings` ask the same question of a link
 * about to be *created*; this asks it of every link already there, because
 * the environment holding it is only now becoming production. Both links were
 * free to write a moment ago — nothing below admin could read this environment
 * either way — so a flip is exactly as much a new write path onto production
 * as inheriting from, or adding a reference into, one that is not.
 */
export async function productionFlagCrossings(
  scope: EnvironmentScope,
  services: ServiceContext,
): Promise<ProtectionCrossing[]> {
  const crossings: ProtectionCrossing[] = [];

  const parentId = scope.environment.parentEnvironmentId ?? null;
  if (parentId !== null) {
    const [parent] = await loadEnvironmentsByIds(services.db, scope.organization.id, [parentId]);
    if (parent !== undefined && !parent.isProduction) {
      crossings.push({ source: parent, via: 'parent' });
    }
  }

  const metadata = await loadSecretGraphMetadata(services.db, scope.organization.id, [
    scope.environment.id,
  ]);
  const targets = [
    ...new Set(
      metadata
        .filter((row) => row.valueType === 'template')
        .flatMap((row) => row.declaredReferences ?? [])
        .map((reference) => reference.environmentId)
        .filter((id): id is string => id !== null && id !== scope.environment.id),
    ),
  ];
  if (targets.length > 0) {
    const records = await loadEnvironmentsByIds(services.db, scope.organization.id, targets);
    for (const source of records) {
      if (!source.isProduction) crossings.push({ source, via: 'reference' });
    }
  }

  return crossings;
}

/**
 * A still-production environment that depends on one about to lose
 * `is_production` (review round 2, F1) — the mirror of `ProtectionCrossing`
 * for the other direction. `dependent` is always production; the environment
 * losing the flag is the `source` half of the link, named by the caller's own
 * `scope`.
 */
export interface ProtectionDependency {
  dependent: GraphEnvironmentRecord;
  via: 'parent' | 'reference';
}

/**
 * The crossings produced by turning *off* an environment's `is_production`
 * flag: every still-production environment — of this project or another —
 * that inherits from it, or holds a template reading through it.
 *
 * Once the flag is off, every developer in the organisation can write here, so
 * each of these would be a production environment reading values from a
 * source whose own access rules no longer apply, without anybody with access
 * to *that* production environment being asked.
 */
export async function productionFlagDependents(
  scope: EnvironmentScope,
  services: ServiceContext,
): Promise<ProtectionDependency[]> {
  const [children, referencing] = await Promise.all([
    listProductionChildEnvironments(services.db, scope.organization.id, scope.environment.id),
    listProductionEnvironmentsReferencing(services.db, scope.organization.id, scope.environment.id),
  ]);

  const dependents: ProtectionDependency[] = children.map((dependent) => ({
    dependent,
    via: 'parent' as const,
  }));
  const seen = new Set(children.map((child) => child.id));
  for (const dependent of referencing) {
    if (seen.has(dependent.id)) continue;
    seen.add(dependent.id);
    dependents.push({ dependent, via: 'reference' });
  }
  return dependents;
}

/**
 * The refusal an unconfirmed demotion gets: a 409 naming every production
 * environment — this one's project or another's — that depends on the one
 * about to lose its production mark, so the person confirming knows who would
 * start reading values nobody with access to *their* environment was asked
 * about.
 */
export function productionFlagDependentsRefusal(
  scope: EnvironmentScope,
  dependents: readonly ProtectionDependency[],
): never {
  const here = `${scope.project.slug}/${scope.environment.slug}`;
  const names = dependents.map(({ dependent }) => `${dependent.projectSlug}/${dependent.slug}`);
  const one = names.length === 1;

  throw errors.conflict(
    `link_crosses_protection: ${names.join(', ')}, which ${one ? 'is' : 'are'} production, ` +
      `${one ? 'inherits from, or reads through a template from,' : 'inherit from, or read through templates from,'} ` +
      `${here}. Removing ${here}'s production mark would hand every developer in this ` +
      `organisation write access to the values ${one ? 'it reads' : 'they read'} from here, ` +
      `without ${one ? 'its own access rules' : 'their own access rules'} being asked. Confirm ` +
      'the change (confirmCrossesProtection: true) to make it anyway.',
  );
}

/* ── write-time checks ───────────────────────────────────────────────────── */

/**
 * Loads the part of the graph a change to `environmentId` can affect: its whole
 * project (which holds its chain and its descendants), and every project with a
 * template that points into it or into a descendant. References out of those
 * projects are loaded lazily, by `ask`, as the walk reaches them.
 */
async function graphAround(
  exec: Executor,
  orgId: string,
  projectId: string,
  environmentId: string,
): Promise<GraphLoader> {
  const loader = new GraphLoader(exec, orgId);
  await loader.loadProjects([projectId]);

  const reached = [environmentId, ...descendantsOf(loader.graph, environmentId)];
  const inbound = await findProjectsReferencingEnvironments(exec, orgId, reached);
  await loader.loadProjects(inbound);
  return loader;
}

/**
 * What a refusal may say about the walk that refused it (review round 1, L9).
 *
 * A `ResolutionError` names the secrets on its path — the template that would
 * dangle, the hop that loops — and the views it walked can be anywhere a
 * template points into the changed environment from: another project, or
 * production for a developer who may read only staging. Repeating such a name to
 * a caller who could not list it is a disclosure of exactly what `can()` keeps
 * from them. So the walk's own words are used only when **every** view on its
 * path is one the caller may read; otherwise the refusal says what kind of
 * thing is in the way, and where it is in general terms, and nothing else.
 *
 * Never a value either way — there is none to give.
 */
function readableMessage(
  scope: EnvironmentScope,
  principal: Principal,
  loader: GraphLoader,
  cause: ResolutionError,
  generic: string,
): string {
  const contexts = new Set(
    cause.path.map((key) => {
      const separator = key.lastIndexOf(':');
      return separator === -1 ? key : key.slice(0, separator);
    }),
  );
  for (const id of contexts) {
    const record = loader.records.get(id);
    if (record === undefined || !mayActOn(scope, principal, record, 'secret.read')) return generic;
  }
  return cause.message;
}

/** The generic sentence: a template the caller cannot see is what is in the way. */
const UNREADABLE_DEPENDENT = 'a secret in an environment you cannot read';

/** A refusal at write time, naming what the walk found when the caller may see it. */
function refusal(
  scope: EnvironmentScope,
  principal: Principal,
  loader: GraphLoader,
  cause: unknown,
  field: string,
): never {
  if (cause instanceof ResolutionError) {
    throw errors.validation([
      {
        field,
        message: readableMessage(
          scope,
          principal,
          loader,
          cause,
          `This would leave ${UNREADABLE_DEPENDENT} unresolvable, in a loop or nested too deep. ` +
            'Ask somebody who can read it to change it first.',
        ),
      },
    ]);
  }
  throw cause;
}

/**
 * Refuses a template write that would leave any view it reaches unresolvable,
 * looping, or too deep — checked against the graph *as it would be* after the
 * write, in every context that can see the template: the environment itself,
 * everything that inherits from it, and everything that reads into either.
 *
 * ── Run it inside the write's transaction, under `lockReferenceGraph` ──
 * As every check in this section is (review round 1, L8): checked outside, two
 * concurrent writes — A→B and B→A — each pass a check that cannot see the
 * other, and both commit a loop. `graphWriteGuard` is the one way the routes
 * call these, and the write path runs it first thing in its transaction.
 */
export async function assertTemplateWrite(
  scope: EnvironmentScope,
  principal: Principal,
  exec: Executor,
  write: { name: string; secretId: string; references: readonly DeclaredReference[] },
): Promise<void> {
  const loader = await graphAround(
    exec,
    scope.organization.id,
    scope.project.id,
    scope.environment.id,
  );

  try {
    await loader.ask((graph) => {
      const proposed = withSecret(graph, scope.environment.id, write.name, {
        id: write.secretId,
        name: write.name,
        valueType: 'template',
        version: 0,
        template: true,
        references: write.references,
      });
      checkContexts(proposed, affectedContexts(proposed, scope.environment.id));
    });
  } catch (cause) {
    refusal(scope, principal, loader, cause, 'references');
  }
}

/**
 * Refuses removing `name` from this environment — a deletion, or a rename away
 * from it — when a template anywhere would then reference something no view
 * resolves.
 *
 * Cheap for the overwhelming majority of deletions: an environment no template
 * can see costs the project's rows and nothing more, because nothing in the
 * graph is a template and no project points into it.
 */
export async function assertRemovalKeepsReferences(
  scope: EnvironmentScope,
  principal: Principal,
  exec: Executor,
  name: string,
): Promise<void> {
  const loader = await graphAround(
    exec,
    scope.organization.id,
    scope.project.id,
    scope.environment.id,
  );
  if (!graphHasTemplates(loader.graph)) return;

  try {
    await loader.ask((graph) => {
      const without = withSecret(graph, scope.environment.id, name, null);
      checkContexts(without, affectedContexts(graph, scope.environment.id));
    });
  } catch (cause) {
    if (cause instanceof ResolutionError) {
      const why = readableMessage(scope, principal, loader, cause, '');
      throw errors.conflict(
        why === ''
          ? `${name} cannot be removed while ${UNREADABLE_DEPENDENT} depends on it. ` +
              'Ask somebody who can read it to change or delete that template first.'
          : `${name} cannot be removed while a template depends on it: ${why} ` +
              'Change or delete the template first.',
      );
    }
    throw cause;
  }
}

/**
 * The batch form of the two checks above, for a write that changes many secrets
 * of one environment at once — a promotion, a point-in-time restore (P19 §3, §4).
 *
 * Every change is applied to the graph together and every affected view checked
 * once, because checked one at a time two changes can each be fine and together
 * not: two templates that each refer to the other, or a template promoted beside
 * the plain value it refers to, which a one-at-a-time check would refuse for want
 * of a secret the same batch creates.
 *
 * Costs the project's rows and nothing more when neither the batch nor the graph
 * holds a template.
 */
export async function assertEnvironmentChanges(
  scope: EnvironmentScope,
  principal: Principal,
  exec: Executor,
  changes: EnvironmentChanges,
): Promise<void> {
  if (changes.set.length === 0 && changes.remove.length === 0) return;

  const loader = await graphAround(
    exec,
    scope.organization.id,
    scope.project.id,
    scope.environment.id,
  );
  const writesTemplates = changes.set.some((change) => change.references !== null);
  if (!writesTemplates && !graphHasTemplates(loader.graph)) return;

  try {
    await loader.ask((graph) => {
      let proposed = graph;
      for (const name of changes.remove) {
        proposed = withSecret(proposed, scope.environment.id, name, null);
      }
      for (const change of changes.set) {
        proposed = withSecret(proposed, scope.environment.id, change.name, {
          id: change.secretId,
          name: change.name,
          valueType: change.references === null ? 'string' : 'template',
          version: 0,
          template: change.references !== null,
          references: change.references ?? [],
        });
      }
      // The contexts of the graph before and after: a removal is seen by the
      // views that saw the old secret, a template by the views that will see it.
      const contexts = new Set([
        ...affectedContexts(graph, scope.environment.id),
        ...affectedContexts(proposed, scope.environment.id),
      ]);
      checkContexts(proposed, [...contexts]);
    });
  } catch (cause) {
    if (cause instanceof ResolutionError) {
      const why = readableMessage(scope, principal, loader, cause, '');
      throw errors.conflict(
        why === ''
          ? `This change would leave ${UNREADABLE_DEPENDENT} unresolvable. ` +
              'Ask somebody who can read it to change that template first.'
          : `This change would leave a template unresolvable: ${why} ` +
              'Change the template, or include what it refers to.',
      );
    }
    throw cause;
  }
}

/** What a batch changes about one environment's secrets, for `assertEnvironmentChanges`. */
export interface EnvironmentChanges {
  set: readonly {
    name: string;
    secretId: string;
    references: readonly DeclaredReference[] | null;
  }[];
  remove: readonly string[];
}

/** A graph check, run by the write path inside its transaction. See `graphWriteGuard`. */
export type GraphGuard = (exec: Executor) => Promise<void>;

/**
 * The graph check a write must pass, as the write path runs it: inside the
 * write's own transaction, after `lockReferenceGraph`, so the graph it reads is
 * the graph the write commits into (review round 1, L8). For a dry run — which
 * opens no transaction — the same check runs on its own, because a preview must
 * still say what the write would be refused for; the lock it takes then is held
 * only for its own statement, which costs a dry run nothing.
 */
export function graphWriteGuard(
  scope: EnvironmentScope,
  principal: Principal,
  check:
    | { kind: 'template'; name: string; secretId: string; references: readonly DeclaredReference[] }
    | { kind: 'removal'; name: string }
    | { kind: 'changes'; changes: EnvironmentChanges },
): GraphGuard {
  return async (exec) => {
    await lockReferenceGraph(exec, scope.organization.id);
    switch (check.kind) {
      case 'template':
        return assertTemplateWrite(scope, principal, exec, check);
      case 'removal':
        return assertRemovalKeepsReferences(scope, principal, exec, check.name);
      case 'changes':
        return assertEnvironmentChanges(scope, principal, exec, check.changes);
    }
  };
}

function graphHasTemplates(graph: ReferenceGraph<ServerGraphSecret>): boolean {
  for (const environment of graph.values()) {
    for (const secret of environment.secrets.values()) if (secret.template) return true;
  }
  return false;
}

/**
 * Refuses deleting an environment that another inherits from, or that a
 * template elsewhere points into. Both would turn a deletion into somebody
 * else's broken deploy.
 *
 * Asked inside the deletion's transaction, after `lockReferenceGraph`, like
 * every other graph check — a template written into this environment at the
 * same moment would otherwise pass a check that could not see the deletion.
 */
export async function assertEnvironmentRemovable(
  scope: EnvironmentScope,
  exec: Executor,
): Promise<void> {
  const children = await listChildEnvironments(exec, scope.organization.id, scope.environment.id);
  if (children.length > 0) {
    throw errors.conflict(
      `${children.map((child) => child.slug).join(', ')} inherit${children.length === 1 ? 's' : ''} ` +
        'from this environment. Give them another parent, or none, before deleting it.',
    );
  }

  const inbound = await findProjectsReferencingEnvironments(exec, scope.organization.id, [
    scope.environment.id,
  ]);
  if (inbound.length > 0) {
    throw errors.conflict(
      'A template in another environment refers to this one. Change or delete it before deleting this environment.',
    );
  }
}

/**
 * Refuses deleting a project whose environments a template in another project
 * refers to. Asked under the graph lock, as `assertEnvironmentRemovable` is.
 */
export async function assertProjectRemovable(
  exec: Executor,
  orgId: string,
  projectId: string,
): Promise<void> {
  const environments = await loadEnvironmentsOfProjects(exec, orgId, [projectId]);
  const inbound = await findProjectsReferencingEnvironments(
    exec,
    orgId,
    environments.map((environment) => environment.id),
  );
  if (inbound.some((id) => id !== projectId)) {
    throw errors.conflict(
      'A template in another project refers to an environment of this one. Change or delete it before deleting this project.',
    );
  }
}

/**
 * Checks a new parent for an environment, or clearing it: same project, both
 * end-to-end encrypted, no loop, no chain past the limit, and no view anywhere
 * left unresolvable by what the environment stops or starts inheriting.
 */
export async function assertParentChange(
  scope: EnvironmentScope,
  principal: Principal,
  exec: Executor,
  parentId: string | null,
): Promise<void> {
  const loader = await graphAround(
    exec,
    scope.organization.id,
    scope.project.id,
    scope.environment.id,
  );

  try {
    await loader.ask((graph) => {
      const proposed = withParent(graph, scope.environment.id, parentId);
      checkContexts(proposed, affectedContexts(proposed, scope.environment.id));
    });
  } catch (cause) {
    refusal(scope, principal, loader, cause, 'parent');
  }
}

/** The environment's parent, found in its own project, or a refusal. */
export async function findParentCandidate(
  scope: EnvironmentScope,
  services: ServiceContext,
  slug: string,
): Promise<GraphEnvironmentRecord> {
  const rows = await loadEnvironmentsOfProjects(services.db, scope.organization.id, [
    scope.project.id,
  ]);
  const parent = rows.find((row) => row.slug === slug);
  if (parent === undefined) {
    throw errors.validation([
      { field: 'parent', message: 'No environment with that slug in this project.' },
    ]);
  }
  if (parent.id === scope.environment.id) {
    throw errors.validation([
      { field: 'parent', message: 'An environment cannot inherit from itself.' },
    ]);
  }
  if (parent.encryptionMode !== 'e2ee') {
    throw errors.validation([
      {
        field: 'parent',
        message: 'Only end-to-end encrypted environments can be inherited from.',
      },
    ]);
  }
  return parent;
}

/**
 * The service-token half of the rule in this file's header: refuses giving an
 * environment CI reads from something a pinned token cannot resolve.
 */
export async function assertTokenReach(
  scope: EnvironmentScope,
  services: ServiceContext,
  what: 'parent' | 'reference',
): Promise<void> {
  const tokens = await countUsableServiceTokens(services.db, scope.organization.id, [
    scope.environment.id,
  ]);
  if (tokens === 0) return;

  throw errors.conflict(
    `This environment has ${tokens} active service token${tokens === 1 ? '' : 's'}, and a service ` +
      `token can read only its own environment — so it could not resolve ${
        what === 'parent' ? 'inherited values' : 'a reference to another environment'
      }. Revoke the token${tokens === 1 ? '' : 's'} first, or keep CI on an environment that ` +
      'stands alone.',
  );
}

/**
 * Whether a new service token may be pinned to this environment: refused when
 * the environment inherits, or holds a template reaching outside itself.
 */
export async function assertTokenCanResolve(
  scope: EnvironmentScope,
  services: ServiceContext,
): Promise<void> {
  if (scope.environment.parentEnvironmentId !== null) {
    throw errors.conflict(
      'This environment inherits from another, and a service token can read only its own ' +
        'environment, so it could not resolve inherited values. Mint the token on an environment ' +
        'that stands alone.',
    );
  }

  const metadata = await loadSecretGraphMetadata(services.db, scope.organization.id, [
    scope.environment.id,
  ]);
  const outside = metadata.some(
    (row) =>
      row.valueType === 'template' &&
      reachesOutside(scope.environment.id, row.declaredReferences ?? []),
  );
  if (outside) {
    throw errors.conflict(
      'A template in this environment refers to another environment, which a service token ' +
        'pinned here could not read. Mint the token on an environment that stands alone.',
    );
  }
}

/* ── the pull ────────────────────────────────────────────────────────────── */

/** One secret a pull must carry from outside the environment, and who led there. */
export interface ReferencedRead {
  environmentId: string;
  projectId: string | null;
  secretId: string;
  name: string;
  /** The template whose reference reached it. */
  referringSecretName: string;
}

export interface PullPlan {
  plan: ResolutionPlan;
  /** Every environment the plan touches, by id. */
  environments: ReadonlyMap<string, GraphEnvironmentRecord>;
  /** Secrets reached by a reference from outside the chain, for the audit trail. */
  referencedReads: ReferencedRead[];
}

/**
 * Plans the pull of an environment that inherits or holds a template: what to
 * carry, and from where.
 *
 * Loads lazily — the environment's chain first, then whatever a template
 * reaches — so a pull reads the environments it needs and no others. A loop or a
 * dangling reference found here is a state the write-time checks exist to
 * prevent; it is refused rather than half-resolved.
 */
export async function planPull(
  scope: EnvironmentScope,
  services: ServiceContext,
): Promise<PullPlan> {
  const loader = new GraphLoader(services.db, scope.organization.id);
  await loader.ensure(scope.environment.id);

  // The chain is inside the project whose rows `ensure` just read, so its
  // secrets can be loaded in one statement rather than one ancestor at a time
  // as the walk reaches each.
  const chain: string[] = [];
  for (
    let id = loader.records.get(scope.environment.id)?.parentEnvironmentId ?? null;
    id !== null && chain.length <= MAX_GRAPH_EXPANSIONS && !chain.includes(id);
    id = loader.records.get(id)?.parentEnvironmentId ?? null
  ) {
    chain.push(id);
  }
  await loader.loadSecrets(chain);

  let planned: ResolutionPlan;
  try {
    planned = await loader.ask((graph) => planResolution(graph, scope.environment.id));
  } catch (cause) {
    if (cause instanceof ResolutionError) {
      throw errors.conflict(
        `resolution_failed: this environment's references cannot be resolved — ${cause.message}`,
      );
    }
    throw cause;
  }

  const inChain = new Set([scope.environment.id, ...planned.chain]);
  const referencedReads: ReferencedRead[] = [];
  const seen = new Set<string>();

  // For the audit trail: every secret a reference reached from outside the
  // chain, with the template that reached it.
  for (const node of planned.visited) {
    const environment = loader.graph.get(node.definedIn);
    const secret = environment?.secrets.get(node.name);
    if (secret === undefined || !secret.template) continue;
    for (const reference of secret.references) {
      const context = reference.environmentId ?? node.contextId;
      const target = lookupInView(loader.graph, context, reference.name);
      if (target === undefined || inChain.has(target.environment.id)) continue;
      const key = `${target.environment.id}:${target.secret.id}:${node.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      referencedReads.push({
        environmentId: target.environment.id,
        projectId: loader.records.get(target.environment.id)?.projectId ?? null,
        secretId: target.secret.id,
        name: reference.name,
        referringSecretName: node.name,
      });
    }
  }

  return { plan: planned, environments: loader.records, referencedReads };
}
