import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNotice } from '../src/email/templates.js';
import { NOTICE_KINDS } from '../src/email/notices.js';

const UNSUB = 'https://api.nexuside.app/v1/notices/unsubscribe?a=acc-1&t=abc_DEF-123';
const base = { name: 'Ana Silva', trialEndsAt: '2026-10-16T15:00:00.000Z', daysLeft: 3, unsubscribeUrl: UNSUB };
// Pictogramas coloridos renderizam diferente em cada cliente e pesam no filtro de spam; ✓ → █ ░ do visual de terminal são texto.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{FE0F}]/u;

test('todo tipo renderiza assunto de uma linha, HTML e texto, sempre com descadastro e a razão do envio', () => {
  for (const kind of NOTICE_KINDS) {
    const out = renderNotice(kind, base);
    assert.ok(out.subject.length > 10 && out.subject.length <= 78, `${kind}: assunto`);
    assert.doesNotMatch(out.subject, /[\r\n]/);
    assert.ok(out.html.includes('Você recebeu este aviso porque criou uma conta no NexusIDE'), `${kind}: razão no HTML`);
    assert.ok(out.text.includes('Você recebeu este aviso porque criou uma conta no NexusIDE'), `${kind}: razão no texto`);
    assert.ok(out.html.includes(UNSUB.replaceAll('&', '&amp;')), `${kind}: link de descadastro no HTML`);
    assert.ok(out.text.includes(UNSUB), `${kind}: link de descadastro no texto`);
    assert.doesNotMatch(out.subject + out.html + out.text, EMOJI, `${kind}: sem emoji`);
  }
});

test('o assunto diz o que acontece, sem o nome da pessoa', () => {
  assert.match(renderNotice('welcome', base).subject, /Bem-vindo ao NexusIDE/);
  assert.match(renderNotice('trial_ending_3d', base).subject, /3 dias/);
  assert.match(renderNotice('trial_ending_3d', { ...base, daysLeft: 2 }).subject, /2 dias/);
  assert.match(renderNotice('trial_ending_1d', { ...base, daysLeft: 1 }).subject, /24 horas/);
  assert.match(renderNotice('trial_ended', base).subject, /terminou/);
  for (const kind of NOTICE_KINDS) assert.doesNotMatch(renderNotice(kind, base).subject, /Ana/);
});

test('o texto escapado: nome e valores dinâmicos nunca viram HTML', () => {
  const evil = '<script>alert(1)</script>"&\'';
  const out = renderNotice('trial_ending_3d', { ...base, name: evil, priceLabel: '<b>R$ 1</b>', unsubscribeUrl: 'https://api.nexuside.app/x?a=1&t="><img src=x>' });
  assert.doesNotMatch(out.html, /<script|<img|<b>|"><img/i);
  assert.ok(out.html.includes('&lt;b&gt;R$ 1&lt;/b&gt;'));
  assert.doesNotMatch(out.text, /<script|<img|<b>/i, 'o texto também não carrega marcação do nome');
});

test('só HTML de e-mail simples: estilos inline, 600 px, sem imagem, script, folha de estilo ou fonte remota', () => {
  const html = renderNotice('welcome', base).html;
  assert.match(html, /max-width:600px/);
  assert.match(html, /#080709/);
  assert.match(html, /#ff4f8b/);
  assert.doesNotMatch(html, /<img|<script|<link|<style|@import|url\(/i);
  assert.doesNotMatch(html, /src=|javascript:/i);
});

test('o texto simples não tem marcação', () => {
  for (const kind of NOTICE_KINDS) assert.doesNotMatch(renderNotice(kind, base).text, /<[a-z/][^>]*>|&nbsp;|&amp;/i, kind);
});

test('links: boas-vindas e os de fim de teste apontam para a conta e para o plano', () => {
  assert.match(renderNotice('welcome', base).html, /href="https:\/\/nexuside\.app\/conta\/"/);
  for (const kind of ['trial_ending_3d', 'trial_ending_1d', 'trial_ended'] as const) {
    const out = renderNotice(kind, base);
    assert.match(out.html, /href="https:\/\/nexuside\.app\/conta\/\?plano=pro"/, kind);
    assert.ok(out.text.includes('https://nexuside.app/conta/?plano=pro'), kind);
  }
});

test('o preço nunca vem escrito no modelo: só aparece se quem chama o passar', () => {
  for (const kind of NOTICE_KINDS) {
    const out = renderNotice(kind, base);
    assert.doesNotMatch(out.subject + out.html + out.text, /R\$|\d+,\d{2}|reais|por mês/i, kind);
  }
  const withPrice = renderNotice('trial_ending_3d', { ...base, priceLabel: 'R$ 59,99 / mês' });
  assert.ok(withPrice.html.includes('R$ 59,99 / mês') && withPrice.text.includes('R$ 59,99 / mês'));
});

test('os números do teste vêm dos parâmetros (padrão 15 dias e 2 agentes) e a data sai em português, no horário de Brasília', () => {
  const standard = renderNotice('welcome', base);
  assert.match(standard.text, /15 dias/);
  assert.match(standard.text, /até 2 agentes/);
  assert.match(standard.text, /16 de outubro de 2026/);
  const custom = renderNotice('welcome', { ...base, trialDays: 7, maxAgents: 3 });
  assert.match(custom.text, /7 dias/);
  assert.match(custom.text, /até 3 agentes/);
  assert.doesNotMatch(custom.text, /15 dias/);
  assert.match(renderNotice('trial_ending_3d', { ...base, trialEndsAt: '2026-10-17T01:30:00.000Z' }).text, /16 de outubro de 2026/, '01:30 UTC ainda é dia 16 em Brasília');
});

test('sem nome a saudação continua natural; com nome usa só o primeiro', () => {
  assert.match(renderNotice('welcome', { ...base, name: null }).text, /^Olá,\n/);
  assert.match(renderNotice('welcome', base).text, /^Olá, Ana,\n/);
  assert.match(renderNotice('welcome', { ...base, name: '  ' }).text, /^Olá,\n/);
});

test('nada promete o que não existe: sem garantia, desconto ou urgência inventada', () => {
  for (const kind of NOTICE_KINDS) assert.doesNotMatch(renderNotice(kind, base).text, /garant|desconto|grátis|gratuit|última chance|promoção|só hoje/i, kind);
  assert.match(renderNotice('trial_ending_3d', base).text, /nada é cobrado sem a sua confirmação/i);
});

test('o link de descadastro tem de ser https; senão o modelo recusa em vez de enviar link perigoso', () => {
  for (const bad of ['http://api.nexuside.app/x', 'javascript:alert(1)', '', 'ftp://x']) assert.throws(() => renderNotice('welcome', { ...base, unsubscribeUrl: bad }), /unsubscribeUrl/);
});

test('data inválida não derruba a renderização: o texto fala do fim do teste sem inventar data', () => {
  const out = renderNotice('trial_ending_3d', { ...base, trialEndsAt: 'ontem' });
  assert.doesNotMatch(out.text, /undefined|Invalid|NaN/);
});

test('o aviso de teste terminado não afirma a duração do teste (o admin pode ter estendido)', () => {
  assert.doesNotMatch(renderNotice('trial_ended', base).text, /\b\d+ dias\b/);
  assert.match(renderNotice('trial_ended', base).text, /terminou em 16 de outubro de 2026/);
});

// ---- Cara de dev e tom jovial ----
const TERMINAL_COMMAND = { welcome: '$ nexus init', trial_ending_3d: '$ nexus trial --status', trial_ending_1d: '$ nexus trial --status', trial_ended: '$ nexus trial --status' } as const;

test('visual de dev: cada aviso traz uma janela de terminal com o comando, em fonte monoespaçada, no HTML e no texto', () => {
  for (const kind of NOTICE_KINDS) {
    const out = renderNotice(kind, base);
    assert.ok(out.text.includes(TERMINAL_COMMAND[kind]), `${kind}: comando no texto`);
    // No HTML o prompt `$` é rosa e o comando vai num span próprio.
    assert.ok(out.html.includes('>$</span>'), `${kind}: prompt`);
    assert.ok(out.html.includes(escapeForHtml(TERMINAL_COMMAND[kind].slice(2))), `${kind}: comando no HTML`);
    assert.match(out.html, /font-family:'SF Mono'/, `${kind}: fonte monoespaçada`);
    assert.match(out.html, /nexus — zsh/, `${kind}: barra de título do terminal`);
    assert.match(out.html, /#ff5f57/, `${kind}: bolinhas da janela`);
  }
});
function escapeForHtml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

test('a barra de progresso do teste conta os dias que já passaram, com os números do teste', () => {
  assert.match(renderNotice('welcome', base).text, /\[░{15}\] 0\/15/);
  assert.match(renderNotice('trial_ending_3d', base).text, /\[█{12}░{3}\] 12\/15/);
  assert.match(renderNotice('trial_ending_3d', { ...base, daysLeft: 2 }).text, /\[█{13}░{2}\] 13\/15/);
  assert.match(renderNotice('trial_ending_1d', { ...base, daysLeft: 1 }).text, /\[█{14}░\] 14\/15/);
  assert.match(renderNotice('trial_ending_3d', { ...base, trialDays: 7, daysLeft: 3 }).text, /\[█{9}░{6}\] 4\/7/);
  // Teste estendido pelo admin: no aviso de fim a barra não afirma uma duração que pode não ser a real.
  assert.doesNotMatch(renderNotice('trial_ended', base).text, /[█░]/);
});

test('a voz é de dev e bem-humorada: manchete, comentário final e nenhum clichê de marketing', () => {
  const lines = { welcome: /passou de primeira/, trial_ending_3d: /hot reload/, trial_ending_1d: /último commit/, trial_ended: /Exit code 0/ } as const;
  for (const kind of NOTICE_KINDS) {
    const out = renderNotice(kind, base);
    assert.match(out.text, lines[kind], `${kind}: manchete`);
    assert.match(out.text, /\nP\.S\.: /, `${kind}: comentário final`);
    assert.doesNotMatch(out.text, /imperdível|corra|aproveite agora|oferta|não perca/i, `${kind}: sem urgência de marketing`);
  }
});

test('a piada nunca atrapalha o que importa: prazo, o que fazer e que nada é cobrado sem confirmação', () => {
  for (const kind of ['trial_ending_3d', 'trial_ending_1d', 'trial_ended'] as const) {
    const text = renderNotice(kind, base).text;
    assert.match(text, /16 de outubro de 2026/, `${kind}: data`);
    assert.match(text, /plano Pro/, `${kind}: o que fazer`);
    assert.match(text, /Nada é cobrado sem a sua confirmação/, `${kind}: sem cobrança surpresa`);
  }
});

test('o aviso de boas-vindas aponta o download, e os valores do terminal também são escapados', () => {
  assert.match(renderNotice('welcome', base).html, /href="https:\/\/nexuside\.app\/#download"/);
  assert.ok(renderNotice('welcome', base).text.includes('https://nexuside.app/#download'));
  const evil = renderNotice('welcome', { ...base, name: '<b>x</b>', trialEndsAt: '2026-10-16T15:00:00.000Z' });
  assert.doesNotMatch(evil.html, /<b>x<\/b>/);
});

test('os assuntos continuam curtos, em uma linha e sem pictograma, mesmo com a piada', () => {
  for (const kind of NOTICE_KINDS) {
    const subject = renderNotice(kind, base).subject;
    assert.ok(subject.length <= 78, `${kind}: ${subject.length} caracteres`);
    assert.doesNotMatch(subject, EMOJI);
  }
  assert.match(renderNotice('welcome', base).subject, /15 dias de teste/);
});

test('a barra de progresso pinta os dias que já passaram de rosa e deixa o resto apagado, sem mudar o texto', () => {
  const html = renderNotice('trial_ending_3d', base).html;
  assert.ok(html.includes('<span style="color:#ff4f8b;">████████████</span>'), 'blocos usados em rosa');
  assert.ok(html.includes('<span style="color:#5d5560;">░░░</span>'), 'blocos restantes apagados');
  assert.match(renderNotice('trial_ending_3d', base).text, /\[█{12}░{3}\] 12\/15/);
  // Bateria cheia ou vazia não deixa span sem conteúdo.
  assert.doesNotMatch(renderNotice('welcome', base).html, /<span style="color:#ff4f8b;"><\/span>/);
});
