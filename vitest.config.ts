import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'domain',
          root: './apps/api',
          include: ['src/domain/**/*.test.ts', 'src/application/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'shared',
          root: './packages/shared',
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
        test: {
          name: 'integration',
          root: './apps/api',
          include: ['src/infrastructure/**/*.test.ts', 'src/interface/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 60_000,
          fileParallelism: false,
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
