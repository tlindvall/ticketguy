import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts', 'tests/acceptance/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'pg',
          include: ['tests/pg/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // These files share one disposable database and some of them drop and recreate the schema in
          // beforeAll, so running two of them at once makes the loser query tables that no longer exist.
          // Serialising the project is the only thing that makes the shared database safe.
          fileParallelism: false,
        },
      },
    ],
  },
});
