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
      reporter: ['text-summary', 'lcov'],
      /**
       * Global thresholds rather than per-directory globs.
       *
       * Glob-keyed thresholds were tried first and could not be shown to
       * actually fail a run — a gate that does not gate is worse than no gate,
       * because it reads as coverage that was never enforced. These are verified
       * to fail the build when unmet.
       *
       * 95% is the bar set for crypto and authz in CONTRIBUTING.md. Applying it
       * to the whole package is stricter than promised, which is the right
       * direction to err.
       */
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
});
