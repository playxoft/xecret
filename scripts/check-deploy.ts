#!/usr/bin/env -S npx tsx
/**
 * Compares the three places a deployment's configuration lives, and names
 * whatever is missing from any of them.
 *
 *   phase run --env Production -- npx tsx scripts/check-deploy.ts production
 *
 * `check-env.ts` answers "are the values in this shell sane?". This answers the
 * question that comes after it, and that nothing else asked: **will the Worker
 * that is about to exist actually have them?** The two are different questions
 * because a value can be perfect in Phase.dev, absent from the Worker, and
 * nothing in the build or the deploy will say so.
 *
 * The three sources:
 *
 *   1. **The environment this runs under** — Phase.dev, or whatever else
 *      populates it. Presence only; no value is read for comparison.
 *   2. **wrangler.toml**, for the environment being deployed. Read through
 *      wrangler's own config reader, so this cannot disagree with the deploy
 *      about what the file says.
 *   3. **The live Worker** — the bindings of the version currently serving
 *      traffic, plus the names of its encrypted secrets.
 *
 * ── Why this exists ──
 *
 * `wrangler deploy` REPLACES a Worker's plaintext vars with exactly the `vars`
 * table of the environment being deployed. Anything added by hand in the
 * dashboard survives until the next deploy and is then silently dropped. Two
 * mechanisms persist — a `vars` entry in the committed config, and an encrypted
 * secret set with `wrangler secret put` — and a value held in neither has an
 * expiry date nobody wrote down.
 *
 * The failure that motivated this: production ran for days with no
 * `ZEPTOMAIL_TOKEN`, so every transactional email — including the PIN reset
 * link — was declined by a code path designed to treat mail as optional. The
 * deploy was green, the site was up, and the only symptom was mail that never
 * arrived.
 *
 * It reads values but never prints them. Where something is shown it is either
 * a name, a type, or a value that is already public.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Where a variable is *allowed* to live by the time the Worker runs. */
type Home =
  /** Not a credential. Belongs in `[env.<env>.vars]`, which every deploy re-asserts. */
  | 'var'
  /** A credential. Belongs in `wrangler secret put`, which deploys carry forward. */
  | 'secret'
  /** Held in Cloudflare Secrets Store and reached through a binding. */
  | 'store'
  /** Consumed by `next build`; never reaches the Worker and must not be a var. */
  | 'build'
  /** The Worker never reads it. Present in Phase for migrations or local work. */
  | 'unused';

interface Contract {
  name: string;
  home: Home;
  /** Whether the deployment is broken without it. */
  required: boolean;
  /** What breaks, in the words an operator would use. */
  matters: string;
}

/**
 * Every name the deployment touches, and where each one belongs.
 *
 * Kept here rather than derived from `CloudflareEnv` because the interesting
 * property is not "does the type exist" but "which of the four homes is correct
 * for it" — a judgement about sensitivity that a type cannot carry.
 */
const CONTRACT: Contract[] = [
  {
    name: 'XECRET_ENV',
    home: 'var',
    required: true,
    matters: 'names the deployment in every log line',
  },
  {
    name: 'XECRET_PUBLIC_URL',
    home: 'var',
    required: true,
    matters: 'the origin baked into canonicals, sitemap.xml and mail links',
  },
  {
    name: 'XECRET_ROOT_KEY_VERSION',
    home: 'var',
    required: true,
    matters: 'which root key wraps new secrets',
  },
  {
    name: 'FIREBASE_PROJECT_ID',
    home: 'var',
    required: true,
    matters:
      'the `aud` claim every ID token is checked against; wrong means every sign-in is rejected',
  },
  {
    name: 'ZEPTOMAIL_FROM_ADDRESS',
    home: 'var',
    required: false,
    matters: 'the address every message is sent from; absent means mail is declined',
  },
  {
    name: 'ZEPTOMAIL_FROM_NAME',
    home: 'var',
    required: false,
    matters: 'the display name beside that address',
  },
  {
    name: 'ZEPTOMAIL_TOKEN',
    home: 'secret',
    required: false,
    matters: 'authorises sending; absent means PIN reset mail is never delivered',
  },
  {
    name: 'ZEPTOMAIL_API_URL',
    home: 'var',
    required: false,
    matters: 'the regional endpoint; an EU or India account 401s without it',
  },
  {
    name: 'BETTERSTACK_SOURCE_TOKEN',
    home: 'secret',
    required: false,
    matters: 'authorises log shipping; absent means logs stay in Cloudflare only',
  },
  {
    name: 'BETTERSTACK_INGEST_URL',
    home: 'secret',
    required: false,
    matters: 'the source-specific ingest host; wrong means a 401 with no explanation',
  },
  {
    name: 'XECRET_LOG_LEVEL',
    home: 'secret',
    required: false,
    matters: 'raises log verbosity during an incident without a deploy',
  },
  {
    name: 'XECRET_ROOT_KEYS',
    home: 'store',
    required: true,
    matters: 'the Root KEK map — without it no secret in the product can be decrypted',
  },
  {
    name: 'NEXT_PUBLIC_FIREBASE_CONFIG',
    home: 'build',
    required: true,
    matters: 'inlined into the client bundle at build time; on the Worker it would do nothing',
  },
  {
    name: 'DATABASE_URL',
    home: 'unused',
    required: false,
    matters: 'ignored while HYPERDRIVE is bound; as a var it would only publish a password',
  },
  {
    name: 'MIGRATION_DATABASE_URL',
    home: 'unused',
    required: false,
    matters: 'the owner login, used by migrations only — it must never reach a Worker',
  },
];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(REPO_ROOT, 'apps', 'web');

function wrangler(args: string[]): string {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: WEB_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** The `vars` and Secrets Store bindings wrangler.toml declares for `env`. */
async function fromConfig(env: string): Promise<{ vars: Set<string>; store: Set<string> }> {
  const { unstable_readConfig } = await import('wrangler');
  const previous = process.cwd();
  process.chdir(WEB_DIR);
  try {
    const config = await unstable_readConfig({ env });
    return {
      vars: new Set(Object.keys(config.vars ?? {})),
      store: new Set((config.secrets_store_secrets ?? []).map((entry) => entry.binding)),
    };
  } finally {
    process.chdir(previous);
  }
}

interface LiveWorker {
  /** Plaintext vars, which the next deploy will overwrite wholesale. */
  plain: Set<string>;
  /** Encrypted secrets, which deploys carry forward. */
  secrets: Set<string>;
  /** Secrets Store bindings. */
  store: Set<string>;
  versionId: string;
}

/**
 * What the Worker serving traffic right now actually has.
 *
 * The active version rather than the newest: a gradual deployment can leave a
 * newer version uploaded and not yet serving, and the question this script
 * answers is about the one taking requests.
 */
function fromLiveWorker(env: string): LiveWorker | null {
  let versionId: string;
  try {
    const status = JSON.parse(wrangler(['deployments', 'status', '--env', env, '--json'])) as {
      versions?: Array<{ version_id?: string }>;
    };
    const id = status.versions?.[0]?.version_id;
    if (typeof id !== 'string') return null;
    versionId = id;
  } catch {
    return null;
  }

  const version = JSON.parse(wrangler(['versions', 'view', versionId, '--env', env, '--json'])) as {
    resources?: { bindings?: Array<{ name?: string; type?: string }> };
  };

  const live: LiveWorker = {
    plain: new Set(),
    secrets: new Set(),
    store: new Set(),
    versionId,
  };

  for (const binding of version.resources?.bindings ?? []) {
    if (typeof binding.name !== 'string') continue;
    if (binding.type === 'plain_text') live.plain.add(binding.name);
    if (binding.type === 'secret_text') live.secrets.add(binding.name);
    if (binding.type === 'secrets_store_secret') live.store.add(binding.name);
  }

  // `secret list` is the authority on encrypted secrets; the version's bindings
  // are the authority on everything else. They agree in normal operation, and
  // where they do not it is the secret list that is right.
  try {
    const listed = JSON.parse(wrangler(['secret', 'list', '--env', env, '--format', 'json'])) as
      Array<{ name?: string }> | undefined;
    for (const secret of listed ?? []) {
      if (typeof secret.name === 'string') live.secrets.add(secret.name);
    }
  } catch {
    // Leave the version's view in place.
  }

  return live;
}

type Verdict = 'ok' | 'warn' | 'fail';

interface Finding {
  verdict: Verdict;
  name: string;
  detail: string;
}

function audit(
  env: string,
  config: { vars: Set<string>; store: Set<string> },
  live: LiveWorker | null,
): Finding[] {
  const findings: Finding[] = [];
  const add = (verdict: Verdict, name: string, detail: string): void => {
    findings.push({ verdict, name, detail });
  };

  for (const entry of CONTRACT) {
    const inPhase = typeof process.env[entry.name] === 'string' && process.env[entry.name] !== '';
    const inConfig = config.vars.has(entry.name);
    const onWorker =
      live === null
        ? false
        : live.plain.has(entry.name) || live.secrets.has(entry.name) || live.store.has(entry.name);

    switch (entry.home) {
      case 'var': {
        if (inConfig) {
          add(
            'ok',
            entry.name,
            `var in wrangler.toml (env.${env}.vars) — every deploy re-asserts it`,
          );
        } else if (onWorker) {
          add(
            'warn',
            entry.name,
            'on the Worker but NOT in wrangler.toml — the next deploy will remove it. ' +
              `Add it to [env.${env}.vars]. ${entry.matters}.`,
          );
        } else {
          add(
            entry.required ? 'fail' : 'warn',
            entry.name,
            `missing everywhere — ${entry.matters}`,
          );
        }
        break;
      }

      case 'secret': {
        if (live !== null && live.plain.has(entry.name)) {
          add(
            'fail',
            entry.name,
            'held as a PLAINTEXT var on the Worker. It is a credential: anyone with ' +
              'dashboard access can read it, and `wrangler versions view` prints it. ' +
              `Replace it with \`wrangler secret put ${entry.name} --env ${env}\`.`,
          );
        } else if (inConfig) {
          add(
            'fail',
            entry.name,
            'declared as a var in wrangler.toml, which is committed to the repository. ' +
              `Remove it and use \`wrangler secret put ${entry.name} --env ${env}\`.`,
          );
        } else if (onWorker) {
          add('ok', entry.name, 'encrypted secret on the Worker — carried across deploys');
        } else if (inPhase) {
          add(
            entry.required ? 'fail' : 'warn',
            entry.name,
            `in Phase but NOT on the Worker — ${entry.matters}. ` +
              `Run \`wrangler secret put ${entry.name} --env ${env}\`.`,
          );
        } else {
          add(entry.required ? 'fail' : 'ok', entry.name, `not set anywhere — ${entry.matters}`);
        }
        break;
      }

      case 'store': {
        if (config.store.has(entry.name) && (live === null || live.store.has(entry.name))) {
          add('ok', entry.name, 'Secrets Store binding — encrypted, and never a deploy-time value');
        } else if (config.store.has(entry.name)) {
          add('warn', entry.name, 'bound in wrangler.toml but not on the live Worker yet');
        } else {
          add('fail', entry.name, `no Secrets Store binding — ${entry.matters}`);
        }
        break;
      }

      case 'build': {
        if (!inPhase) {
          add(
            entry.required ? 'fail' : 'warn',
            entry.name,
            `not in this environment — ${entry.matters}`,
          );
        } else if (inConfig) {
          add(
            'warn',
            entry.name,
            `a var in wrangler.toml, but it is build-time only — ${entry.matters}`,
          );
        } else {
          add('ok', entry.name, 'present for the build, correctly absent from the Worker');
        }
        break;
      }

      case 'unused': {
        if (inConfig || (live !== null && live.plain.has(entry.name))) {
          add('fail', entry.name, `present on the Worker, which never reads it — ${entry.matters}`);
        } else {
          add('ok', entry.name, 'correctly absent from the Worker');
        }
        break;
      }
    }
  }

  // Anything on the Worker that nothing here knows about. A var nobody declared
  // is a var the next deploy deletes, and an unrecognised name is worth a look
  // either way.
  const known = new Set(CONTRACT.map((entry) => entry.name));
  for (const name of live?.plain ?? []) {
    if (known.has(name) || config.vars.has(name)) continue;
    findings.push({
      verdict: 'warn',
      name,
      detail:
        'a plaintext var on the Worker that neither wrangler.toml nor this script knows about — the next deploy removes it',
    });
  }

  return findings;
}

const SYMBOL: Record<Verdict, string> = { ok: '  ok  ', warn: ' warn ', fail: ' FAIL ' };

async function main(): Promise<void> {
  const env = process.argv[2] ?? 'production';

  const config = await fromConfig(env);
  const live = fromLiveWorker(env);

  console.log(`\nDeployment check — env.${env}\n`);
  console.log(
    live === null
      ? '  live Worker: not reachable (not deployed yet, or wrangler is not logged in)'
      : `  live Worker: version ${live.versionId}`,
  );
  console.log(`  wrangler.toml: ${config.vars.size} var(s) declared`);
  console.log('');

  const findings = audit(env, config, live);
  const width = Math.max(...findings.map((finding) => finding.name.length));

  for (const finding of findings) {
    console.log(`  [${SYMBOL[finding.verdict]}] ${finding.name.padEnd(width)}  ${finding.detail}`);
  }

  const failures = findings.filter((finding) => finding.verdict === 'fail');
  const warnings = findings.filter((finding) => finding.verdict === 'warn');

  console.log('');
  console.log(`  ${failures.length} failure(s), ${warnings.length} warning(s)\n`);

  if (failures.length > 0) {
    console.log(
      '  A failure here is a deployment that is broken or leaking. Fix it before deploying.\n',
    );
    process.exit(1);
  }
}

// Called rather than awaited at the top level: this repository's root
// package.json has no `"type": "module"`, so tsx transpiles to CJS, where a
// top-level await is a syntax error.
void main().catch((error: unknown) => {
  console.error(
    `\n  check:deploy failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
