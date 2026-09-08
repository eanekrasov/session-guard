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
    files: ['scripts/**/*.ts', 'test/**/*.ts', 'watcher.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  prettierConfig,
];
