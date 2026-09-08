import js from '@eslint/js';
import typescriptEslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';
import vitest from '@vitest/eslint-plugin';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// Packages that reach the outside world. The domain layer may never import one, and the
// application layer may only reach them through a port.
const INFRASTRUCTURE_ONLY_PACKAGES = [
  'pg',
  'pg-*',
  'undici',
  'fastify',
  'fastify/*',
  '@fastify/*',
  'ioredis',
  'redis',
  'pino',
  'pino-*',
  'next',
  'next/*',
];

// `else` is banned outright, including `else if`. Guard clauses, early returns and lookup tables
// express the same control flow without the nesting that hides a missing branch.
const NO_ELSE = {
  selector: 'IfStatement[alternate]',
  message:
    'Do not use else. Use a guard clause, an early return, an extracted function, or a lookup table.',
};

// Money is integer minor units. These turn a rounding bug into a build failure.
const NO_FLOAT_MONEY = [
  {
    selector: 'CallExpression[callee.name="parseFloat"]',
    message: 'Floating-point parsing is banned. Money is integer minor units; use BigInt.',
  },
  {
    selector: 'CallExpression[callee.object.name="Number"][callee.property.name="parseFloat"]',
    message: 'Floating-point parsing is banned. Money is integer minor units; use BigInt.',
  },
  {
    selector: 'CallExpression[callee.property.name="toFixed"]',
    message: 'toFixed implies floating-point money. Format from integer minor units instead.',
  },
];

export default typescriptEslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
    ],
  },

  js.configs.recommended,
  ...typescriptEslint.configs.recommendedTypeChecked,
  unicorn.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-restricted-syntax': ['error', NO_ELSE, ...NO_FLOAT_MONEY],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-param-reassign': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'after-used', argsIgnorePattern: '^(?!_)' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      // Names must be spelled out. This is the "no abbreviated variable names" rule, enforced.
      'unicorn/name-replacements': [
        'error',
        {
          checkFilenames: false,
          replacements: {
            transaction: false,
            props: false,
            params: false,
            db: { database: true },
            req: { request: true },
            res: { response: true },
            err: { error: true },
            cfg: { configuration: true },
            amt: { amount: true },
            txn: { transaction: true },
            tx: { transaction: true },
            usr: { user: true },
            svc: { service: true },
            repo: { repository: true },
            cred: { credential: true },
            prov: { provider: true },
          },
        },
      ],
      // A fold over amounts reads better than a mutable accumulator loop, and these folds
      // are short and total. The rule's readability argument does not apply to them.
      'unicorn/no-array-reduce': 'off',
      'unicorn/no-null': 'off',
      'unicorn/prefer-top-level-await': 'off',
    },
  },

  // The domain is pure. It knows nothing about how anything is stored or transported.
  {
    files: ['apps/api/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [...INFRASTRUCTURE_ONLY_PACKAGES, '**/infrastructure/**', '**/interface/**'],
              message:
                'The domain layer must not depend on infrastructure. Move this behind a port in application/ports.',
            },
          ],
        },
      ],
    },
  },

  // The application layer orchestrates the domain through ports, never through a concrete adapter.
  {
    files: ['apps/api/src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [...INFRASTRUCTURE_ONLY_PACKAGES, '**/infrastructure/**'],
              message:
                'The application layer depends on ports, not adapters. Import from application/ports instead.',
            },
          ],
        },
      ],
    },
  },

  // packages/shared is imported by the browser dashboard, so its root surface stays node-free.
  {
    files: ['packages/shared/src/**/*.ts'],
    ignores: ['packages/shared/src/server/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message:
                'The browser-safe surface of packages/shared must not import node builtins. Put node-only code under packages/shared/src/server.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'e2e/**/*.ts'],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      '@typescript-eslint/no-non-null-assertion': 'off',
      'unicorn/name-replacements': 'off',
    },
  },

  {
    files: ['scripts/**/*.mjs', '*.config.js', '*.config.mjs', '*.config.ts'],
    extends: [typescriptEslint.configs.disableTypeChecked],
    rules: {
      // These are command-line tools. Printing progress and exiting with a status code is
      // their interface, not a smell.
      'no-console': 'off',
      'unicorn/no-process-exit': 'off',
    },
  },

  prettier,
);
