import { downloadRedirectResponse, releaseCatalogResponse } from '../src/downloads/catalog.js';
import { repoRedirectResponse } from '../src/downloads/repo.js';
import {
  COMMUNITY_HOST, PRODUCTION_HOST, canonicalAssetLocation, communityAliasTarget, httpsUrl, isPublicHost, seoFile, visitorUsedHttp,
} from './public-seo.js';

const BACKEND_PATHS = ['/v1', '/billing', '/join', '/health', '/ready'];
const ACCOUNT_PATHS = ['/conta', '/admin'];
// Links permanentes de download: o HTML, os e-mails e a documentação apontam para cá e nunca ficam velhos.
const DOWNLOAD_PREFIX = '/download/';
const DOWNLOAD_SYSTEMS = {
  macos: 'macos', mac: 'macos', windows: 'windows', win: 'windows',
  linux: 'linux', 'linux-deb': 'linux-deb', 'linux-rpm': 'linux-rpm', 'linux-zip': 'linux-zip',
};
// Repositórios apt e dnf do Linux: redirecionam para os assets da release Linux mais nova (src/downloads/repo.js).
const REPO_PREFIXES = { '/apt/': 'apt', '/rpm/': 'rpm' };
const ALIASES = new Set(['/comunidade', '/sorteio', '/sorteio/']);
// A comunidade também abre no endereço principal: quem não consegue o subdomínio (filtro de rede, DNS) chega por aqui.
const COMMUNITY_MIRROR_PATH = '/comunidade/';
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://api.nexuside.app https://cloudflareinsights.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

// Apenas a página de produto pode carregar a tag, após consentimento no cliente.
// Origens exatas do guia Google Ads; sem unsafe-inline, unsafe-eval ou curingas.
function assetSecurityHeaders(url) {
  if (url.hostname !== PRODUCTION_HOST || url.pathname !== '/') return SECURITY_HEADERS;
  const script = 'https://www.googletagmanager.com https://www.googleadservices.com https://www.google.com';
  const images = 'https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://pagead2.googlesyndication.com https://www.google.com https://www.google.com.br';
  const csp = SECURITY_HEADERS['content-security-policy']
    .replace("script-src 'self' https://static.cloudflareinsights.com;", `script-src 'self' https://static.cloudflareinsights.com ${script};`)
    .replace("img-src 'self' data: blob:;", `img-src 'self' data: blob: ${images};`)
    .replace('https://cloudflareinsights.com;', `https://cloudflareinsights.com ${images} https://ad.doubleclick.net;`)
    .replace("object-src 'none';", "frame-src https://www.googletagmanager.com; object-src 'none';");
  return { ...SECURITY_HEADERS, 'content-security-policy': csp };
}

function isBackendPath(path) {
  return BACKEND_PATHS.some(prefix => path === prefix || path.startsWith(prefix + '/'));
}

function isAccountPath(path) {
  return ACCOUNT_PATHS.some(prefix => path === prefix || path.startsWith(prefix + '/'));
}

async function fetchOrigin(request, originFetch) {
  try {
    return await originFetch(request);
  } catch {
    console.error('nexus-site: origin unavailable');
    return new Response('Serviço temporariamente indisponível.', { status: 502 });
  }
}

function redirectTo(location, status) {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('location', location);
  return new Response(null, { status, headers });
}

export async function handleRequest(request, env, originFetch = fetch) {
  const url = new URL(request.url);
  if (isPublicHost(url.hostname) && visitorUsedHttp(request, url)) {
    const status = request.method === 'GET' || request.method === 'HEAD' ? 301 : 308;
    return redirectTo(httpsUrl(url), status);
  }
  if (isBackendPath(url.pathname)) {
    return url.hostname === PRODUCTION_HOST
      ? fetchOrigin(request, originFetch)
      : new Response('Not found', { status: 404 });
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response('Método não permitido.', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  if (url.pathname === '/api/releases') {
    return url.hostname === COMMUNITY_HOST ? new Response('Not found', { status: 404 }) : releaseCatalogResponse(request);
  }
  const repoPrefix = Object.keys(REPO_PREFIXES).find(prefix => url.pathname.startsWith(prefix));
  if (repoPrefix) {
    if (url.hostname === COMMUNITY_HOST) return new Response('Not found', { status: 404 });
    return repoRedirectResponse(REPO_PREFIXES[repoPrefix], url.pathname.slice(repoPrefix.length));
  }
  if (url.pathname.startsWith(DOWNLOAD_PREFIX)) {
    const key = url.pathname.slice(DOWNLOAD_PREFIX.length);
    const system = Object.hasOwn(DOWNLOAD_SYSTEMS, key) ? DOWNLOAD_SYSTEMS[key] : undefined;
    return system && url.hostname !== COMMUNITY_HOST ? downloadRedirectResponse(system) : new Response('Not found', { status: 404 });
  }
  if (url.hostname === PRODUCTION_HOST && (ALIASES.has(url.pathname) || (url.pathname.startsWith('/comunidade/') && url.pathname !== COMMUNITY_MIRROR_PATH))) {
    const target = new URL('https://' + COMMUNITY_HOST);
    target.search = url.search;
    if (url.pathname.startsWith('/sorteio')) target.hash = 'premios';
    return redirectTo(target.href, 301);
  }
  if (url.hostname === COMMUNITY_HOST) {
    const alias = communityAliasTarget(url.pathname, url.search);
    if (alias) return redirectTo(alias, 301);
  }
  if (url.hostname === COMMUNITY_HOST && isAccountPath(url.pathname)) {
    return new Response('Not found', { status: 404 });
  }
  // O blog pertence ao produto; não publicar outra cópia no host da comunidade.
  if (url.hostname === COMMUNITY_HOST && (url.pathname === '/blog' || url.pathname.startsWith('/blog/'))) {
    return new Response('Not found', { status: 404 });
  }
  const seo = seoFile(url.hostname, url.pathname);
  if (seo) {
    const headers = new Headers(SECURITY_HEADERS);
    headers.set('content-type', seo.contentType);
    headers.set('cache-control', 'public, max-age=3600');
    return new Response(request.method === 'HEAD' ? null : seo.body, { status: 200, headers });
  }
  const assetUrl = new URL(url);
  if (url.hostname === COMMUNITY_HOST && url.pathname === '/') assetUrl.pathname = '/comunidade/';
  if (url.hostname === COMMUNITY_HOST && ['/privacidade', '/privacidade.html', '/termos', '/termos.html'].includes(url.pathname)) assetUrl.pathname = '/comunidade' + url.pathname;
  let response = await env.ASSETS.fetch(new Request(assetUrl, request));
  if (response.status === 404) {
    assetUrl.pathname = '/404';
    const missing = await env.ASSETS.fetch(new Request(assetUrl, request));
    response = new Response(missing.body, { status: 404, headers: missing.headers });
  }
  const canonical = canonicalAssetLocation(url, response);
  if (canonical) response = new Response(null, { status: 301, headers: { location: canonical } });
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(assetSecurityHeaders(url))) headers.set(name, value);
  if (url.pathname.startsWith('/sorteio')) headers.set('x-robots-tag', 'noindex');
  // O espelho no endereço principal aponta o subdomínio como o canônico, para os buscadores não duplicarem a página.
  if (url.hostname === PRODUCTION_HOST && url.pathname === COMMUNITY_MIRROR_PATH) headers.set('link', `<https://${COMMUNITY_HOST}/>; rel="canonical"`);
  if (isAccountPath(url.pathname)) headers.set('x-robots-tag', 'noindex');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  fetch(request, env) { return handleRequest(request, env); },
};
