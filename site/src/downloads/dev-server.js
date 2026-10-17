import { readReleaseCatalog } from './catalog.js';

const ROUTE = '/api/releases';

/**
 * Middleware (Connect) de /api/releases para `vite dev` e `vite preview`, que não passam pelo Worker. Entrega o mesmo
 * catálogo da produção (GitHub ao vivo; snapshot embutido como último recurso), então o hero mostra a release de fato.
 * ponytail: sem cache de borda. Cada pedido consulta o GitHub (60/h sem token) e, passado disso, o snapshot responde.
 * `deps` repassa { fetcher, cache } ao readReleaseCatalog (os testes injetam o fetcher; no Node não existe `caches`).
 */
export function releaseCatalogMiddleware(deps = {}) {
  return (request, response, next) => {
    const { method, url = '' } = request;
    if ((method !== 'GET' && method !== 'HEAD') || url.split('?')[0] !== ROUTE) return next();
    readReleaseCatalog(deps).then(payload => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(method === 'HEAD' ? undefined : JSON.stringify(payload));
    }).catch(next);
  };
}
