import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    rolldownOptions: {
      input: { product: resolve('index.html'), community: resolve('comunidade/index.html') },
    },
  },
});
