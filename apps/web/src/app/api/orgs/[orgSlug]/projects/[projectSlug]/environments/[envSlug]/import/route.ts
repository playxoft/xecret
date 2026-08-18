import {
  buildImportPlan,
  detectFormat,
  parseDotenv,
  parseJson,
  parseShell,
  parseYaml,
} from '@xecret/core/importer';
import type { ImportFormat, ImportItemStatus, ParseResult } from '@xecret/core/importer';
import { loadEnvironmentSecrets } from '@xecret/db/repositories';
import { errors } from '@/server/errors';
import { json, parseJsonBody } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { importBody } from '@/server/schemas/secrets';
import {
  applySecretWrites,
  auditSource,
  authorizeSecretAction,
  enforceSecretRateLimit,
  secretWriter,
} from '@/server/secrets-service';
import type { SecretWrite } from '@/server/secrets-service';
import { resolveEnvironmentPath } from '@/server/tenancy';

/**
 * Bulk import from a `.env`, JSON, YAML or shell file.
 *
 * ## The dry run *is* the import
 *
 * Both modes run the identical code path: the same parser, the same
 * `buildImportPlan`, and the same `applySecretWrites` — which computes each
 * value's HMAC and therefore decides `created` / `updated` / `unchanged` the same
 * way in both. `dryRun` changes exactly one thing: `applySecretWrites` stops
 * before opening the transaction. The preview therefore cannot disagree with the
 * outcome, because there is no second implementation for it to disagree with.
 * Any conditional a writer applied that the planner did not know about would
 * reintroduce precisely the discrepancy this design exists to prevent.
 *
 * ## The preview does not echo values back
 *
 * The response carries counts, source keys, target names, statuses and warnings —
 * never a value, in either mode. The client already has the file it just
 * uploaded; sending the values back would put every secret in the browser's
 * network log, in any proxy that terminates TLS on a corporate network, and in
 * whatever error reporter the dashboard ships with, in exchange for nothing.
 *
 * ## Everything or nothing
 *
 * The writes run in one transaction. A half-applied import leaves an environment
 * in a state nobody chose and no screen describes, and the user's only recovery
 * is to work out which of forty secrets landed.
 */

/**
 * The most secrets one import may write.
 *
 * The 1 MB body ceiling bounds the *bytes* but not the *rows*: a file of
 * thousands of one-character entries fits easily, and each row costs an
 * encryption, an HMAC and an INSERT inside a single transaction. Without a bound
 * this is the one write path in the product whose work is unbounded per request.
 * Well above any real configuration file, and reported as `payload_too_large`
 * because it is the size of the request that is the problem.
 */
const MAX_IMPORT_ITEMS = 1000;

const PARSERS: Readonly<Record<ImportFormat, (content: string) => ParseResult>> = {
  dotenv: parseDotenv,
  json: parseJson,
  yaml: parseYaml,
  shell: parseShell,
};

/** The plan's statuses, plus the one only a value comparison can produce. */
type ImportOutcome = ImportItemStatus | 'unchanged';

interface Params {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
}

export const POST = authenticatedRoute<Params>(
  async ({ request, params, principal, services, audit, record }) => {
    const scope = await resolveEnvironmentPath(principal, params, services);

    // Both, up front. An import creates and overwrites, and which of the two a
    // given file will do is not known until it has been parsed — so requiring
    // only `secret.create` here would let a caller with create-but-not-update
    // authority discover mid-request that they may overwrite after all.
    authorizeSecretAction(scope, principal, 'secret.create');
    authorizeSecretAction(scope, principal, 'secret.update');

    const writer = secretWriter(principal);

    // Applied to a dry run too. A preview parses a megabyte, reads every secret
    // in the environment and unwraps the environment key; it writes nothing, but
    // it is not cheap, and "it is only a preview" is not a reason to leave it
    // unmetered.
    await enforceSecretRateLimit(services, principal, 'write');

    const body = await parseJsonBody(request, importBody);

    // `detectFormat` weighs the file name above the content, because someone who
    // named a file `config.yaml` knows what is in it. An explicit `format` always
    // wins over both.
    const format = body.format ?? detectFormat(body.filename ?? '', body.content).format;
    const parsed = PARSERS[format](body.content);

    // Unpaginated and complete, which is what the planner needs: a plan built
    // against the first page of existing names would classify an existing secret
    // as `create` and then fail against `secrets_env_name_idx`. It also carries
    // `value_hmac` and the secret ids, so the same rows answer "does this name
    // exist", "which secret does it name" and "has the value actually changed".
    const existing = await loadEnvironmentSecrets(
      services.db,
      scope.organization.id,
      scope.environment.id,
    );

    const plan = buildImportPlan({
      parsed,
      existingNames: existing.map((secret) => secret.name),
      strategy: body.strategy,
    });

    const current = new Map(existing.map((secret) => [secret.name, secret]));
    const writes: SecretWrite[] = [];

    for (const item of plan.items) {
      // `skip` and `invalid` are the planner's decisions, and the writer's only
      // job is to execute `items` — it does not re-adjudicate them.
      if (item.status === 'skip' || item.status === 'invalid') continue;

      const target = current.get(item.targetName);

      writes.push({
        name: item.targetName,
        value: item.value,
        ...(target
          ? {
              existing: {
                secretId: target.secretId,
                version: target.version,
                valueHmac: target.valueHmac,
              },
            }
          : {}),
      });
    }

    if (writes.length > MAX_IMPORT_ITEMS) {
      throw errors.tooLarge(
        `An import cannot write more than ${MAX_IMPORT_ITEMS} secrets at once.`,
      );
    }

    const results = await applySecretWrites(scope, services, {
      writer,
      writes,
      dryRun: body.dryRun,
    });

    // Keyed by target name, which the planner guarantees is unique within a plan
    // — it tracks the names it has already claimed precisely so that two source
    // keys cannot both resolve to one secret.
    const outcomes = new Map(results.map((result) => [result.name, result.status]));

    const items = plan.items.map((item) => {
      const status: ImportOutcome =
        outcomes.get(item.targetName) === 'unchanged' ? 'unchanged' : item.status;

      // `sourceKey` and `targetName` are names, and `note` is written by the
      // planner from names and rules. No value is reachable from this object.
      return {
        sourceKey: item.sourceKey,
        name: item.targetName,
        status,
        note: item.note ?? null,
      };
    });

    const counts: Record<ImportOutcome, number> = { ...plan.counts, unchanged: 0 };
    for (const item of items) {
      if (item.status !== 'unchanged') continue;
      counts.unchanged += 1;
      // An unchanged item was planned as an overwrite; moving it keeps the
      // counts a partition of the items rather than an overlapping tally.
      counts.overwrite -= 1;
    }

    const written = results.filter((result) => result.status !== 'unchanged').length;

    // A dry run is not audited: it writes nothing and decrypts nothing — it
    // computes HMACs of values the caller already holds. §7 audits mutations,
    // decryptions and denials, and a preview is none of the three.
    if (!body.dryRun) {
      record(
        audit(scope.organization.id).success(
          'secret.imported',
          {
            type: 'environment',
            id: scope.environment.id,
            projectId: scope.project.id,
            environmentId: scope.environment.id,
          },
          {
            secretCount: written,
            projectSlug: scope.project.slug,
            environmentSlug: scope.environment.slug,
            source: auditSource(principal),
            reason: body.strategy,
          },
        ),
      );
    }

    return json({
      dryRun: body.dryRun,
      format,
      strategy: body.strategy,
      counts,
      items,
      warnings: plan.warnings,
    });
  },
);
