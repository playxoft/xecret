import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * Lint configuration for the workspace packages.
 *
 * `apps/web` has its own config, because it needs the Next.js and React rules
 * and this one would fight them. What this file covers is everything else —
 * which, until it existed, was **nothing**: `npm run lint` ran only in
 * `apps/web`, so the envelope-encryption implementation and every database
 * query were unlinted. That is the wrong way round. `packages/core` is the
 * highest-risk code in the product.
 *
 * The security rules below are duplicated from `apps/web/eslint.config.mjs`
 * deliberately rather than shared through a common file. A shared config is one
 * edit away from being weakened everywhere at once; two copies mean a reviewer
 * sees the rule change twice.
 */

/**
 * ── The identity provider is WorkOS, reached only through `@workos-inc/node`. ──
 *
 * docs/adr/0010-workos-as-identity-provider.md. Firebase was used for nothing
 * but sign-in, so with sign-in moved every Firebase package is banned outright
 * rather than left importable: `firebase` (and the `@firebase/*` packages it is
 * made of) would be a second, unreviewed sign-in path in the browser;
 * `firebase-auth-cloudflare-workers` is the server half of the verifier that
 * was replaced; and `firebase-admin` never could run on Workers at all (ADR
 * 0003).
 *
 * `@workos-inc/authkit-nextjs` is banned beside them, and is the entry most
 * likely to be needed: it is WorkOS's own Next.js package and the first thing
 * its documentation installs. It is built around `authkitMiddleware` and its own
 * sealed session cookie. This deployment has no middleware and cannot have one
 * (ADR 0008), and it keeps its own session, listed and revoked in one place.
 * `apps/web/src/server/workos.ts` is the one boundary with WorkOS.
 *
 * A constant, even though the note above argues for hand-written copies. That
 * argument is about the *other* file: `apps/web` holding its own copy is what
 * makes a weakening visible twice to a reviewer. It says nothing about the
 * three blocks in this one file, which a reviewer reads in a single diff — and
 * hand-copying between them is what caused the bug this constant fixes.
 *
 * `no-restricted-imports` is replaced wholesale per block rather than merged,
 * so a later block that re-declares the rule for its own reasons silently drops
 * this ban. That is exactly what happened to its predecessor: `packages/core`
 * re-declared the rule for ADR 0005's runtime-agnostic list, and
 * `import admin from 'firebase-admin'` was lint-clean in the package this
 * config's own header calls the highest-risk code in the product. Every block
 * that declares the rule now spreads this in.
 */
const FIREBASE_MESSAGE =
  'Firebase is no longer the identity provider: WorkOS replaced it (docs/adr/0010-workos-as-identity-provider.md). Sign-in goes through @workos-inc/node in apps/web/src/server/workos.ts.';
const AUTHKIT_NEXTJS_MESSAGE =
  '@workos-inc/authkit-nextjs is built around authkitMiddleware and its own session cookie. This deployment has no middleware and cannot have one (docs/adr/0008-no-middleware.md), and keeps its own session (docs/adr/0010-workos-as-identity-provider.md). Use @workos-inc/node through apps/web/src/server/workos.ts.';
const IDENTITY_PROVIDER_BAN = {
  paths: [
    { name: 'firebase', message: FIREBASE_MESSAGE },
    { name: 'firebase-admin', message: FIREBASE_MESSAGE },
    { name: 'firebase-auth-cloudflare-workers', message: FIREBASE_MESSAGE },
    { name: '@workos-inc/authkit-nextjs', message: AUTHKIT_NEXTJS_MESSAGE },
  ],
  patterns: [
    {
      group: [
        'firebase/*',
        '@firebase/*',
        'firebase-admin/*',
        'firebase-auth-cloudflare-workers/*',
      ],
      message: FIREBASE_MESSAGE,
    },
    { group: ['@workos-inc/authkit-nextjs/*'], message: AUTHKIT_NEXTJS_MESSAGE },
  ],
};

/**
 * The same ban for `import(...)`, built exactly like the test-database one
 * below and for the same reason: a dynamic import is the obvious way round a
 * static-import ban, and "load the SDK only when the button is pressed" is
 * precisely how the Firebase client SDK used to be reached. Spread into every
 * block that declares `no-restricted-syntax`.
 */
const IDENTITY_PROVIDER_SPECIFIERS = [
  { specifier: String.raw`^@?firebase(\/.*)?$`, message: FIREBASE_MESSAGE },
  { specifier: String.raw`^firebase-admin(\/.*)?$`, message: FIREBASE_MESSAGE },
  { specifier: String.raw`^firebase-auth-cloudflare-workers(\/.*)?$`, message: FIREBASE_MESSAGE },
  { specifier: String.raw`^@workos-inc\/authkit-nextjs(\/.*)?$`, message: AUTHKIT_NEXTJS_MESSAGE },
];
const IDENTITY_PROVIDER_DYNAMIC_IMPORT_BAN = IDENTITY_PROVIDER_SPECIFIERS.flatMap(
  ({ specifier, message }) => [
    { selector: `ImportExpression[source.value=/${specifier}/]`, message },
    { selector: `ImportExpression[source.quasis.0.value.cooked=/${specifier}/]`, message },
  ],
);

/**
 * ── Test databases never reach runtime code. ──
 *
 * `@xecret/db/testing` is a real PostgreSQL (PGlite, WASM) for tests, exported
 * from the package so `apps/web` route tests can use it too. Exported means
 * importable — from a repository, a route, a script — and PGlite is a
 * devDependency that must never be bundled into a Worker or quietly stand in
 * for the real database. So both it and PGlite itself are banned everywhere,
 * and the ban is lifted only for `*.test.ts` files and the helper's own module.
 * The same ban, with the same message, is in `apps/web/eslint.config.mjs`.
 *
 * Spread into every block below that declares `no-restricted-imports`, for the
 * reason `IDENTITY_PROVIDER_BAN` explains: a later declaration replaces the rule
 * wholesale, so a block that forgot this would silently drop it.
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
 * The same ban for `import(...)`, which `no-restricted-imports` does not see.
 *
 * A dynamic import is the obvious way round a static-import ban — and the
 * natural shape for "only load the test database when we need it" — so it is
 * closed the same way, with the same specifiers: `no-restricted-syntax` on an
 * `ImportExpression` whose source is one of them, as a plain string or as a
 * template literal with no substitutions. (A computed specifier cannot be
 * checked statically; nothing in the codebase builds one.)
 *
 * Spread, never assigned: `no-restricted-syntax` is replaced wholesale per
 * block exactly like `no-restricted-imports`, so a block that declares it for
 * its own reasons must spread this in beside its own selectors.
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

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    '**/.next/**',
    '**/.open-next/**',
    '**/.wrangler/**',
    'apps/web/**',
    'cli/**',
    'packages/db/migrations/**',
  ]),

  {
    /**
     * Package source, linted with type information.
     *
     * Scoped to `src/` because only those files are inside a tsconfig program.
     * Build and test configuration (`vitest.config.ts`) and the operator scripts
     * are not, and pulling them in would mean either a second tsconfig per
     * package or an `allowDefaultProject` list that quietly grows. They are
     * still linted, one block down, without type information.
     */
    files: ['packages/*/src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      // Type-aware linting costs a TypeScript program per run — a few seconds,
      // where syntactic rules are instant. It earns that for one rule:
      // `no-floating-promises`. In a Worker a dropped promise is a write that
      // never happened, and the write most easily forgotten is the audit record.
      // A log quietly missing entries is worse than one visibly broken.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Secrets must never reach a log. `warn`/`error` are permitted because
      // they are reviewed and go to structured logging; `console.log` is the
      // most common accident.
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // `any` erases the type safety that stops a secret being passed where a
      // name was expected. Opt out explicitly and locally when genuinely needed.
      '@typescript-eslint/no-explicit-any': 'error',

      // The reason type-aware linting is switched on at all. Deliberate
      // fire-and-forget must say so with `void`, which is greppable; an
      // accidentally dropped promise is not.
      '@typescript-eslint/no-floating-promises': 'error',

      'no-restricted-imports': [
        'error',
        {
          paths: [...IDENTITY_PROVIDER_BAN.paths, ...TEST_DATABASE_BAN.paths],
          patterns: [...IDENTITY_PROVIDER_BAN.patterns, ...TEST_DATABASE_BAN.patterns],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...IDENTITY_PROVIDER_DYNAMIC_IMPORT_BAN,
        ...TEST_DATABASE_DYNAMIC_IMPORT_BAN,
      ],

      // Underscore-prefixed parameters are a documented "deliberately unused"
      // signal — `redactValue(_value)` exists so no path can carry its input to
      // its output.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    /**
     * Tests may use the test database; nothing else may.
     *
     * Named after — and reasoned like — `xecret/tests-never-reach-the-edge` in
     * `apps/web/eslint.config.mjs`: the exemption goes to test files and to the
     * helper's own module, not to a directory a runtime file could later sit
     * in. `packages/core` tests are not exempted — core has no database, and
     * the core block below re-applies its own, stricter, list to them anyway.
     */
    name: 'xecret/test-database-is-test-only',
    files: ['packages/*/src/**/*.test.ts', 'packages/db/src/testing/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', IDENTITY_PROVIDER_BAN],
      // Every other block's `no-restricted-syntax` is the identity-provider
      // ban and the test-database ban and nothing else, so lifting the second
      // leaves exactly the first. If a block ever gains selectors of its own,
      // restate them here without the test-database ban.
      'no-restricted-syntax': ['error', ...IDENTITY_PROVIDER_DYNAMIC_IMPORT_BAN],
    },
  },

  {
    // `packages/core` must run unchanged in a Worker, in a browser, and under
    // Node. Anything Node-specific here would not fail until deploy.
    files: ['packages/core/**/*.ts'],
    rules: {
      // ADR 0005's list *plus* the identity-provider ban, because this
      // declaration replaces the one above rather than adding to it. Narrowing
      // a block to the rule it cares about is what once let `firebase-admin`
      // through here.
      'no-restricted-imports': [
        'error',
        {
          // Bare specifiers listed by name, not by glob. A glob of `crypto`
          // also matches the relative path `../crypto/encoding`, which is one
          // of this package's own modules — the rule then bans exactly the code
          // it was written to protect.
          paths: [
            ...IDENTITY_PROVIDER_BAN.paths,
            ...TEST_DATABASE_BAN.paths,
            ...['fs', 'path', 'crypto', 'buffer', 'os', 'child_process', 'stream', 'util'].map(
              (name) => ({
                name,
                message:
                  'packages/core is runtime-agnostic (ADR 0005). Use Web APIs — Web Crypto, TextEncoder, Uint8Array — so the same code runs on Workers, in the browser, and under Node.',
              }),
            ),
          ],
          patterns: [
            ...IDENTITY_PROVIDER_BAN.patterns,
            ...TEST_DATABASE_BAN.patterns,
            {
              group: ['node:*'],
              message:
                'packages/core is runtime-agnostic (ADR 0005). Use Web APIs — Web Crypto, TextEncoder, Uint8Array — so the same code runs on Workers, in the browser, and under Node.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...IDENTITY_PROVIDER_DYNAMIC_IMPORT_BAN,
        ...TEST_DATABASE_DYNAMIC_IMPORT_BAN,
      ],
    },
  },

  {
    /**
     * Everything else in the workspace: the operator scripts and per-package
     * build configuration. Syntactic rules only — see the note above.
     *
     * `scripts/keygen.ts` is security-critical and is linted here rather than
     * with type information. That is a real, if small, gap: worth knowing about,
     * not worth a second tsconfig for two files that are covered by 29 tests in
     * `packages/core/src/crypto/escrow.test.ts`.
     *
     * A package's own `scripts` directory is here for the same reason: a
     * package-level build script — `packages/core/scripts/generate-vectors.ts`
     * is the only one today — is an operator script that happens to live next
     * to its package. It also matches the `packages/core` block above, which
     * bans Node imports; that ban is right for code that ships to a Worker and
     * wrong for a script that only ever runs under Node, and this block, being
     * later, replaces it with the plain identity-provider ban. Nothing under
     * `src` is affected, which is the code the ban exists for.
     */
    files: ['scripts/**/*.ts', 'packages/*/scripts/**/*.ts', 'packages/*/*.config.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'error',

      // These files run under Node and never reach the Worker or a browser, so
      // most of what the identity-provider ban is about — `firebase-admin`'s
      // Node-native dependencies, a second sign-in path, a middleware this
      // deployment cannot have — does not apply to them on its own terms. The
      // ban is here anyway, because the thing it actually prevents is one of
      // those packages entering `package.json` at all: once installed for one
      // script it resolves from every workspace, and the scripts already
      // import from `apps/web` and `packages/core`, so "just for a script" is
      // one refactor from shipping.
      //
      // The test database is banned here too: an operator script that ran
      // against PGlite would report success about a database nobody uses.
      'no-restricted-imports': [
        'error',
        {
          paths: [...IDENTITY_PROVIDER_BAN.paths, ...TEST_DATABASE_BAN.paths],
          patterns: [...IDENTITY_PROVIDER_BAN.patterns, ...TEST_DATABASE_BAN.patterns],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...IDENTITY_PROVIDER_DYNAMIC_IMPORT_BAN,
        ...TEST_DATABASE_DYNAMIC_IMPORT_BAN,
      ],
    },
  },

  {
    files: ['**/*.test.ts'],
    rules: {
      // Tests legitimately reach for `any` to construct invalid input that the
      // production types forbid — which is precisely what makes them tests.
      '@typescript-eslint/no-explicit-any': 'off',

      // A stub implementing an async interface method has nothing to await, and
      // dropping `async` would change its return type. Fine in production code
      // too, but it only actually comes up in test doubles.
      '@typescript-eslint/require-await': 'off',
    },
  },
]);
