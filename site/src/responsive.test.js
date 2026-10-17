import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Contratos de responsividade de 300 a 1440px. Cada regra corrige um corte ou vazamento medido em browser real
// (getBoundingClientRect de caixas e de texto em 300/360/390/500/760/1000/1440). O CSS é lido por seletor e media
// query, não por texto corrido: reformatar ou reordenar o arquivo não quebra o teste; perder a regra, sim.
const read = name => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

/** Regras como { media, selectors, body }, com o @media (ou @container) resolvido. Declarações sem espaço depois de : ; , */
function parse(source, media = '', out = []) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]*;/g, '').replace(/\s+/g, ' ').trim();
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('{', at);
    if (open < 0) break;
    let depth = 1, close = open + 1;
    for (; close < text.length && depth; close++) depth += text[close] === '{' ? 1 : text[close] === '}' ? -1 : 0;
    const head = text.slice(at, open).trim(), body = text.slice(open + 1, close - 1);
    if (head.startsWith('@media') || head.startsWith('@container')) parse(body, head.replace(/\s+/g, ''), out);
    else if (!head.startsWith('@')) out.push({ media, selectors: head.split(/\s*,\s*/), body: body.replace(/ ?([:;,]) ?/g, '$1') });
    at = close;
  }
  return out;
}

/** Declarações de todas as regras cujo seletor é exatamente `selector`, naquela media query ('' = fora de @media). */
const declarations = (file, selector, media = '') => parse(read(file))
  .filter(rule => rule.media === media && rule.selectors.includes(selector)).map(rule => rule.body).join(';');

function expectRule(file, selector, media, ...patterns) {
  const found = declarations(file, selector, media);
  for (const pattern of patterns) assert.match(found, pattern, `${file} ${media || '(base)'} ${selector} => "${found}"`);
}

const W1150 = '@media(max-width:1150px)', W760 = '@media(max-width:760px)', W480 = '@media(max-width:480px)', W420 = '@media(max-width:420px)', W360 = '@media(max-width:360px)';

test('o leitor de CSS do teste separa regra, seletor e media query', () => {
  const base = declarations('account.css', '.account-heading h1', ''), narrow = declarations('account.css', '.account-heading h1', W760);
  assert.match(base, /font-size:60px/);
  assert.doesNotMatch(base, /clamp/, 'a regra de 760px não pode vazar para a base');
  assert.match(narrow, /font-size:clamp\(/);
  assert.doesNotMatch(narrow, /60px/, 'a regra base não pode vazar para a media query');
  assert.match(declarations('datacafe/datacafe.css', '.dc-prize', W760), /left:12px/, 'seletor dentro de uma lista com vírgula');
});

test('admin e conta: os títulos encolhem com clamp e quebram em vez de cortar na direita', () => {
  expectRule('account.css', '.admin-hero h1', W760, /font-size:clamp\(24px,6\.5vw,34px\)/, /line-height:1\.08/, /overflow-wrap:anywhere/);
  expectRule('account.css', '.account-heading h1', W760, /font-size:clamp\(26px,7vw,36px\)/, /line-height:1\.08/, /overflow-wrap:anywhere/);
  expectRule('account.css', '.admin-hero-title', '', /min-width:0/);
  expectRule('account.css', '.admin-hero-title p', '', /overflow-wrap:anywhere/);
});

test('admin: os seis atalhos quebram em linhas e nunca rolam na horizontal', () => {
  for (const media of ['', W760]) assert.doesNotMatch(declarations('account.css', '.admin-subnav', media), /nowrap|overflow/);
  expectRule('account.css', '.admin-subnav', '', /flex-wrap:wrap/);
  expectRule('account.css', '.admin-subnav a', W760, /flex:1 1 auto/, /justify-content:center/, /min-height:38px/, /padding:6px 10px/, /font-size:13px/);
});

test('admin: o selo ao vivo quebra linha e, no celular, ocupa a largura toda junto do botão', () => {
  expectRule('account.css', '.live-badge', '', /max-width:100%/, /white-space:normal/, /overflow-wrap:anywhere/, /border-radius:12px/, /line-height:1\.35/);
  expectRule('account.css', '.live-badge', W480, /width:100%/);
  expectRule('account.css', '.admin-hero-actions .button', W480, /width:100%/);
});

test('admin e conta: 16px de margem lateral, KPIs que se reorganizam e selos que quebram em até 480px', () => {
  expectRule('account.css', '.account-main', W480, /padding:var\(--s4\) var\(--s2\) var\(--s5\)/);
  for (const selector of ['.kpi-grid', '.admin-overview']) expectRule('account.css', selector, W480, /grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,128px\),1fr\)\)/);
  expectRule('account.css', '.status-badge', W480, /white-space:normal/, /overflow-wrap:anywhere/, /max-width:100%/);
  expectRule('account.css', '.client-line time', W420, /white-space:normal/);
});

test('conta: os painéis não estouram o grid por causa de um e-mail longo', () => {
  expectRule('account.css', '.account-layout', '', /minmax\(0,1fr\) minmax\(0,1fr\)/);
  expectRule('account.css', '.account-layout', W760, /grid-template-columns:minmax\(0,1fr\)/);
  expectRule('account.css', '.account-hint', '', /overflow-wrap:anywhere/);
  expectRule('account.css', '.account-facts dd', '', /overflow-wrap:anywhere/);
});

test('Data Café: as três faixas do HUD ficam dentro do palco e quebram linha em vez de cortar', () => {
  const inside = /left:12px;right:12px;width:auto;max-width:calc\(100% - 24px\);box-sizing:border-box/;
  for (const base of ['.dc-prize', '.dc-ticket-now', '.dc-mission']) {
    for (const selector of [base, `.dc-hud[data-variant=embed] ${base}`]) expectRule('datacafe/datacafe.css', selector, W760, inside, /white-space:normal/);
  }
  expectRule('datacafe/datacafe.css', '.dc-prize', W760, /flex-wrap:wrap/, /gap:6px 8px/, /padding:6px 12px/);
  expectRule('datacafe/datacafe.css', '.dc-prize-name', W760, /font-size:clamp\(18px,5vw,22px\)/, /overflow-wrap:anywhere/);
  // duas linhas no máximo (a frase nunca é cortada na horizontal); a missão começa abaixo das duas linhas do objetivo
  expectRule('datacafe/datacafe.css', '.dc-ticket-now', W760, /display:-webkit-box/, /-webkit-line-clamp:2/, /-webkit-box-orient:vertical/, /line-height:1\.35/);
  expectRule('datacafe/datacafe.css', '.dc-mission', W760, /flex-wrap:wrap/, /gap:4px 8px/, /height:auto/, /top:calc\(var\(--dc-top,80px\) \+ 220px\)/);
  expectRule('datacafe/datacafe.css', '.dc-mission-text', W760, /white-space:normal/, /overflow-wrap:anywhere/, /min-width:0/, /flex:1 1 140px/);
  // o limite é do bloco de status, relativo ao palco; nos chips, 100% (com "- 24px" a linha de chips quebrava em duas à toa)
  expectRule('datacafe/datacafe.css', '.dc-status', W760, /max-width:calc\(100% - 32px\)/);
  const chips = declarations('datacafe/datacafe.css', '.dc-chips', W760);
  assert.match(chips, /max-width:100%/);
  assert.doesNotMatch(chips, /100vw/, 'o palco embutido na home é mais estreito que a janela: 100vw o deixaria vazar');
});

test('Data Café: em palcos de até 420px o medidor e o nível encostam menos nas bordas e não se tocam', () => {
  expectRule('datacafe/datacafe.css', '.dc-status', W420, /left:12px/);
  expectRule('datacafe/datacafe.css', '.dc-level', W420, /right:12px/, /padding:4px 8px/, /gap:6px/);
  expectRule('datacafe/datacafe.css', '.dc-meter', W420, /padding:4px 8px/, /gap:6px/);
  expectRule('datacafe/datacafe.css', '.dc-track', W420, /width:40px/);
});

test('comunidade: PRESS START, o bilhete do prêmio e os títulos do sorteio cabem em 300px', () => {
  expectRule('community.css', '.game-intro h1>.pixel', W760, /font-size:clamp\(42px,14vw,64px\)/);
  expectRule('community.css', '.intro-prize', W760, /max-width:calc\(100% - 16px\)/, /box-sizing:border-box/, /padding:8px 14px/);
  expectRule('community.css', '.intro-prize-name', W760, /font-size:clamp\(20px,6\.5vw,26px\)/);
  expectRule('community.css', '.community-content h2.prize-title', W760, /font-size:clamp\(2rem,8vw,3\.5rem\)/, /overflow-wrap:anywhere/);
  expectRule('community.css', '.community-content', W480, /padding:48px 16px/);
  expectRule('community.css', '.drop', W480, /--pad:16px/);
  expectRule('community.css', '.drop h3', W480, /font-size:clamp\(1\.5rem,7vw,1\.75rem\)/, /overflow-wrap:anywhere/);
  expectRule('community.css', '.drop-next h3', W480, /font-size:clamp\(2rem,9vw,2\.75rem\)/, /overflow-wrap:anywhere/);
  expectRule('community.css', '.drop-draw .pixel', W480, /font-size:clamp\(16px,5vw,22px\)/, /white-space:pre-wrap/, /overflow-wrap:anywhere/);
  for (const selector of ['.sorteio-rules', '.group-invite']) expectRule('community.css', selector, W480, /padding:16px/);
});

test('navegação: o hambúrguer assume até 1150px, onde os seis links e o CTA não cabem em linha, e cabe em 300px', () => {
  expectRule('tokens.css', '.nav:has(.mobile-nav-toggle)', W1150, /display:grid/);
  expectRule('tokens.css', '.mobile-nav-toggle', W1150, /display:inline-flex/);
  expectRule('tokens.css', '.nav:has(.mobile-nav-toggle) .nav-links', W1150, /display:none/);
  assert.equal(declarations('tokens.css', '.mobile-nav-toggle', W760), '', 'o botão não pode depender só do breakpoint de celular');
  // o hambúrguer tem 44px de alvo de toque: sem flex:none ele encolhia para 23px em 300px; quem cede espaço é a marca
  expectRule('tokens.css', '.mobile-nav-toggle', '', /flex:none/);
  expectRule('tokens.css', '.brand', W360, /gap:8px/, /font-size:20px/);
  expectRule('tokens.css', '.brand-ide', W360, /display:none/);
  expectRule('tokens.css', '.account-brand-label', W360, /display:none/);
  expectRule('tokens.css', '.nav-actions .button', W360, /padding:8px/);
  expectRule('tokens.css', '.footer', W480, /padding:24px 16px/);
});

test('Voz e Shot: grids de uma coluna usam minmax(0,1fr), senão o min-content empurra o palco para fora', () => {
  expectRule('voice.css', '.vox-body', W760, /grid-template-columns:minmax\(0,1fr\)/);
  expectRule('voice.css', '.vox-steps', W480, /grid-template-columns:repeat\(2,auto\)/);
  expectRule('product.css', '.shot-flow', '', /grid-template-columns:minmax\(0,1fr\)/);
  expectRule('product.css', '.shot-out', '', /grid-template-columns:168px minmax\(0,1fr\)/);
  expectRule('product.css', '.shot-out', W760, /grid-template-columns:104px minmax\(0,1fr\)/);
  const title = declarations('product.css', '.shot-bar strong');
  assert.match(title, /overflow-wrap:anywhere/);
  assert.doesNotMatch(title, /ellipsis|nowrap/, 'o título da janela quebra linha em vez de truncar');
});

test('home e benchmarks: 16px de margem lateral e títulos que quebram em janelas de até 480px', () => {
  for (const selector of ['.hero-grid', '.product-section', '.manifesto', '.community-invite']) expectRule('product.css', selector, W480, /padding:[^;]*16px/);
  expectRule('product.css', '.hero-scroll', W480, /left:16px;right:16px/);
  expectRule('product.css', '.providers-band', W480, /margin:0 16px/);
  expectRule('product.css', '.manifesto-text', W480, /font-size:clamp\(28px,9vw,36px\)/, /overflow-wrap:anywhere/);
  expectRule('product.css', '.invite-live .invite-press', W480, /font-size:clamp\(38px,14vw,56px\)/);
  expectRule('product.css', '.section-intro h2', W480, /overflow-wrap:anywhere/);
  expectRule('content.css', '.doc-main', W480, /padding:var\(--s4\) var\(--s2\) var\(--s5\)/);
  expectRule('content.css', '.doc-intro h1', W480, /overflow-wrap:anywhere/);
});

const W1151 = '@media(min-width:1151px)';
const inset = width => `@containeradm-inset(max-width:${width}px)`;

test('admin: shell com menu de 248px (60px recolhido no desktop) que vira gaveta até 1150px, sem tirar seções do DOM', () => {
  expectRule('account.css', '.adm-shell', '', /grid-template-columns:248px minmax\(0,1fr\)/, /padding:4px/, /border-radius:16px/);
  expectRule('account.css', '.adm-shell[data-sidebar-collapsed=true]', W1151, /grid-template-columns:60px minmax\(0,1fr\)/);
  assert.equal(declarations('account.css', '.adm-shell[data-sidebar-collapsed=true]', ''), '', 'recolher só vale no desktop: na gaveta os rótulos voltam');
  expectRule('account.css', '.adm-sidebar', '', /position:sticky/, /min-width:0/, /overflow:auto/);
  expectRule('account.css', '.adm-shell', W1150, /grid-template-columns:minmax\(0,1fr\)/);
  // fechada, a gaveta fica fora da tela e fora da ordem de foco (visibility), não só transladada
  expectRule('account.css', '.adm-sidebar', W1150, /position:fixed/, /width:min\(288px,86vw\)/, /transform:translateX\(-100%\)/, /visibility:hidden/);
  expectRule('account.css', '.adm-shell[data-sidebar-open=true] .adm-sidebar', W1150, /transform:none/, /visibility:visible/);
  // a inset é a moldura arredondada e o contêiner das container queries do grid
  expectRule('account.css', '.adm-inset', '', /min-width:0/, /container:adm-inset\/inline-size/, /border-radius:12px/, /border:1px solid var\(--line\)/);
  expectRule('account.css', '.adm-section[data-view-hidden=true]', '', /display:none/);
  const html = read('../admin/index.html');
  const views = [...html.matchAll(/data-adm-view="([a-z]+)"/g)].map(match => match[1]).filter(view => view !== 'all');
  const sections = new Set([...html.matchAll(/data-adm-section="([a-z]+)"/g)].map(match => match[1]));
  assert.ok(views.length >= 7);
  for (const view of views) assert.ok(sections.has(view), `o atalho ${view} precisa de uma seção data-adm-section="${view}"`);
});

test('admin: cartão card-in-card e grid bento de 12 colunas que não estoura com conteúdo largo', () => {
  expectRule('account.css', '.adm-card', '', /padding:4px/, /border-radius:12px/, /min-width:0/, /gap:4px/);
  // raio interno = externo − espaço (12 − 4): a moldura e o miolo ficam concêntricos
  expectRule('account.css', '.adm-card-body', '', /border-radius:8px/, /min-width:0/, /background:var\(--surface\)/);
  expectRule('account.css', '.adm-card-head', '', /padding:8px 12px/, /justify-content:space-between/);
  expectRule('account.css', '.adm-card-title', '', /font-size:13px/, /font-weight:600/, /color:var\(--muted\)/);
  expectRule('account.css', '.adm-bento', '', /grid-template-columns:repeat\(12,minmax\(0,1fr\)\)/);
  expectRule('account.css', '.adm-bento>*', '', /grid-column:span 12/, /min-width:0/);
  for (const span of [3, 4, 5, 8]) expectRule('account.css', `.adm-bento>.span-${span}`, '', new RegExp(`grid-column:span ${span}`));
  expectRule('account.css', '.adm-content', '', /grid-template-columns:minmax\(0,1fr\)/);
  expectRule('account.css', '.kpi-value', '', /font:700 28px\/32px/, /font-variant-numeric:tabular-nums/);
  expectRule('account.css', '.kpi-meter-fill', '', /transform:scaleX\(var\(--ratio,0\)\)/);
  // o esqueleto de carregamento só aparece em data-state=loading (a classe .kpi-grid do esqueleto não pode vencer)
  expectRule('account.css', '.adm-card>.adm-skeleton-grid', '', /display:none/);
  expectRule('account.css', '.adm-card[data-state=loading]>.adm-skeleton-grid', '', /display:grid/);
});

test('admin financeiro: KPIs de 4 → 2 → 1 coluna e gráficos de 5/4/3 → 12/6/6 → 12 pela largura da inset', () => {
  expectRule('account.css', '.adm-kpi-grid-4', '', /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  expectRule('account.css', '.adm-kpi-grid-4', inset(980), /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  expectRule('account.css', '.adm-kpi-grid-4', inset(520), /grid-template-columns:minmax\(0,1fr\)/);
  expectRule('account.css', '.adm-bento>.span-5', inset(1100), /grid-column:span 12/);
  expectRule('account.css', '.adm-bento-charts>.span-4', inset(1100), /grid-column:span 6/);
  expectRule('account.css', '.adm-bento-charts>.span-3', inset(640), /grid-column:span 12/);
  // tabela + demonstrativo só dividem a linha quando cabem as seis colunas sem rolar
  expectRule('account.css', '.adm-bento:not(.adm-bento-charts)>.span-8', inset(1240), /grid-column:span 12/);
  expectRule('account.css', '.adm-stat-value', '', /overflow-wrap:anywhere/, /font-variant-numeric:tabular-nums/);
  expectRule('account.css', '.adm-area-chart', '', /width:100%/, /height:auto/);
  expectRule('account.css', '.adm-stacked-seg', '', /flex:var\(--share\) 1 0%/, /min-width:4px/);
  expectRule('account.css', '.adm-card-head>.adm-delta-badge', '', /white-space:nowrap/, /flex:none/);
  // no celular a tabela vira cartões: cabeçalho escondido para os olhos (não para leitores) e rótulos por célula
  expectRule('account.css', '.adm-fin-table', W760, /min-width:0!important/);
  expectRule('account.css', '.adm-fin-table thead', W760, /position:absolute/, /clip-path:inset\(50%\)/);
  expectRule('account.css', '.adm-fin-table td[data-label]:before', W760, /content:attr\(data-label\)/);
  expectRule('account.css', '.adm-fin-table tbody tr', W760, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  // em 300px o formulário de 220px caberia só com rolagem: a coluna mínima é min(100%,220px)
  expectRule('account.css', '.admin-code-form', '', /minmax\(min\(100%,220px\),1fr\)/);
  expectRule('account.css', '.adm-period-picker', W480, /width:100%/, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  expectRule('account.css', '.admin-main', W480, /padding:var\(--s2\) var\(--s2\) var\(--s5\)/);
});
