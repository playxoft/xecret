import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  {
    name: 'xecret/security',
    rules: {
      // ── ADR 0003: the Firebase Admin SDK cannot run on Cloudflare Workers. ──
      // It must never arrive, not even as a convenience import during debugging.
      'no-restricted-imports': [
        'error',
        {
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
      'no-restricted-imports': 'off',
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
