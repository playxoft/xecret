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
 * ── ADR 0003: the Firebase Admin SDK cannot run on Cloudflare Workers. ──
 *
 * A constant, even though the note above argues for hand-written copies. That
 * argument is about the *other* file: `apps/web` holding its own copy is what
 * makes a weakening visible twice to a reviewer. It says nothing about the
 * three blocks in this one file, which a reviewer reads in a single diff — and
 * hand-copying between them is what caused the bug this constant fixes.
 *
 * `no-restricted-imports` is replaced wholesale per block rather than merged,
 * so a later block that re-declares the rule for its own reasons silently drops
 * this ban. That is exactly what happened: `packages/core` re-declared it for
 * ADR 0005's runtime-agnostic list, and `import admin from 'firebase-admin'`
 * lint-clean in the package this config's own header calls the highest-risk
 * code in the product. Every block that declares the rule now spreads this in.
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

      'no-restricted-imports': ['error', FIREBASE_ADMIN_BAN],

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
    // `packages/core` must run unchanged in a Worker, in a browser, and under
    // Node. Anything Node-specific here would not fail until deploy.
    files: ['packages/core/**/*.ts'],
    rules: {
      // ADR 0005's list *plus* ADR 0003's, because this declaration replaces
      // the one above rather than adding to it. Narrowing a block to the rule
      // it cares about is what let `firebase-admin` through here.
      'no-restricted-imports': [
        'error',
        {
          // Bare specifiers listed by name, not by glob. A glob of `crypto`
          // also matches the relative path `../crypto/encoding`, which is one
          // of this package's own modules — the rule then bans exactly the code
          // it was written to protect.
          paths: [
            ...FIREBASE_ADMIN_BAN.paths,
            ...['fs', 'path', 'crypto', 'buffer', 'os', 'child_process', 'stream', 'util'].map(
              (name) => ({
                name,
                message:
                  'packages/core is runtime-agnostic (ADR 0005). Use Web APIs — Web Crypto, TextEncoder, Uint8Array — so the same code runs on Workers, in the browser, and under Node.',
              }),
            ),
          ],
          patterns: [
            ...FIREBASE_ADMIN_BAN.patterns,
            {
              group: ['node:*'],
              message:
                'packages/core is runtime-agnostic (ADR 0005). Use Web APIs — Web Crypto, TextEncoder, Uint8Array — so the same code runs on Workers, in the browser, and under Node.',
            },
          ],
        },
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
     */
    files: ['scripts/**/*.ts', 'packages/*/*.config.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'error',

      // These files run under Node and never reach the Worker, so ADR 0003's
      // stated reason — Node-native dependencies do not load on Workers — does
      // not apply to them on its own terms. The ban is here anyway, because the
      // thing it actually prevents is `firebase-admin` entering `package.json`
      // at all: once installed for one script it resolves from every workspace,
      // and `scripts/check-env.ts` already imports from both `apps/web` and
      // `packages/core`, so "just for a script" is one refactor from shipping.
      // ADR 0003 and CONTRIBUTING both state the ban without qualification;
      // this is the last place the config disagreed with them.
      'no-restricted-imports': ['error', FIREBASE_ADMIN_BAN],
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
