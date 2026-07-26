// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-bundle/**',
      'build/**',
      'coverage/**',
      'grammars/**',
      'tests/fixtures/**',
      // Build and tooling scripts are plain Node ESM, deliberately outside the
      // TypeScript project. Every rule here is type-aware, and the project
      // service cannot resolve files that belong to no tsconfig — it reports
      // them as unparseable. Pulling them in with `allowJs` would drag them into
      // the build too, so they are simply not linted.
      //
      // To lint them, add a block with `files: ['**/*.mjs']`, `projectService:
      // false`, and `rules: { ...tseslint.configs.disableTypeChecked.rules }` —
      // note the rules must be *merged*, not spread alongside a later `rules`
      // key, which silently replaces them.
      '**/*.mjs',
      'eslint.config.js',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The server speaks JSON-RPC over stdout. Writing to stdout corrupts the
      // protocol stream, so console usage is banned outright; use the logger.
      'no-console': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'console', message: 'Use the structured logger (src/shared/logger.ts); stdout is the MCP transport.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'stdout', message: 'stdout is reserved for the MCP JSON-RPC transport.' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-param-reassign': 'error',
    },
  },
  {
    // Tests may use looser typing for fixtures and may print via vitest.
    files: ['tests/**/*.ts', '**/*.test.ts', '**/*.bench.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      'no-restricted-properties': 'off',
    },
  },
  {
    // The transport bootstrap is the one place allowed to touch stdout.
    files: ['src/main.ts', 'src/tools/transport.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  prettier,
);
