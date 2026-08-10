import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // packages/core is runtime-agnostic by design (ADR 0005), so it tests under
    // plain Node against the same Web Crypto API the Worker provides.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
      // Crypto and authorization are the two modules where a gap in coverage is
      // a security gap. These thresholds are enforced in CI.
      thresholds: {
        'src/crypto/**': { statements: 95, branches: 90, functions: 95, lines: 95 },
        'src/authz/**': { statements: 95, branches: 90, functions: 95, lines: 95 },
      },
    },
  },
});
