import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORY_LABELS, EVENT_LABELS, SEVERITY_LABELS, STATUS_LABELS, STATUS_TRANSITIONS, actionRequirements, describeEvent, listQuery,
  nextStatuses, openTotal, parseDetailResponse, parseListResponse, patchBody, safeHttpsUrl,
} from './bug-reports.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';

test('todo status, gravidade, categoria e evento tem rótulo em português', () => {
  for (const key of Object.keys(STATUS_TRANSITIONS)) assert.ok(STATUS_LABELS[key], `status ${key}`);
  for (const key of ['low', 'medium', 'high', 'blocker']) assert.ok(SEVERITY_LABELS[key], key);
  for (const key of ['crash', 'terminal', 'agents', 'license', 'billing', 'ui', 'performance', 'other']) assert.ok(CATEGORY_LABELS[key], key);
  for (const key of ['created', 'status_changed', 'severity_changed', 'note', 'duplicate_marked', 'fix_proposed', 'approved', 'rejected', 'released']) assert.ok(EVENT_LABELS[key], key);
});

test('as transições espelham as do servidor: aprovar só vem de "correção proposta", liberar só de aprovado ou corrigido', () => {
  assert.deepEqual(nextStatuses('new').map(item => item.status), ['triaged', 'needs_info', 'wont_fix', 'duplicate']);
  assert.deepEqual(nextStatuses('fix_proposed').map(item => item.status), ['approved', 'triaged', 'wont_fix']);
  assert.ok(!nextStatuses('triaged').some(item => item.status === 'approved'), 'não se aprova sem propor antes');
  assert.ok(!nextStatuses('new').some(item => item.status === 'released'));
  assert.ok(nextStatuses('approved').some(item => item.status === 'released'));
  assert.deepEqual(nextStatuses('invalido'), []);
  assert.equal(nextStatuses('new')[0].label, 'Triado');
});

test('o que cada passo exige: resumo da correção ao propor e ao aprovar, original ao marcar duplicata, confirmação ao autorizar', () => {
  assert.deepEqual(actionRequirements('triaged', 'fix_proposed'), { fixSummary: true, duplicateOf: false, confirm: null });
  const approve = actionRequirements('fix_proposed', 'approved');
  assert.equal(approve.fixSummary, true);
  assert.match(approve.confirm, /autoriz/i);
  assert.deepEqual(actionRequirements('new', 'duplicate'), { fixSummary: false, duplicateOf: true, confirm: null });
  assert.deepEqual(actionRequirements('new', 'triaged'), { fixSummary: false, duplicateOf: false, confirm: null });
});

test('a consulta da lista só leva filtros válidos e pede 50 por página', () => {
  assert.equal(listQuery({}), 'limit=50');
  assert.equal(listQuery({ status: 'new', category: 'crash', severity: 'high', q: '  travou  ' }), 'limit=50&status=new&category=crash&severity=high&q=travou');
  assert.equal(listQuery({ status: 'inventado', category: '', q: 'x'.repeat(300) }), `limit=50&q=${'x'.repeat(100)}`);
  assert.equal(listQuery({ cursor: 'abc_DEF-123' }), 'limit=50&cursor=abc_DEF-123');
  assert.equal(listQuery({ cursor: '../etc' }), 'limit=50');
});

test('só URL https pública vira link; o resto fica como texto', () => {
  assert.equal(safeHttpsUrl('https://github.com/x/pull/1'), 'https://github.com/x/pull/1');
  for (const bad of ['http://x.com', 'javascript:alert(1)', 'https://u:p@x.com/', '', null, undefined, 'ftp://x']) assert.equal(safeHttpsUrl(bad), null, String(bad));
});

test('o corpo do PATCH valida o que o servidor vai exigir, antes de enviar', () => {
  const current = { status: 'triaged', severity: 'medium', fixSummary: null, fixPrUrl: null };
  assert.deepEqual(patchBody(current, { status: 'needs_info', note: 'Pedi o log ao usuário.' }), { ok: true, body: { status: 'needs_info', note: 'Pedi o log ao usuário.' } });
  assert.deepEqual(patchBody(current, { status: 'fix_proposed' }), { ok: false, field: 'fixSummary', error: 'Descreva a correção proposta antes de enviar.' });
  assert.deepEqual(patchBody(current, { status: 'fix_proposed', fixSummary: 'Trocar o limite de 10 para 50.', fixPrUrl: 'https://github.com/o/r/pull/9' }).body,
    { status: 'fix_proposed', fixSummary: 'Trocar o limite de 10 para 50.', fixPrUrl: 'https://github.com/o/r/pull/9' });
  assert.equal(patchBody(current, { status: 'fix_proposed', fixSummary: 'ok', fixPrUrl: 'http://x.com' }).field, 'fixPrUrl');
  assert.equal(patchBody({ ...current, status: 'new' }, { status: 'duplicate' }).field, 'duplicateOf');
  assert.equal(patchBody({ ...current, status: 'new' }, { status: 'duplicate', duplicateOf: 'não-é-uuid' }).field, 'duplicateOf');
  assert.deepEqual(patchBody({ ...current, status: 'new' }, { status: 'duplicate', duplicateOf: ID }).body, { status: 'duplicate', duplicateOf: ID });
  assert.equal(patchBody(current, { note: 'x'.repeat(2001) }).field, 'note');
  assert.deepEqual(patchBody(current, {}), { ok: false, field: 'status', error: 'Escolha uma ação, uma gravidade ou escreva uma nota.' });
});

test('aprovar usa o resumo já proposto: não obriga a digitar de novo, mas bloqueia se não houver', () => {
  const proposed = { status: 'fix_proposed', severity: 'high', fixSummary: 'Trocar o limite.', fixPrUrl: null };
  assert.deepEqual(patchBody(proposed, { status: 'approved' }), { ok: true, body: { status: 'approved' } });
  assert.equal(patchBody({ ...proposed, fixSummary: null }, { status: 'approved' }).field, 'fixSummary');
});

test('a gravidade só vai no corpo quando mudou', () => {
  const current = { status: 'new', severity: 'medium', fixSummary: null, fixPrUrl: null };
  assert.deepEqual(patchBody(current, { severity: 'high' }).body, { severity: 'high' });
  assert.equal(patchBody(current, { severity: 'medium' }).ok, false);
  assert.equal(patchBody(current, { severity: 'altissima' }).field, 'severity');
});

test('a resposta da lista é validada: item fora do formato é descartado, nunca quebra a tela', () => {
  const item = { id: ID, title: 'Travou', status: 'new', severity: 'medium', category: 'crash', impact: 'annoying', appVersion: '0.76.161', platform: 'darwin', createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', occurrences: 3, duplicateOf: null, hasDiagnostics: true, reporterEmail: 'a@b.co' };
  const parsed = parseListResponse({ reports: [item, { id: 1 }, null, { ...item, status: 'inventado' }], nextCursor: 'abc' });
  assert.equal(parsed.reports.length, 1);
  assert.equal(parsed.nextCursor, 'abc');
  assert.deepEqual(parseListResponse(null), { reports: [], nextCursor: null });
  assert.deepEqual(parseListResponse({ reports: 'x' }), { reports: [], nextCursor: null });
});

test('a resposta do detalhe exige o relato e as linhas do tempo, e nunca inventa campos', () => {
  const report = { id: ID, title: 'T', description: 'D', steps: null, status: 'new', severity: 'medium', category: 'ui', impact: 'annoying', appVersion: '1', platform: 'win32', arch: 'x64', osVersion: null,
    context: { adapter: null, model: null, paneCount: null, missionActive: null }, diagnostics: null, diagnosticsExpiresAt: '2027-03-31T00:00:00.000Z', occurrences: 1, duplicateOf: null, fixSummary: null, fixPrUrl: null,
    reporter: { id: 'a', email: 'a@b.co', name: null }, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' };
  const parsed = parseDetailResponse({ report, events: [{ id: 'e1', kind: 'created', details: { diagnostics: false }, createdAt: '2026-10-02T00:00:00.000Z', actor: null }, { kind: 'x' }] });
  assert.equal(parsed.report.title, 'T');
  assert.equal(parsed.events.length, 1);
  assert.equal(parseDetailResponse({ report: { id: 1 }, events: [] }), null);
  assert.equal(parseDetailResponse(null), null);
});

test('cada evento da linha do tempo vira uma frase curta em português, sem HTML', () => {
  const at = '2026-10-02T00:00:00.000Z';
  assert.equal(describeEvent({ kind: 'created', details: { diagnostics: true }, createdAt: at, actor: null }), 'Relato enviado, com diagnóstico.');
  assert.equal(describeEvent({ kind: 'created', details: { diagnostics: false }, createdAt: at, actor: null }), 'Relato enviado.');
  assert.equal(describeEvent({ kind: 'status_changed', details: { from: 'new', to: 'triaged' }, createdAt: at, actor: { email: 'admin@x.co' } }), 'admin@x.co mudou o status de Novo para Triado.');
  assert.equal(describeEvent({ kind: 'approved', details: { from: 'fix_proposed', to: 'approved', fixSummary: 'S' }, createdAt: at, actor: { email: 'admin@x.co' } }), 'admin@x.co autorizou a correção: S');
  assert.equal(describeEvent({ kind: 'note', details: { note: 'Pedi o log.' }, createdAt: at, actor: { email: 'admin@x.co' } }), 'admin@x.co anotou: Pedi o log.');
  assert.equal(describeEvent({ kind: 'severity_changed', details: { from: 'medium', to: 'high' }, createdAt: at, actor: null }), 'Gravidade de Média para Alta.');
  assert.equal(describeEvent({ kind: 'note', details: { updated: ['fixSummary'] }, createdAt: at, actor: null }), 'Correção atualizada.');
  assert.equal(describeEvent({ kind: 'desconhecido', details: {}, createdAt: at, actor: null }), 'Evento registrado.');
});

test('o total de abertos soma as gravidades abertas', () => {
  assert.equal(openTotal({ openBySeverity: { low: 1, medium: 2, high: 3, blocker: 4 } }), 10);
  assert.equal(openTotal(null), 0);
  assert.equal(openTotal({ openBySeverity: { low: 'x' } }), 0);
});
