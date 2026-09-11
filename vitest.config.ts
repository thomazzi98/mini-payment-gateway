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
          // These tests do milliseconds of work; the headroom is for module
          // transform on a cold, loaded machine. The default 5s failed here only
          // when a container build was saturating every core, which is a false
          // failure and exactly what a CI runner looks like under load.
          testTimeout: 15_000,
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
        // The checkout's pure modules: how a gateway record becomes a screen.
        test: {
          name: 'dashboard',
          root: './apps/dashboard',
          include: ['src/**/*.test.ts'],
          environment: 'node',
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
      {
        // The whole demonstration against the running stacks. Serial, slow, and
        // never part of the default run: it needs three stacks and a chain.
        test: {
          name: 'e2e',
          root: './e2e',
          include: ['**/*.e2e.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 60_000,
          fileParallelism: false,
          sequence: { concurrent: false },
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
