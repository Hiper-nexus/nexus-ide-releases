import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseCatalogResponse } from './catalog.js';
import snapshot from './snapshot.js';

const request = new Request('https://nexuside.app/api/releases');
test('public GitHub failures return the bundled safe snapshot', async () => {
  const response = await releaseCatalogResponse(request, { fetcher: async () => { throw new Error('offline'); } });
  const payload = await response.json();
  assert.equal(payload.source, 'snapshot');
  assert.deepEqual(payload.catalog, snapshot.catalog);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
});
test('fetches only the fixed public repository without credentials and caches valid results', async () => {
  let saved;
  const cache = { match: async () => undefined, put: async (_, response) => { saved = response; } };
  const response = await releaseCatalogResponse(request, { cache, fetcher: async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/Hiper-nexus/nexus-ide-releases/releases?per_page=100');
    assert.equal(new Headers(options.headers).has('authorization'), false);
    const row = snapshot.catalog.windows[0];
    return Response.json([{ tag_name: `v${row.version}`, draft: false, prerelease: false, published_at: row.publishedAt, html_url: row.releaseUrl, assets: [{ name: row.name, size: row.size, browser_download_url: row.url }] }]);
  } });
  assert.equal((await response.json()).source, 'github');
  assert.equal(saved.status, 200);
});
test('cache hits do not call GitHub and HEAD returns no body', async () => {
  const response = await releaseCatalogResponse(new Request(request, { method: 'HEAD' }), {
    cache: { match: async () => Response.json({ source: 'github', catalog: snapshot.catalog }) },
    fetcher: () => assert.fail('cache must be used'),
  });
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('content-type'), 'application/json');
});
test('empty or invalid upstream catalogs do not erase the bundled installers', async () => {
  const response = await releaseCatalogResponse(request, { fetcher: async () => Response.json([{ draft: true }]) });
  assert.equal((await response.json()).source, 'snapshot');
});
