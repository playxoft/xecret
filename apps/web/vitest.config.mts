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
  // The app's tsconfig says `jsx: preserve`, because Next compiles JSX itself.
  // Tests that render a component to static markup (`react-dom/server`, no DOM)
  // need it compiled here instead, with the automatic runtime Next uses.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
});
