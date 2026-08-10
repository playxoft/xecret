import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Phase 1 is scaffolding: the app has no logic worth testing yet. Remove
    // this the moment the first route handler lands in Phase 3 — it must not
    // become a permanent excuse for an untested application layer.
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
});
