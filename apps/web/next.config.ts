import type { NextConfig } from 'next';

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
