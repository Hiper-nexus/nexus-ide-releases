import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseCatalogMiddleware } from './dev-server.js';
import snapshot from './snapshot.js';

const REPO = 'https://github.com/Hiper-nexus/nexus-ide-releases/releases';
const PUBLIC_API = 'https://api.github.com/repos/Hiper-nexus/nexus-ide-releases/releases?per_page=100';
const offline = async () => { throw new Error('offline'); };

/** Release do GitHub no formato que o normalizeReleases aceita (Mac e Windows na mesma versão). */
function githubRelease(version, publishedAt) {
  const files = [`NexusIDE-${version}-arm64.dmg`, `NexusIDE-${version}-win32-x64-Setup.exe`];
  return { tag_name: `v${version}`, draft: false, prerelease: false, published_at: publishedAt, html_url: `${REPO}/tag/v${version}`,
    assets: files.map(name => ({ name, size: 1000, browser_download_url: `${REPO}/download/v${version}/${name}` })) };
}

/** Request/response mínimos do Connect: resolve quando o middleware responde ou passa a vez (next). */
function run(middleware, { method = 'GET', url = '/api/releases' } = {}) {
  return new Promise(resolve => {
    const out = { status: undefined, headers: undefined, body: undefined, passed: false, error: undefined };
    const response = {
      writeHead(status, headers) { out.status = status; out.headers = headers; },
      end(body) { out.body = body; resolve(out); },
    };
    middleware({ method, url }, response, error => { out.passed = true; out.error = error; resolve(out); });
  });
}

test('GET /api/releases entrega o catálogo ao vivo do GitHub, sem cache no navegador', async () => {
  const fetcher = async (url, options) => {
    assert.equal(url, PUBLIC_API);
    assert.equal(new Headers(options.headers).has('authorization'), false);
    return Response.json([githubRelease('0.76.283', '2026-10-15T22:18:29Z')]);
  };
  const out = await run(releaseCatalogMiddleware({ fetcher }));
  assert.equal(out.status, 200);
  assert.equal(out.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(out.headers['cache-control'], 'no-store');
  const payload = JSON.parse(out.body);
  assert.equal(payload.source, 'github');
  assert.equal(payload.catalog.windows[0].version, '0.76.283');
  assert.equal(payload.catalog.macos[0].version, '0.76.283');
});

test('com o GitHub fora do ar responde 200 com o snapshot embutido, nunca erro', async () => {
  const out = await run(releaseCatalogMiddleware({ fetcher: offline }));
  assert.equal(out.status, 200);
  const payload = JSON.parse(out.body);
  assert.equal(payload.source, 'snapshot');
  assert.deepEqual(payload.catalog, snapshot.catalog);
});

test('a query string não impede a rota e HEAD responde sem corpo', async () => {
  const middleware = releaseCatalogMiddleware({ fetcher: offline });
  const withQuery = await run(middleware, { url: '/api/releases?t=1' });
  assert.equal(withQuery.status, 200);
  const head = await run(middleware, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(head.body, undefined);
});

test('outra rota ou outro método passa para o próximo handler sem tocar na resposta', async () => {
  const middleware = releaseCatalogMiddleware({ fetcher: () => assert.fail('não deve consultar o GitHub') });
  for (const request of [{ url: '/' }, { url: '/api/releases/last-good' }, { url: '/api/other' }, { method: 'POST' }, { method: 'DELETE' }]) {
    const out = await run(middleware, request);
    assert.equal(out.passed, true, JSON.stringify(request));
    assert.equal(out.error, undefined);
    assert.equal(out.status, undefined);
  }
});

test('erro inesperado vai para o próximo handler em vez de pendurar o pedido', async () => {
  const failure = new Error('boom');
  const out = await run(releaseCatalogMiddleware({ get fetcher() { throw failure; } }));
  assert.equal(out.passed, true);
  assert.equal(out.error, failure);
  assert.equal(out.status, undefined);
});
