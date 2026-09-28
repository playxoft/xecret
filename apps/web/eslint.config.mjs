import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

/**
 * ── ADR 0003: the Firebase Admin SDK cannot run on Cloudflare Workers. ──
 * It must never arrive, not even as a convenience import during debugging.
 *
 * Held in a constant rather than written inline because two config blocks below
 * need it and `no-restricted-imports` is all-or-nothing per block: the
 * build-time exemption for the documentation loader has to re-state this ban in
 * order to drop the filesystem one, and a security rule that exists in two
 * hand-maintained copies is a security rule that will exist in one.
 */
const FIREBASE_ADMIN_BAN = {
  paths: [
    {
      name: 'firebase-admin',
      message:
        'firebase-admin cannot run on Cloudflare Workers (Node-native deps). Use firebase-auth-cloudflare-workers. See docs/adr/0003-firebase-as-identity-provider.md',
    },
  ],
  patterns: [
    {
      group: ['firebase-admin/*'],
      message:
        'firebase-admin cannot run on Cloudflare Workers. Use firebase-auth-cloudflare-workers. See docs/adr/0003-firebase-as-identity-provider.md',
    },
  ],
};

/**
 * ── Test databases never reach the edge. ──
 *
 * `@xecret/db/testing` is a real PostgreSQL (PGlite, WASM) for tests. It is a
 * package export, so it is importable from a route — and a route that imported
 * it would bundle a devDependency into the Worker, or quietly answer from a
 * database nobody uses. Banned everywhere, lifted only for `*.test.ts` below.
 * The same ban, with the same message, is in the root `eslint.config.mjs`.
 */
const TEST_DATABASE_MESSAGE =
  'Test-only: a PGlite database for *.test.ts files. It must never reach runtime code or a script.';
const TEST_DATABASE_BAN = {
  paths: [
    { name: '@xecret/db/testing', message: TEST_DATABASE_MESSAGE },
    { name: '@electric-sql/pglite', message: TEST_DATABASE_MESSAGE },
  ],
  patterns: [
    {
      group: [
        '@electric-sql/pglite/*',
        '@electric-sql/pglite-*',
        '**/testing/pglite',
        '**/testing/pglite.*',
      ],
      message: TEST_DATABASE_MESSAGE,
    },
  ],
};

/**
 * The same ban for `import(...)`, which `no-restricted-imports` does not see —
 * the obvious way round a static-import ban. `no-restricted-syntax` on an
 * `ImportExpression` whose source is one of the same specifiers, as a string
 * or as a template literal without substitutions. Identical to the root
 * config's. Spread, never assigned: `no-restricted-syntax` is replaced
 * wholesale per block, like `no-restricted-imports`.
 */
const TEST_DATABASE_SPECIFIERS = [
  String.raw`^@xecret\/db\/testing(\/.*)?$`,
  String.raw`^@electric-sql\/pglite(\/.*|-.*)?$`,
  String.raw`(^|\/)testing\/pglite(\.[A-Za-z]+)?$`,
];
const TEST_DATABASE_DYNAMIC_IMPORT_BAN = TEST_DATABASE_SPECIFIERS.flatMap((specifier) => [
  { selector: `ImportExpression[source.value=/${specifier}/]`, message: TEST_DATABASE_MESSAGE },
  {
    selector: `ImportExpression[source.quasis.0.value.cooked=/${specifier}/]`,
    message: TEST_DATABASE_MESSAGE,
  },
]);

/** The filesystem ban `xecret/security` applies to everything that runs on a request. */
const FILESYSTEM_BAN_PATTERN = {
  group: ['node:fs', 'node:fs/*', 'fs', 'fs/*'],
  message:
    'Cloudflare Workers have no filesystem. If you need persistent state, use the database or a binding.',
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  {
    name: 'xecret/react-version',
    // eslint-config-next ships `settings.react.version: 'detect'`, and that
    // setting is the only route into eslint-plugin-react's detectReactVersion(),
    // which calls context.getFilename() — removed in ESLint 10. The plugin has
    // no release that supports ESLint 10 yet (jsx-eslint/eslint-plugin-react
    // #3977), so every react/* rule throws before it lints anything.
    //
    // Naming the version skips that branch entirely. It is not a workaround
    // holding a door shut: react is pinned to this exact version a few lines
    // into package.json, so 'detect' was only ever going to walk the
    // filesystem, once per rule, to rediscover a number already written down.
    // Keep the two in step — a stale value here silently mis-scopes the
    // version-gated rules rather than failing.
    settings: { react: { version: '19.2.8' } },
  },

  {
    name: 'xecret/security',
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...FIREBASE_ADMIN_BAN.paths, ...TEST_DATABASE_BAN.paths],
          patterns: [
            ...FIREBASE_ADMIN_BAN.patterns,
            ...TEST_DATABASE_BAN.patterns,
            FILESYSTEM_BAN_PATTERN,
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...TEST_DATABASE_DYNAMIC_IMPORT_BAN],

      // Secrets must never reach a log. console.log is the most common accident;
      // warn/error are permitted because they are reviewed and go to structured logging.
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // `any` erases the type safety that stops a secret being passed where a
      // name was expected. Opt out explicitly and locally when genuinely needed.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  {
    name: 'xecret/server-is-not-react',
    files: ['src/server/**/*.ts', 'src/app/api/**/*.ts'],
    rules: {
      // None of this runs in React. The rules-of-hooks lint is name-based, so a
      // perfectly ordinary callback parameter called `use` — as in
      // `withEnvironmentKey(scope, services, use)` — is reported as an illegally
      // placed hook. Renaming server code to appease a React linter would be the
      // tail wagging the dog; scoping the rule to where React actually runs is
      // the honest fix.
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },

  {
    name: 'xecret/test-database-is-test-only',
    // Every test may use the test database — that is what it is for — and
    // nothing else may. Reasoned like `xecret/tests-never-reach-the-edge`
    // below: the exemption is keyed to the `*.test.ts` suffix, not to a
    // directory a runtime helper could later sit in. Only the test-database
    // ban is lifted; the filesystem and `firebase-admin` bans still apply,
    // exactly as in `xecret/security`.
    //
    // Deliberately *before* the two blocks that narrow the rule further: ESLint
    // applies the last matching block, so placed after them this one re-imposed
    // the filesystem ban on `docs/_lib/docs-content.test.ts` and on the three
    // named source-reading tests, all of which read files by design.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: FIREBASE_ADMIN_BAN.paths,
          patterns: [...FIREBASE_ADMIN_BAN.patterns, FILESYSTEM_BAN_PATTERN],
        },
      ],
      // `xecret/security`'s `no-restricted-syntax` is the test-database ban and
      // nothing else (the Next.js presets declare none), so lifting it leaves no
      // selectors. If that block ever gains selectors of its own, restate them
      // here without the ban.
      'no-restricted-syntax': 'off',
    },
  },

  {
    name: 'xecret/published-content-is-read-at-build-time',
    files: ['src/app/docs/_lib/**/*.ts', 'src/app/blog/_lib/**/*.ts'],
    rules: {
      // The filesystem ban above is right for everything that runs on a
      // request. These modules do not: every reader is a page with
      // `dynamicParams = false` or a `force-static` route handler, so all of it
      // executes during `next build` and none of it is reachable at the edge.
      //
      // The alternative — inlining twenty-five documents into a TypeScript
      // module — would put the published documentation somewhere nobody can
      // edit it as prose, to satisfy a rule about a runtime this code never
      // reaches. The blog reads its posts the same way, from `public/blog`.
      //
      // Stated as a narrower rule rather than as `'off'`, because ESLint
      // replaces a rule's configuration wholesale: switching it off to permit
      // `node:fs` also switched off ADR 0003's `firebase-admin` ban, in the one
      // directory where an exemption from this rule already looked deliberate
      // and nobody would think to check. The ban that has nothing to do with
      // the filesystem survives here; only the filesystem group is dropped. The
      // test-database ban survives too: build-time code is still not test code.
      'no-restricted-imports': [
        'error',
        {
          paths: [...FIREBASE_ADMIN_BAN.paths, ...TEST_DATABASE_BAN.paths],
          patterns: [...FIREBASE_ADMIN_BAN.patterns, ...TEST_DATABASE_BAN.patterns],
        },
      ],
    },
  },

  {
    name: 'xecret/tests-never-reach-the-edge',
    // Scoped to the tests that need it, named one by one, not to `**/*.test.ts`.
    // The ban exists because a `node:fs` import that reaches the worker bundle
    // is a 500 in production, and test files are only *usually* outside it — a
    // shared helper under `__tests__` that runtime code later imports is
    // exactly how that stops being true. Three files asking for the exemption is
    // a thing a reviewer can see; every test in the app holding it is not.
    files: [
      'src/app/pricing/pricing-page.test.ts',
      'src/app/marketing-pages.test.ts',
      'src/server/bindings.test.ts',
    ],
    rules: {
      // Same reasoning as the block above, one step further out: these files
      // are not in the worker bundle at all, and each asserts a property of the
      // *source* rather than of a value, so the source is what they have to
      // read. `pricing-page.test.ts` checks that the published limits are still
      // derived from the entitlements package rather than typed in by hand.
      // `bindings.test.ts` checks that every string binding declared on
      // `CloudflareEnv` also appears in `PROCESS_SUPPLIED` — the two have to
      // agree, and when they do not, `phase run` injects a value the
      // application cannot see and every request answers 503 while the
      // configuration looks correct everywhere somebody would think to look.
      //
      // Stated as the narrower rule rather than as `'off'`, for the reason
      // spelled out above: ESLint replaces a rule's configuration wholesale,
      // and switching this one off to permit `node:fs` would also switch off
      // ADR 0003's `firebase-admin` ban across every test in the app.
      'no-restricted-imports': ['error', FIREBASE_ADMIN_BAN],
    },
  },

  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    '.open-next/**',
    '.wrangler/**',
    'next-env.d.ts',
    'src/cloudflare-env.d.ts',
  ]),
]);

export default eslintConfig;
