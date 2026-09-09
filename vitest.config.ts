import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Everything in the api that needs no external service. Fast, and the
        // suite that should fail first when something is wrong.
        test: {
          name: 'api',
          root: './apps/api',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
          environment: 'node',
        },
      },
      {
        // Runs against a real PostgreSQL. Serial, because these tests assert on
        // database state and would otherwise race each other.
        test: {
          name: 'integration',
          root: './apps/api',
          include: ['src/**/*.integration.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'tools',
          root: './scripts',
          include: ['**/*.test.mjs'],
          environment: 'node',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['apps/api/src/**', 'packages/shared/src/**'],
      exclude: ['**/*.test.ts', '**/main.*.ts'],
    },
  },
});
