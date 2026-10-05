export const PRODUCTION_HOST = 'nexuside.app';
export const COMMUNITY_HOST = 'comunidade.nexuside.app';

const MARKETING_ORIGIN = 'https://nexuside.app';
const COMMUNITY_ORIGIN = 'https://comunidade.nexuside.app';

// Só páginas que devem ser indexadas. Conta, admin, espelho e sorteio ficam de fora.
const MARKETING_URLS = [
  `${MARKETING_ORIGIN}/`,
  `${MARKETING_ORIGIN}/benchmarks/`,
  `${MARKETING_ORIGIN}/termos`,
  `${MARKETING_ORIGIN}/privacidade`,
];
const COMMUNITY_URLS = [
  `${COMMUNITY_ORIGIN}/`,
  `${COMMUNITY_ORIGIN}/termos`,
  `${COMMUNITY_ORIGIN}/privacidade`,
];

// No host da comunidade estes caminhos repetem a home ou a página legal. O destino é o URL público.
const COMMUNITY_ALIASES = new Map([
  ['/comunidade', `${COMMUNITY_ORIGIN}/`],
  ['/comunidade/', `${COMMUNITY_ORIGIN}/`],
  ['/comunidade/index.html', `${COMMUNITY_ORIGIN}/`],
  ['/sorteio', `${COMMUNITY_ORIGIN}/#premios`],
  ['/sorteio/', `${COMMUNITY_ORIGIN}/#premios`],
  ['/termos.html', `${COMMUNITY_ORIGIN}/termos`],
  ['/termos/', `${COMMUNITY_ORIGIN}/termos`],
  ['/privacidade.html', `${COMMUNITY_ORIGIN}/privacidade`],
  ['/privacidade/', `${COMMUNITY_ORIGIN}/privacidade`],
  ['/comunidade/termos', `${COMMUNITY_ORIGIN}/termos`],
  ['/comunidade/termos/', `${COMMUNITY_ORIGIN}/termos`],
  ['/comunidade/termos.html', `${COMMUNITY_ORIGIN}/termos`],
  ['/comunidade/privacidade', `${COMMUNITY_ORIGIN}/privacidade`],
  ['/comunidade/privacidade/', `${COMMUNITY_ORIGIN}/privacidade`],
  ['/comunidade/privacidade.html', `${COMMUNITY_ORIGIN}/privacidade`],
]);

export function isPublicHost(hostname) {
  return hostname === PRODUCTION_HOST || hostname === COMMUNITY_HOST;
}

function headerToken(value) {
  return value ? value.split(',')[0].trim().toLowerCase() : '';
}

// A Cloudflare entrega o esquema do visitante em X-Forwarded-Proto (sobrescreve o do cliente)
// e, no SSL flexível, em CF-Visitor. request.url pode já chegar como https.
export function visitorUsedHttp(request, url) {
  if (url.protocol === 'http:') return true;
  const forwarded = headerToken(request.headers.get('x-forwarded-proto'));
  if (forwarded === 'http') return true;
  if (forwarded === 'https') return false;
  const visitor = request.headers.get('cf-visitor');
  if (!visitor) return false;
  try {
    return JSON.parse(visitor).scheme === 'http';
  } catch {
    return false;
  }
}

export function httpsUrl(url) {
  const target = new URL(url.href);
  target.protocol = 'https:';
  return target.href;
}

export function communityAliasTarget(pathname, search) {
  const base = COMMUNITY_ALIASES.get(pathname);
  if (!base) return null;
  const target = new URL(base);
  target.search = search;
  return target.href;
}

function normalizeDocumentPath(pathname) {
  let path = pathname.replace(/\/index\.html$/i, '/').replace(/\.html$/i, '');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path || '/';
}

// O asset host emite 307 para barra final e para tirar .html. É o mesmo documento, para sempre.
export function canonicalAssetLocation(pageUrl, response) {
  if (response.status !== 302 && response.status !== 307) return null;
  const location = response.headers.get('location');
  if (!location) return null;
  let target;
  try {
    target = new URL(location, pageUrl);
  } catch {
    return null;
  }
  const current = new URL(pageUrl);
  if (target.hostname !== current.hostname || target.search !== current.search) return null;
  if (target.pathname === current.pathname) return null;
  if (normalizeDocumentPath(current.pathname) !== normalizeDocumentPath(target.pathname)) return null;
  target.protocol = 'https:';
  target.hash = '';
  return target.href;
}

function escapeXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function seoFile(hostname, pathname) {
  if (!isPublicHost(hostname)) return null;
  const origin = hostname === COMMUNITY_HOST ? COMMUNITY_ORIGIN : MARKETING_ORIGIN;
  if (pathname === '/robots.txt') {
    return {
      contentType: 'text/plain; charset=utf-8',
      body: `User-agent: *\nAllow: /\nDisallow: /v1/\nSitemap: ${origin}/sitemap.xml\n`,
    };
  }
  if (pathname === '/sitemap.xml') {
    const urls = hostname === COMMUNITY_HOST ? COMMUNITY_URLS : MARKETING_URLS;
    const body = urls.map(loc => `<url><loc>${escapeXml(loc)}</loc></url>`).join('');
    return {
      contentType: 'application/xml; charset=utf-8',
      body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`,
    };
  }
  return null;
}
