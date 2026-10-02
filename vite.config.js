import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { injectPages } from './src/pages/inject.js';

// Injeta as tabelas geradas dos dados (benchmarks e comparação) no HTML das páginas, no build e no `vite dev`.
const injectGeneratedPages = () => ({
  name: 'nexus-inject-generated-pages',
  transformIndexHtml: { order: 'pre', handler: html => injectPages(html) },
});

export default defineConfig({
  plugins: [injectGeneratedPages()],
  build: {
    rolldownOptions: {
      input: {
        product: resolve('index.html'),
        community: resolve('comunidade/index.html'),
        conta: resolve('conta/index.html'),
        admin: resolve('admin/index.html'),
        benchmarks: resolve('benchmarks/index.html'),
        comparacao: resolve('comparacao/index.html'),
      },
    },
  },
});
