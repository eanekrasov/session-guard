import prettierConfig from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';
import tseslint from 'typescript-eslint';

const SUITE_BOUNDARY =
  'the host smoke suite drives the built plugin (dist): import nothing from outside smoke/';

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
    // through a real host and must not reach into the plugin's sources, or a
    // scenario starts passing because of internals instead of the artifact.
    //
    // The rule bans leaving `smoke/` rather than naming the plugin's paths: from
    // `smoke/src/` one `..` is the suite root, from `smoke/test/` two, so a
    // literal `../src/*` would forbid the suite's own sources from its tests. A
    // new nesting level needs its own block here.
    files: ['smoke/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: '@eanekrasov/session-guard', message: SUITE_BOUNDARY }],
          patterns: [{ group: ['../../**'], message: SUITE_BOUNDARY }],
        },
      ],
    },
  },
  {
    files: ['smoke/test/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: '@eanekrasov/session-guard', message: SUITE_BOUNDARY }],
          patterns: [{ group: ['../../../**'], message: SUITE_BOUNDARY }],
        },
      ],
    },
  },
  prettierConfig,
];
