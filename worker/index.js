import { releaseCatalogResponse } from '../src/downloads/catalog.js';

const PRODUCTION_HOST = 'nexuside.app';
const COMMUNITY_HOST = 'comunidade.nexuside.app';
const BACKEND_PATHS = ['/v1', '/billing', '/join', '/health', '/ready'];
const ALIASES = new Set(['/comunidade', '/comunidade/', '/sorteio', '/sorteio/']);
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function isBackendPath(path) {
  return BACKEND_PATHS.some(prefix => path === prefix || path.startsWith(prefix + '/'));
}

async function fetchOrigin(request, originFetch) {
  try {
    return await originFetch(request);
  } catch {
    console.error('nexus-site: origin unavailable');
    return new Response('Serviço temporariamente indisponível.', { status: 502 });
  }
}

export async function handleRequest(request, env, originFetch = fetch) {
  const url = new URL(request.url);
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
  if (url.hostname === PRODUCTION_HOST && (ALIASES.has(url.pathname) || url.pathname.startsWith('/comunidade/'))) {
    const target = new URL('https://' + COMMUNITY_HOST);
    target.search = url.search;
    if (url.pathname.startsWith('/sorteio')) target.hash = 'premios';
    return Response.redirect(target.href, 307);
  }
  const assetUrl = new URL(url);
  if (url.hostname === COMMUNITY_HOST && (url.pathname === '/' || ALIASES.has(url.pathname))) assetUrl.pathname = '/comunidade/';
  if (url.hostname === COMMUNITY_HOST && ['/privacidade', '/privacidade.html', '/termos', '/termos.html'].includes(url.pathname)) assetUrl.pathname = '/comunidade' + url.pathname;
  let response = await env.ASSETS.fetch(new Request(assetUrl, request));
  if (response.status === 404) {
    assetUrl.pathname = '/404';
    const missing = await env.ASSETS.fetch(new Request(assetUrl, request));
    response = new Response(missing.body, { status: 404, headers: missing.headers });
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (url.pathname.startsWith('/sorteio')) headers.set('x-robots-tag', 'noindex');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  fetch(request, env) { return handleRequest(request, env); },
};
