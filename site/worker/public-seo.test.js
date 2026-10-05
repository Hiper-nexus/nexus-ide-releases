import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest } from './index.js';

function locs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
}

function jsonLd(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)].map(match => JSON.parse(match[1]));
}

function typesOf(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) typesOf(item, found);
    return found;
  }
  if (typeof value['@type'] === 'string') found.push(value['@type']);
  for (const nested of Object.values(value)) typesOf(nested, found);
  return found;
}

test('http on both public hosts redirects to the same https url', async () => {
  for (const url of ['http://nexuside.app/', 'http://comunidade.nexuside.app/termos?x=1']) {
    const res = await handleRequest(new Request(url), { ASSETS: { fetch: () => assert.fail('no assets') } });
    assert.equal(res.status, 301, url);
    assert.equal(res.headers.get('location'), url.replace('http://', 'https://'), url);
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000', url);
  }
});

test('a visitor who arrived on http is redirected even when the worker url is already https', async () => {
  const headers = { 'x-forwarded-proto': 'http', 'cf-visitor': '{"scheme":"http"}' };
  const res = await handleRequest(new Request('https://comunidade.nexuside.app/', { headers }), {
    ASSETS: { fetch: () => assert.fail('no assets') },
  });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://comunidade.nexuside.app/');
});

test('https pages stay put, and an http post keeps its method', async () => {
  const page = await handleRequest(new Request('https://nexuside.app/'), {
    ASSETS: { fetch: async () => new Response('product') },
  });
  assert.equal(page.status, 200);
  const post = await handleRequest(new Request('http://nexuside.app/v1/billing/webhook', { method: 'POST', body: '{}' }), {}, () => assert.fail('no origin'));
  assert.equal(post.status, 308);
  assert.equal(post.headers.get('location'), 'https://nexuside.app/v1/billing/webhook');
});

test('each host serves its own robots and sitemap', async () => {
  const marketingRobots = await handleRequest(new Request('https://nexuside.app/robots.txt'), { ASSETS: { fetch: () => assert.fail('static') } });
  const marketingSitemap = await handleRequest(new Request('https://nexuside.app/sitemap.xml'), { ASSETS: { fetch: () => assert.fail('static') } });
  const communityRobots = await handleRequest(new Request('https://comunidade.nexuside.app/robots.txt'), { ASSETS: { fetch: () => assert.fail('static') } });
  const communitySitemap = await handleRequest(new Request('https://comunidade.nexuside.app/sitemap.xml'), { ASSETS: { fetch: () => assert.fail('static') } });
  assert.match(await marketingRobots.text(), /^User-agent: \*\nAllow: \/\nDisallow: \/v1\/\nSitemap: https:\/\/nexuside\.app\/sitemap\.xml\n$/);
  assert.match(await communityRobots.text(), /^User-agent: \*\nAllow: \/\nDisallow: \/v1\/\nSitemap: https:\/\/comunidade\.nexuside\.app\/sitemap\.xml\n$/);
  assert.deepEqual(locs(await marketingSitemap.text()), [
    'https://nexuside.app/',
    'https://nexuside.app/benchmarks/',
    'https://nexuside.app/termos',
    'https://nexuside.app/privacidade',
  ]);
  assert.deepEqual(locs(await communitySitemap.text()), [
    'https://comunidade.nexuside.app/',
    'https://comunidade.nexuside.app/termos',
    'https://comunidade.nexuside.app/privacidade',
  ]);
});

test('community aliases and asset trailing slashes are permanent', async () => {
  const raffle = await handleRequest(new Request('https://comunidade.nexuside.app/sorteio'), { ASSETS: { fetch: () => assert.fail('no copy') } });
  assert.equal(raffle.status, 301);
  assert.equal(raffle.headers.get('location'), 'https://comunidade.nexuside.app/#premios');
  const duplicate = await handleRequest(new Request('https://comunidade.nexuside.app/comunidade/'), { ASSETS: { fetch: () => assert.fail('no copy') } });
  assert.equal(duplicate.headers.get('location'), 'https://comunidade.nexuside.app/');
  const legal = await handleRequest(new Request('https://comunidade.nexuside.app/comunidade/termos'), { ASSETS: { fetch: () => assert.fail('no copy') } });
  assert.equal(legal.headers.get('location'), 'https://comunidade.nexuside.app/termos');
  const htmlAlias = await handleRequest(new Request('https://comunidade.nexuside.app/termos.html'), { ASSETS: { fetch: () => assert.fail('no copy') } });
  assert.equal(htmlAlias.status, 301);
  assert.equal(htmlAlias.headers.get('location'), 'https://comunidade.nexuside.app/termos');
  const account = await handleRequest(new Request('https://nexuside.app/conta'), {
    ASSETS: { fetch: async () => new Response(null, { status: 307, headers: { location: '/conta/' } }) },
  });
  assert.equal(account.status, 301);
  assert.equal(account.headers.get('location'), 'https://nexuside.app/conta/');
  assert.equal(account.headers.get('x-robots-tag'), 'noindex');
  const slash = await handleRequest(new Request('https://nexuside.app/benchmarks'), {
    ASSETS: { fetch: async () => new Response('later', { status: 307, headers: { location: '/benchmarks/' } }) },
  });
  assert.equal(slash.status, 301);
  assert.equal(slash.headers.get('location'), 'https://nexuside.app/benchmarks/');
  const extension = await handleRequest(new Request('https://nexuside.app/termos.html'), {
    ASSETS: { fetch: async () => new Response(null, { status: 307, headers: { location: '/termos' } }) },
  });
  assert.equal(extension.status, 301);
  assert.equal(extension.headers.get('location'), 'https://nexuside.app/termos');
  const unrelated = await handleRequest(new Request('https://nexuside.app/old'), {
    ASSETS: { fetch: async () => new Response(null, { status: 307, headers: { location: '/somewhere-else' } }) },
  });
  assert.equal(unrelated.status, 307);
  assert.equal(unrelated.headers.get('location'), '/somewhere-else');
});

test('public pages say what they are and stay indexable', () => {
  const pages = [
    ['../index.html', 'https://nexuside.app/', 'SoftwareApplication'],
    ['../benchmarks/index.html', 'https://nexuside.app/benchmarks/', 'WebPage'],
    ['../comunidade/index.html', 'https://comunidade.nexuside.app/', 'FAQPage'],
    ['../public/termos.html', 'https://nexuside.app/termos', 'WebPage'],
    ['../public/privacidade.html', 'https://nexuside.app/privacidade', 'WebPage'],
    ['../public/comunidade/termos.html', 'https://comunidade.nexuside.app/termos', 'WebPage'],
    ['../public/comunidade/privacidade.html', 'https://comunidade.nexuside.app/privacidade', 'WebPage'],
  ];
  for (const [file, canonical, type] of pages) {
    const html = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(html.includes('name="robots" content="noindex"'), false, file);
    assert.equal(html.includes('hreflang'), false, file);
    assert.match(html, new RegExp(`<link rel="canonical" href="${canonical}">`), file);
    assert.match(html, /<meta name="description" content="[^"]{40,}">/, file);
    assert.match(html, /<meta property="og:url" content="/, file);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/, file);
    assert.match(html, /<meta name="twitter:title" content="/, file);
    assert.match(html, /<meta name="twitter:image" content="https:/, file);
    const blocks = jsonLd(html);
    assert.equal(blocks.length, 1, file);
    const types = typesOf(blocks[0]);
    assert.equal(types.includes(type), true, file);
    assert.equal(types.includes('AggregateRating') || types.includes('Review') || types.includes('Rating'), false, file);
    assert.equal(JSON.stringify(blocks[0]).includes('"offers"'), false, file);
  }
  const home = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(home, /<title>NexusIDE — IDE para programar com agentes de IA<\/title>/);
  assert.match(home, /<meta name="description" content="IDE para programar com agentes de IA\./);
  assert.match(home, /<h1 id="hero-title">/);
  const community = readFileSync(new URL('../comunidade/index.html', import.meta.url), 'utf8');
  assert.match(community, /<title>Comunidade NexusIDE — dev café, grupo e sorteio<\/title>/);
  assert.match(community, /<h1 id="game-title"><span class="pixel">PRESS START<\/span><\/h1>/);
  for (const file of ['../conta/index.html', '../admin/index.html']) {
    assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), /<meta name="robots" content="noindex">/, file);
  }
});
