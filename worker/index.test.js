import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { handleRequest } from './index.js';

function connectSrcDirective(csp) {
  return csp.split(';').map(part => part.trim()).find(part => part.startsWith('connect-src'));
}

test('Cloudflare execution context does not replace the origin fetch function', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('origin'));
  const response = await worker.fetch(new Request('https://nexuside.app/v1/license'), {}, { waitUntil() {} });
  assert.equal(await response.text(), 'origin');
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('redirects the former community page away from the product domain', async () => {
  const res = await handleRequest(new Request('https://nexuside.app/comunidade?from=youtube'), {});
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), 'https://comunidade.nexuside.app/?from=youtube');
});

test('serves a distinct community document on its own hostname', async () => {
  const res = await handleRequest(new Request('https://comunidade.nexuside.app/'), {
    ASSETS: { fetch: async req => {
      assert.equal(new URL(req.url).pathname, '/comunidade/');
      return new Response('Nexus community');
    } },
  }, () => assert.fail('must not hit backend'));
  assert.equal(await res.text(), 'Nexus community');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000');
});

test('keeps the product homepage at the main domain root', async () => {
  const res = await handleRequest(new Request('https://nexuside.app/'), {
    ASSETS: { fetch: async req => {
      assert.equal(new URL(req.url).pathname, '/');
      return new Response('Nexus product');
    } },
  });
  assert.equal(await res.text(), 'Nexus product');
});

test('community domain cannot forward authenticated API calls to the Railway origin', async () => {
  const response = await handleRequest(new Request('https://comunidade.nexuside.app/v1/license'), {}, () => assert.fail('no backend proxy'));
  assert.equal(response.status, 404);
});

test('preserves webhook request body and authorization when passing through to origin', async () => {
  const request = new Request('https://nexuside.app/v1/billing/webhook', {
    method: 'POST', body: '{"id":"event-123"}', headers: {'stripe-signature':'signed-event'},
  });
  const response = await handleRequest(request, { ASSETS: { fetch: () => assert.fail('not an asset') } }, async req => {
    assert.equal(req, request);
    assert.equal(req.headers.get('stripe-signature'), 'signed-event');
    assert.equal(await req.text(), '{"id":"event-123"}');
    return new Response('ok', {status:201});
  });
  assert.equal(response.status, 201);
});

test('preserves billing and team invite pages on the existing backend', async () => {
  for (const path of ['/billing/success', '/billing/cancel', '/join/ABCD-EFGH', '/ready', '/health']) {
    let calls = 0;
    await handleRequest(new Request('https://nexuside.app'+path), {}, async () => { calls++; return new Response('origin'); });
    assert.equal(calls, 1, path);
  }
});

test('does not expose the backend through the workers.dev preview domain', async () => {
  const response = await handleRequest(new Request('https://nexus-site.example.workers.dev/v1/license'), {}, () => assert.fail('no backend proxy'));
  assert.equal(response.status, 404);
});

test('does not consume a failed origin request body twice', async () => {
  const response = await handleRequest(new Request('https://nexuside.app/v1/auth/refresh', {method:'POST',body:'request'}), {}, async req => {
    await req.text();
    throw new Error('offline');
  });
  assert.equal(response.status, 502);
  assert.equal(await response.text(), 'Serviço temporariamente indisponível.');
});

test('returns branded missing pages with a real 404 status', async () => {
  const response = await handleRequest(new Request('https://nexuside.app/missing'), {
    ASSETS: { fetch: async req => {
      const path = new URL(req.url).pathname;
      if (path === '/404.html') return new Response(null, {status:307,headers:{location:'/404'}});
      return new Response(path === '/404' ? 'Lost in space' : 'missing', {status:path === '/404' ? 200 : 404,headers:{'content-type':'text/html'}});
    } },
  });
  assert.equal(response.status,404);
  assert.equal(await response.text(),'Lost in space');
  assert.equal(response.headers.get('content-type'),'text/html');
  assert.equal(response.headers.has('location'),false);
});

test('CSP connect-src allows the site, the API and the Cloudflare analytics beacon, and nothing else', async () => {
  const res = await handleRequest(new Request('https://nexuside.app/'), {
    ASSETS: { fetch: async () => new Response('product') },
  });
  const csp = res.headers.get('content-security-policy');
  assert.equal(connectSrcDirective(csp), "connect-src 'self' https://api.nexuside.app https://cloudflareinsights.com");
  assert.equal(csp.includes("connect-src 'self';"), false);
});

test('serves conta and admin on the product domain with noindex', async () => {
  for (const path of ['/conta/', '/admin/', '/conta', '/admin']) {
    let served = null;
    const res = await handleRequest(new Request('https://nexuside.app' + path), {
      ASSETS: { fetch: async req => { served = new URL(req.url).pathname; return new Response('page'); } },
    });
    assert.equal(served, path, path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex', path);
    assert.equal(res.headers.get('content-security-policy').includes('api.nexuside.app'), true, path);
  }
});

test('never serves conta or admin on the community hostname', async () => {
  for (const path of ['/conta/', '/admin/', '/conta', '/admin']) {
    const res = await handleRequest(new Request('https://comunidade.nexuside.app' + path), {
      ASSETS: { fetch: () => assert.fail('must not serve account assets') },
    });
    assert.equal(res.status, 404, path);
  }
});

test('conta and admin documents stay out of the search index', () => {
  for (const file of ['../conta/index.html', '../admin/index.html']) {
    const html = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(html, /<meta name="robots" content="noindex">/, file);
  }
});

test('o endereço principal também serve a comunidade, para quem não consegue abrir o subdomínio', async () => {
  for (const path of ['/comunidade/']) {
    const res = await handleRequest(new Request('https://nexuside.app' + path), {
      ASSETS: { fetch: async req => { assert.equal(new URL(req.url).pathname, '/comunidade/'); return new Response('Nexus community'); } },
    }, () => assert.fail('must not hit backend'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'Nexus community');
    assert.match(res.headers.get('link'), /<https:\/\/comunidade\.nexuside\.app\/>; rel="canonical"/, 'o subdomínio continua sendo o endereço canônico');
  }
});

test('/comunidade sem barra, o sorteio e subcaminhos continuam indo para o subdomínio', async () => {
  const noSlash = await handleRequest(new Request('https://nexuside.app/comunidade?from=youtube'), {});
  assert.equal(noSlash.status, 307);
  assert.equal(noSlash.headers.get('location'), 'https://comunidade.nexuside.app/?from=youtube');
  const raffle = await handleRequest(new Request('https://nexuside.app/sorteio'), {});
  assert.equal(raffle.headers.get('location'), 'https://comunidade.nexuside.app/#premios');
  const sub = await handleRequest(new Request('https://nexuside.app/comunidade/qualquer-coisa'), {});
  assert.equal(sub.status, 307);
});
