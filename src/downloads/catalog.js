import { normalizeReleases } from './releases.js';
import snapshot from './snapshot.js';

const PUBLIC_API = 'https://api.github.com/repos/Hiper-nexus/nexus-ide-releases/releases?per_page=100';
const CACHE_SECONDS = 600;
const REQUEST_TIMEOUT_MS = 5000;

function jsonResponse(payload, maxAge) {
  return Response.json(payload, { headers: {
    'cache-control': `public, max-age=${maxAge}`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  } });
}

export async function releaseCatalogResponse(request, { fetcher = fetch, cache = globalThis.caches?.default } = {}) {
  const cacheKey = new Request(new URL('/api/releases', request.url));
  let response;
  if (cache) {
    try { response = await cache.match(cacheKey); }
    catch { console.error('nexus-site: public release cache read failed'); }
  }
  if (!response) {
    try {
      const upstream = await fetcher(PUBLIC_API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'NexusIDE-public-site' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!upstream.ok) throw new Error('public-api-unavailable');
      const catalog = normalizeReleases(await upstream.json());
      if (!catalog.windows.length && !catalog.macos.length) throw new Error('public-api-empty');
      response = jsonResponse({ source: 'github', checkedAt: new Date().toISOString(), catalog }, CACHE_SECONDS);
      if (cache) {
        try { await cache.put(cacheKey, response.clone()); }
        catch { console.error('nexus-site: public release cache write failed'); }
      }
    } catch {
      console.error('nexus-site: public releases unavailable; serving bundled snapshot');
      response = jsonResponse({ source: 'snapshot', ...snapshot }, 60);
    }
  }
  return request.method === 'HEAD' ? new Response(null, { headers: response.headers }) : response;
}
