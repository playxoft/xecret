import type { NextConfig } from 'next';

import { contentSecurityPolicy } from './src/lib/csp';

const nextConfig: NextConfig = {
  reactStrictMode: true,

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
