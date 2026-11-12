import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/rules-engine/**/*.vitest.ts'],
  },
});
