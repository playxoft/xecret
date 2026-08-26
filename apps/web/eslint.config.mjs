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
          paths: FIREBASE_ADMIN_BAN.paths,
          patterns: [
            ...FIREBASE_ADMIN_BAN.patterns,
            {
              group: ['node:fs', 'node:fs/*', 'fs', 'fs/*'],
              message:
                'Cloudflare Workers have no filesystem. If you need persistent state, use the database or a binding.',
            },
          ],
        },
      ],

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
      // the filesystem survives here; only the filesystem group is dropped.
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
