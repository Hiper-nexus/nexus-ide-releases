import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNotice } from '../src/email/templates.js';
import { NOTICE_KINDS } from '../src/email/notices.js';

const UNSUB = 'https://api.nexuside.app/v1/notices/unsubscribe?a=acc-1&t=abc_DEF-123';
const base = { name: 'Ana Silva', trialEndsAt: '2026-10-16T15:00:00.000Z', daysLeft: 3, unsubscribeUrl: UNSUB };
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

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
