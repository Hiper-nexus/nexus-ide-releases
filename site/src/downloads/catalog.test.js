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

// ---- Links permanentes: /download/macos e /download/windows sempre apontam para a última release de cada sistema ----
import { downloadRedirectResponse, readReleaseCatalog } from './catalog.js';

const REPO = 'https://github.com/Hiper-nexus/nexus-ide-releases/releases';
const dmg = version => `NexusIDE-${version}-arm64.dmg`;
const setup = version => `NexusIDE-${version}-win32-x64-Setup.exe`;
function githubRelease(version, files, publishedAt = '2026-10-01T12:00:00Z') {
  return { tag_name: `v${version}`, draft: false, prerelease: false, published_at: publishedAt, html_url: `${REPO}/tag/v${version}`,
    assets: files.map(name => ({ name, size: 1000, browser_download_url: `${REPO}/download/v${version}/${name}` })) };
}
// O Mac e o Windows saem em versões separadas: a 160 só tem Mac, a 158 só tem Windows.
const SPLIT_RELEASES = [
  githubRelease('0.76.160', [dmg('0.76.160')]),
  githubRelease('0.76.159', [dmg('0.76.159'), setup('0.76.159')]),
  githubRelease('0.76.158', [setup('0.76.158')]),
];
function memoryCache() {
  const store = new Map();
  return {
    store,
    match: async key => store.get(new URL(key.url ?? key).pathname)?.clone(),
    put: async (key, response) => { store.set(new URL(key.url ?? key).pathname, response.clone()); },
  };
}
const upstream = releases => async () => Response.json(releases);
const down = async () => { throw new Error('offline'); };

test('cada sistema resolve para a sua própria release mais nova', async () => {
  const mac = await downloadRedirectResponse('macos', { fetcher: upstream(SPLIT_RELEASES) });
  assert.equal(mac.status, 302);
  assert.equal(mac.headers.get('location'), `${REPO}/download/v0.76.160/${dmg('0.76.160')}`);
  assert.equal(mac.headers.get('x-nexus-version'), '0.76.160');
  const windows = await downloadRedirectResponse('windows', { fetcher: upstream(SPLIT_RELEASES) });
  assert.equal(windows.headers.get('location'), `${REPO}/download/v0.76.159/${setup('0.76.159')}`);
  assert.equal(windows.headers.get('x-nexus-version'), '0.76.159');
  assert.equal(windows.headers.get('cache-control'), 'public, max-age=300');
});

test('uma release nova que entra no GitHub vira o link, sem mexer no site', async () => {
  const cache = memoryCache();
  let releases = SPLIT_RELEASES.slice(1);
  const fetcher = async () => Response.json(releases);
  assert.equal((await downloadRedirectResponse('macos', { fetcher, cache })).headers.get('x-nexus-version'), '0.76.159');
  cache.store.delete('/api/releases'); // o cache fresco venceu
  releases = SPLIT_RELEASES;
  assert.equal((await downloadRedirectResponse('macos', { fetcher, cache })).headers.get('x-nexus-version'), '0.76.160');
});

test('GitHub fora do ar serve o último catálogo bom, não o snapshot embutido', async () => {
  const cache = memoryCache();
  await readReleaseCatalog({ fetcher: upstream(SPLIT_RELEASES), cache });
  cache.store.delete('/api/releases'); // o fresco expirou; o "último bom" dura dias
  const payload = await readReleaseCatalog({ fetcher: down, cache });
  assert.equal(payload.source, 'stale');
  assert.equal(payload.catalog.macos[0].version, '0.76.160');
  assert.equal(payload.catalog.windows[0].version, '0.76.159');
  const redirect = await downloadRedirectResponse('macos', { fetcher: down, cache });
  assert.equal(redirect.headers.get('x-nexus-version'), '0.76.160');
});

test('sem cache e sem GitHub o link ainda leva a um instalador verificado do snapshot', async () => {
  const response = await downloadRedirectResponse('windows', { fetcher: down });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), snapshot.catalog.windows[0].url);
});

test('sem instalador do sistema o link cai na página de releases, nunca em URL de fora', async () => {
  const cache = memoryCache();
  await cache.put(new Request('https://nexuside.app/api/releases'), Response.json({ source: 'github', checkedAt: new Date().toISOString(),
    catalog: { macos: snapshot.catalog.macos, windows: [] } }));
  const response = await downloadRedirectResponse('windows', { fetcher: () => assert.fail('o cache fresco basta'), cache });
  assert.equal(response.headers.get('location'), REPO);
});

test('entrada adulterada no cache é ignorada e o GitHub é consultado de novo', async () => {
  const cache = memoryCache();
  await cache.put(new Request('https://nexuside.app/api/releases'), Response.json({ source: 'github', catalog: {
    macos: [{ version: '9.9.9', architecture: 'arm64', name: 'NexusIDE-9.9.9-arm64.dmg', size: 5, url: 'https://evil.example/NexusIDE-9.9.9-arm64.dmg', releaseUrl: 'https://evil.example/tag/v9.9.9', publishedAt: '2026-10-01T12:00:00Z' }],
    windows: [] } }));
  const response = await downloadRedirectResponse('macos', { fetcher: upstream(SPLIT_RELEASES), cache });
  assert.equal(response.headers.get('location'), `${REPO}/download/v0.76.160/${dmg('0.76.160')}`);
});

test('HEAD no link permanente redireciona sem corpo', async () => {
  const response = await downloadRedirectResponse('macos', { fetcher: upstream(SPLIT_RELEASES), method: 'HEAD' });
  assert.equal(response.status, 302);
  assert.equal(await response.text(), '');
});

// ---- Linux: arquivo da versão mais nova quando os três pacotes existem; senão, a seção de download do site ----
const linuxFiles = version => [`nexus-ide_${version}_amd64.deb`, `nexus-ide-${version}-1.x86_64.rpm`, `NexusIDE-linux-x64-${version}.zip`];
const WITH_LINUX = [githubRelease('0.76.166', [dmg('0.76.166'), ...linuxFiles('0.76.166')]), ...SPLIT_RELEASES];

test('linux-deb, linux-rpm e linux-zip levam ao arquivo da versão mais nova', async () => {
  for (const [target, file] of [['linux-deb', 'nexus-ide_0.76.166_amd64.deb'], ['linux-rpm', 'nexus-ide-0.76.166-1.x86_64.rpm'], ['linux-zip', 'NexusIDE-linux-x64-0.76.166.zip']]) {
    const response = await downloadRedirectResponse(target, { fetcher: upstream(WITH_LINUX) });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `${REPO}/download/v0.76.166/${file}`);
    assert.equal(response.headers.get('x-nexus-version'), '0.76.166');
  }
});

test('/download/linux não escolhe pacote por quem visita: leva à seção de download do site', async () => {
  const response = await downloadRedirectResponse('linux', { fetcher: upstream(WITH_LINUX) });
  assert.equal(response.headers.get('location'), 'https://nexuside.app/#download');
  assert.equal(response.headers.get('x-nexus-version'), null);
});

test('sem pacote de Linux publicado nenhum link de Linux aponta para arquivo inexistente', async () => {
  for (const target of ['linux', 'linux-deb', 'linux-rpm', 'linux-zip']) {
    const response = await downloadRedirectResponse(target, { fetcher: upstream(SPLIT_RELEASES) });
    assert.equal(response.headers.get('location'), 'https://nexuside.app/#download', target);
  }
});

test('Linux incompleto (só DEB e RPM) não é oferecido', async () => {
  const half = [githubRelease('0.76.166', [dmg('0.76.166'), ...linuxFiles('0.76.166').slice(0, 2)]), ...SPLIT_RELEASES];
  assert.equal((await downloadRedirectResponse('linux-deb', { fetcher: upstream(half) })).headers.get('location'), 'https://nexuside.app/#download');
  const payload = await readReleaseCatalog({ fetcher: upstream(half) });
  assert.deepEqual(payload.catalog.linux, []);
});

test('o catálogo público traz o Linux ao lado do Mac e do Windows', async () => {
  const payload = await readReleaseCatalog({ fetcher: upstream(WITH_LINUX) });
  assert.equal(payload.catalog.linux[0].version, '0.76.166');
  assert.equal(payload.catalog.linux[0].files.length, 3);
  assert.equal(payload.catalog.macos[0].version, '0.76.166');
});
