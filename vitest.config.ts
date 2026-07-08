import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.claude/**'],
    setupFiles: ['./src/test/vitest.setup.ts'],
  },
});
