import { RELEASE_REPOSITORY, normalizeReleases, validateCatalog } from './releases.js';
import snapshot from './snapshot.js';

const PUBLIC_API = 'https://api.github.com/repos/Hiper-nexus/nexus-ide-releases/releases?per_page=100';
const CACHE_SECONDS = 600;
// O "último catálogo bom" sobrevive dias: se o GitHub limitar ou cair, o site segue apontando para a release
// mais nova que ele já viu, em vez de voltar ao snapshot embutido no deploy.
const LAST_GOOD_SECONDS = 7 * 24 * 60 * 60;
const SNAPSHOT_SECONDS = 60;
const REDIRECT_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 5000;
// Chave de cache única, qualquer que seja o host que atendeu o pedido.
const CACHE_ORIGIN = 'https://nexuside.app';
const FRESH_KEY = `${CACHE_ORIGIN}/api/releases`;
const LAST_GOOD_KEY = `${CACHE_ORIGIN}/api/releases/last-good`;

function jsonResponse(payload, maxAge) {
  return Response.json(payload, { headers: {
    'cache-control': `public, max-age=${maxAge}`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  } });
}

function hasInstallers(catalog) {
  return Boolean(catalog?.windows?.length || catalog?.macos?.length);
}

async function readCached(cache, key, source) {
  if (!cache) return null;
  try {
    const response = await cache.match(new Request(key));
    if (!response) return null;
    const payload = await response.json();
    // O que volta do cache passa pelo mesmo crivo do GitHub: só URLs do repositório público de releases.
    const catalog = validateCatalog(payload?.catalog);
    return hasInstallers(catalog) ? { source, checkedAt: payload.checkedAt, catalog } : null;
  } catch {
    console.error('nexus-site: public release cache read failed');
    return null;
  }
}

async function writeCached(cache, key, payload, maxAge) {
  if (!cache) return;
  try { await cache.put(new Request(key), jsonResponse(payload, maxAge)); }
  catch { console.error('nexus-site: public release cache write failed'); }
}

async function fetchUpstream(fetcher) {
  const upstream = await fetcher(PUBLIC_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'NexusIDE-public-site' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!upstream.ok) throw new Error('public-api-unavailable');
  const catalog = normalizeReleases(await upstream.json());
  if (!hasInstallers(catalog)) throw new Error('public-api-empty');
  return catalog;
}

/**
 * Catálogo das releases públicas: cache fresco (10 min) → GitHub → último catálogo bom (7 dias) → snapshot
 * embutido. O Mac e o Windows saem em versões separadas, então cada sistema tem a sua release mais nova.
 */
export async function readReleaseCatalog({ fetcher = fetch, cache = globalThis.caches?.default } = {}) {
  const fresh = await readCached(cache, FRESH_KEY, 'github');
  if (fresh) return fresh;
  try {
    const catalog = await fetchUpstream(fetcher);
    const payload = { source: 'github', checkedAt: new Date().toISOString(), catalog };
    await writeCached(cache, FRESH_KEY, payload, CACHE_SECONDS);
    await writeCached(cache, LAST_GOOD_KEY, payload, LAST_GOOD_SECONDS);
    return payload;
  } catch {
    const stale = await readCached(cache, LAST_GOOD_KEY, 'stale');
    if (stale) {
      console.error('nexus-site: public releases unavailable; serving last good catalog');
      return stale;
    }
    console.error('nexus-site: public releases unavailable; serving bundled snapshot');
    return { source: 'snapshot', ...snapshot };
  }
}

export async function releaseCatalogResponse(request, deps = {}) {
  const payload = await readReleaseCatalog(deps);
  const maxAge = payload.source === 'github' ? CACHE_SECONDS : SNAPSHOT_SECONDS;
  const response = jsonResponse(payload, maxAge);
  return request.method === 'HEAD' ? new Response(null, { headers: response.headers }) : response;
}

/**
 * Para onde leva cada link permanente. macOS e Windows: o instalador mais novo do sistema (sem instalador, a página de
 * releases). Linux: `linux-deb`, `linux-rpm` e `linux-zip` levam ao arquivo da versão mais nova; `linux` e qualquer formato
 * ainda não publicado levam à seção de download do site, que diz em que pé o Linux está — nunca a um arquivo inexistente.
 */
function resolveDownload(catalog, target) {
  if (target.startsWith('linux')) {
    const latest = catalog.linux?.[0];
    const file = latest?.files.find(item => `linux-${item.format}` === target);
    return file ? { url: file.url, version: latest.version } : { url: `${CACHE_ORIGIN}/#download` };
  }
  const latest = catalog[target]?.[0];
  return latest ? { url: latest.url, version: latest.version } : { url: `${RELEASE_REPOSITORY}/releases` };
}

/**
 * Link permanente de download: leva sempre ao instalador mais novo do sistema pedido. Só sai URL que passou
 * por `normalizeReleases` (github.com/Hiper-nexus/nexus-ide-releases).
 */
export async function downloadRedirectResponse(target, deps = {}) {
  const payload = await readReleaseCatalog(deps);
  const { url, version } = resolveDownload(payload.catalog, target);
  const headers = {
    location: url,
    'cache-control': `public, max-age=${REDIRECT_SECONDS}`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  };
  if (version) headers['x-nexus-version'] = version;
  return new Response(null, { status: 302, headers });
}
