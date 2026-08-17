import type { NextConfig } from 'next';

import { contentSecurityPolicy } from './src/lib/csp';
import { version } from './package.json';

/**
 * What `GET /api/version` answers with, resolved while the bundle is built.
 *
 * It has to happen here. The deployed Worker's `process.env` is the wrangler
 * `vars` block and nothing else — there is no build environment left to read at
 * request time — so a value that is not inlined during `next build` is simply
 * absent in production. Next's `env` key is the documented way to inline one,
 * and is what the three below travel through.
 *
 * `version` comes from `package.json` rather than a variable a deploy has to
 * remember to set, because a version that can disagree with the manifest is
 * worse than no version at all. The commit and the build time cannot come from
 * the same place — nothing in the tree knows them — so `scripts/deploy-web.sh`
 * exports them and an unstamped build says so rather than guessing.
 *
 * Next marks `env` legacy in favour of `.env` files. It is used anyway: a
 * `.env` value would have to be written by the deploy script into the working
 * tree, and a build artefact that edits the repository to describe itself is a
 * worse trade than a config key with a deprecation notice on it.
 */
const buildStamp = {
  XECRET_BUILD_VERSION: version,
  XECRET_BUILD_COMMIT: process.env.XECRET_BUILD_COMMIT ?? 'unknown',
  XECRET_BUILD_TIME: process.env.XECRET_BUILD_TIME ?? 'unknown',
};

const nextConfig: NextConfig = {
  reactStrictMode: true,

  env: buildStamp,

  // Workspace packages ship TypeScript source rather than a build artefact,
  // so Next transpiles them. See ADR 0005.
  transpilePackages: ['@xecret/core', '@xecret/db'],

  // A secret manager must not leak build or framework detail to clients.
  poweredByHeader: false,

  // Keep this honest — never flip it to true to make a build pass.
  // (Next 16 removed the `eslint` config key; linting is a separate CI step.)
  typescript: { ignoreBuildErrors: false },

  // ── `experimental.sri` was considered and not taken ──
  // It stamps an `integrity` hash on every emitted `<script src>`, which was
  // verified to work here. It was left off because what it defends against —
  // a same-origin asset altered between build and browser — is already covered
  // by HTTPS and by the assets being served from this deployment, while the
  // inline flight payload it cannot touch is the reason `script-src` needs
  // `'unsafe-inline'` regardless. An experimental flag that rewrites every
  // script tag in a secret manager should buy more than that.

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            // Built here rather than written as a literal because it has to
            // name the deployment's own Firebase domain — see `lib/csp.ts`,
            // which also records what this policy can and cannot enforce.
            key: 'Content-Security-Policy',
            value: contentSecurityPolicy({
              isDevelopment: process.env.NODE_ENV === 'development',
              firebaseConfig: process.env.NEXT_PUBLIC_FIREBASE_CONFIG,
            }),
          },
        ],
      },
    ];
  },
};

export default nextConfig;

// Makes Cloudflare bindings available to `next dev`, so local development runs
// against the same binding shapes as production.
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

void initOpenNextCloudflareForDev();
