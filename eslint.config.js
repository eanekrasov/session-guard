import prettierConfig from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['.memory/**', 'dist/**', '.opencode/**', 'node_modules/**'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      prettier: prettierPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['error', { allow: ['error'] }],
      'prettier/prettier': 'error',
    },
  },
  {
    files: ['scripts/**/*.ts', 'smoke/**/*.ts', 'test/**/*.ts', 'watcher.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // The smoke suite is a black box around the built plugin: it drives `dist`
    // through a real host and must not reach into the plugin's sources, or the
    // suite starts passing because of internals instead of the artifact. Without
    // this rule the boundary is only prose in `smoke/README.md`.
    files: ['smoke/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../src/*', '../../src/*', '@eanekrasov/session-guard'],
              message:
                'host smoke drives the built plugin (dist): import neither the plugin sources nor the package itself',
            },
          ],
        },
      ],
    },
  },
  prettierConfig,
];
