import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { handleRequest } from '../../worker/index.js';

const slugs = ['ia-escritora-revisora-modelos-por-papel', 'criar-saas-com-ia', 'reduzir-consumo-tokens-programando-com-ia'];
const routes = ['/blog/', ...slugs.map(slug => `/blog/${slug}/`)];
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const structured = html => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap(match => {
  const data = JSON.parse(match[1]);
  return data['@graph'] ?? [data];
});

test('blog e artigos são HTML indexável com metadados individuais', () => {
  const titles = new Set(), descriptions = new Set();
  for (const route of routes) {
    const file = `${route.slice(1)}index.html`;
    assert.ok(existsSync(new URL(`../../${file}`, import.meta.url)), file);
    const html = read(file), canonical = `https://nexuside.app${route}`;
    assert.match(html, /<html lang="pt-BR">/);
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
    assert.ok(html.includes(`<link rel="canonical" href="${canonical}">`));
    assert.ok(html.includes(`<meta property="og:url" content="${canonical}">`));
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    assert.doesNotMatch(html, /noindex|hreflang|<!--[A-Z_]+-->/);
    titles.add(/<title>([^<]+)<\/title>/.exec(html)?.[1]);
    descriptions.add(/<meta name="description" content="([^"]+)"/.exec(html)?.[1]);
    for (const pattern of [/class="skip" href="#main"/, /<main id="main"/, /aria-controls="nav-menu"/, /href="\/#download"/, /href="\/privacidade"/, /href="\/termos"/]) assert.match(html, pattern);
    const schema = structured(html);
    assert.ok(schema.some(item => item['@type'] === (route === '/blog/' ? 'Blog' : 'BlogPosting')));
    assert.ok(schema.some(item => item['@type'] === 'BreadcrumbList'));
    assert.doesNotMatch(JSON.stringify(schema), /AggregateRating|"offers"|"price"/);
  }
  assert.equal(titles.size, routes.length);
  assert.equal(descriptions.size, routes.length);
  assert.ok(!titles.has(undefined) && !descriptions.has(undefined));
});

test('artigos têm autoria/data visíveis, sumário, fontes públicas e leitura relacionada', () => {
  for (const slug of slugs) {
    const html = read(`blog/${slug}/index.html`);
    const article = structured(html).find(item => item['@type'] === 'BlogPosting');
    assert.equal(article.author.name, 'NexusIDE');
    assert.match(html, /NexusIDE/);
    assert.ok(html.includes(`datetime="${article.dateModified}"`));
    for (const pattern of [/<article[\s>]/, /aria-label="Sumário"/, /<h2 id="fontes">Fontes/, /href="https:\/\/(?:platform\.openai\.com|developers\.openai\.com|docs\.anthropic\.com|docs\.claude\.com|platform\.claude\.com|docs\.github\.com|git-scm\.com|cheatsheetseries\.owasp\.org)/]) assert.match(html, pattern);
    assert.ok(slugs.filter(other => other !== slug).some(other => html.includes(`href="/blog/${other}/"`)));
    assert.doesNotMatch(html, /github\.com\/Hiper-nexus\/nexus-ide(?:[\/"#?]|$)|src\/main\/|docs\/analysis\/|localhost|TODO|TBD/);
  }
});

test('sitemap inclui todas as páginas do blog, preservando GET e HEAD', async () => {
  const env = { ASSETS: { fetch: () => assert.fail('sitemap não consulta assets') } };
  const request = await handleRequest(new Request('https://nexuside.app/sitemap.xml'), env);
  const urls = [...(await request.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
  for (const route of routes) assert.equal(urls.filter(url => url === `https://nexuside.app${route}`).length, 1);
  const head = await handleRequest(new Request('https://nexuside.app/sitemap.xml', { method: 'HEAD' }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('content-type'), request.headers.get('content-type'));
  const community = await handleRequest(new Request('https://comunidade.nexuside.app/sitemap.xml'), env);
  assert.doesNotMatch(await community.text(), /\/blog\//);
});

test('blog não aparece na comunidade e mantém redirects permanentes no produto', async () => {
  for (const route of ['/blog', ...routes]) {
    const community = await handleRequest(new Request(`https://comunidade.nexuside.app${route}`), { ASSETS: { fetch: () => assert.fail('não expor blog na comunidade') } });
    assert.equal(community.status, 404);
  }
  for (const route of routes) {
    const response = await handleRequest(new Request(`https://nexuside.app${route}`), { ASSETS: { fetch: () => new Response('artigo', { headers: { 'content-type': 'text/html' } }) } });
    assert.equal(response.status, 200);
    assert.notEqual(response.headers.get('x-robots-tag'), 'noindex');
    const redirect = await handleRequest(new Request(`https://nexuside.app${route.slice(0, -1)}?origem=blog`), { ASSETS: { fetch: () => new Response(null, { status: 307, headers: { location: `${route}?origem=blog` } }) } });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), `https://nexuside.app${route}?origem=blog`);
  }
});

test('navegação/rodapé da home e benchmarks descobrem blog e entradas Vite existem', () => {
  for (const file of ['index.html', 'benchmarks/index.html']) {
    const html = read(file);
    assert.match(html.slice(html.indexOf('<nav'), html.indexOf('</nav>')), /href="\/blog\/"/);
    assert.match(html.slice(html.lastIndexOf('<footer')), /href="\/blog\/"/);
  }
  const index = read('blog/index.html'), vite = read('vite.config.js');
  for (const route of routes.slice(1)) assert.ok(index.includes(`href="${route}"`));
  for (const route of routes) assert.ok(vite.includes(`${route.slice(1)}index.html`));
});
