import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { injectPages } from './src/pages/inject.js';
import { releaseCatalogMiddleware } from './src/downloads/dev-server.js';

// Injeta as tabelas geradas dos dados (benchmarks) no HTML das páginas, no build e no `vite dev`.
const injectGeneratedPages = () => ({
  name: 'nexus-inject-generated-pages',
  transformIndexHtml: { order: 'pre', handler: html => injectPages(html) },
});

// `vite dev` e `vite preview` não passam pelo Worker que atende /api/releases em produção. Sem isto o pedido cairia no
// fallback HTML e o hero (#hero-proof) ficaria preso à versão do snapshot embutido.
const serveReleaseCatalog = () => {
  const use = server => { server.middlewares.use(releaseCatalogMiddleware()); };
  return { name: 'nexus-serve-release-catalog', configureServer: use, configurePreviewServer: use };
};

export default defineConfig({
  plugins: [injectGeneratedPages(), serveReleaseCatalog()],
  build: {
    rolldownOptions: {
      input: {
        product: resolve('index.html'),
        community: resolve('comunidade/index.html'),
        conta: resolve('conta/index.html'),
        admin: resolve('admin/index.html'),
        benchmarks: resolve('benchmarks/index.html'),
      },
    },
  },
});
