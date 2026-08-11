import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // `passWithNoTests` was set during Phase 1 scaffolding with a note to remove
    // it once the application layer had logic worth testing. Phase 3 landed that
    // layer, so it is gone: an empty run now fails, which is the point.
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
});
