import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_LIMITS, CODE_STATUS_LABELS, codeFormToBody, codeStatus, durationLabel, maskedCode, mintedCodeFrom, parseCodesResponse, usesLabel,
} from './license-codes.js';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const code = (over = {}) => ({
  id: 'c1', suffix: 'AB12', plan: 'pro', periodDays: 30, maxUses: 3, uses: 1, note: 'cortesia', createdBy: 'a@b.dev',
  expiresAt: null, revokedAt: null, createdAt: '2026-09-30T12:00:00.000Z', ...over,
});

test('formulário: vazio vira licença vitalícia, 1 uso, sem prazo para resgatar e sem nota', () => {
  const result = codeFormToBody({ periodDays: '', maxUses: '', expiresInDays: '', note: '' });
  assert.deepEqual(result, { ok: true, body: { maxUses: 1, note: '' } });
});

test('formulário: valores válidos viram o corpo que a API espera (inteiros, nota aparada)', () => {
  const result = codeFormToBody({ periodDays: '30', maxUses: '5', expiresInDays: '90', note: '  minhas máquinas  ' });
  assert.deepEqual(result, { ok: true, body: { periodDays: 30, maxUses: 5, expiresInDays: 90, note: 'minhas máquinas' } });
});

test('formulário: limites idênticos aos do servidor (e do script de emissão)', () => {
  assert.deepEqual(CODE_LIMITS, { periodDays: 36500, maxUses: 100, expiresInDays: 3650, note: 200 });
  assert.equal(codeFormToBody({ periodDays: '36500', maxUses: '100', expiresInDays: '3650', note: 'x'.repeat(200) }).ok, true);
});

test('formulário: recusa o que o servidor recusaria, dizendo o campo', () => {
  const cases = [
    [{ periodDays: '0' }, 'periodDays'], [{ periodDays: '36501' }, 'periodDays'], [{ periodDays: '1.5' }, 'periodDays'], [{ periodDays: 'abc' }, 'periodDays'],
    [{ maxUses: '0' }, 'maxUses'], [{ maxUses: '101' }, 'maxUses'], [{ maxUses: '-1' }, 'maxUses'],
    [{ expiresInDays: '0' }, 'expiresInDays'], [{ expiresInDays: '3651' }, 'expiresInDays'],
    [{ note: 'x'.repeat(201) }, 'note'],
  ];
  for (const [values, field] of cases) {
    const result = codeFormToBody({ periodDays: '', maxUses: '1', expiresInDays: '', note: '', ...values });
    assert.equal(result.ok, false, JSON.stringify(values));
    assert.equal(result.field, field, JSON.stringify(values));
    assert.ok(result.error.length > 20, 'a mensagem precisa explicar como corrigir');
  }
});

test('formulário: notação científica, hexadecimal e espaços não passam por inteiro', () => {
  for (const bad of ['1e2', '0x10', ' 5 ', '５', '+5']) {
    assert.equal(codeFormToBody({ periodDays: '', maxUses: bad, expiresInDays: '', note: '' }).ok, false, bad);
  }
});

test('situação: revogado vence expirado, que vence esgotado, que vence ativo', () => {
  assert.equal(codeStatus(code({ revokedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-09-01T00:00:00Z', uses: 3 }), NOW), 'revoked');
  assert.equal(codeStatus(code({ expiresAt: '2026-09-30T00:00:00Z', uses: 3 }), NOW), 'expired');
  assert.equal(codeStatus(code({ uses: 3 }), NOW), 'exhausted');
  assert.equal(codeStatus(code(), NOW), 'active');
  assert.equal(codeStatus(code({ expiresAt: '2026-12-31T00:00:00Z' }), NOW), 'active');
});

test('situação: toda situação tem rótulo em texto (nunca só cor)', () => {
  for (const status of ['active', 'exhausted', 'expired', 'revoked']) assert.ok(CODE_STATUS_LABELS[status].length > 3);
});

test('rótulos: duração, usos e código mascarado', () => {
  assert.equal(durationLabel(null), 'Vitalícia');
  assert.equal(durationLabel(1), '1 dia');
  assert.equal(durationLabel(30), '30 dias');
  assert.equal(usesLabel(code({ uses: 1, maxUses: 3 })), '1 de 3');
  assert.equal(maskedCode('AB12'), 'NEXUS-••••-••••-AB12');
});

test('código recém-gerado: só aceita o formato exato, para nunca exibir lixo como se fosse um código', () => {
  assert.equal(mintedCodeFrom({ id: 'x', code: 'NEXUS-0123-ABCD-WXYZ' }), 'NEXUS-0123-ABCD-WXYZ');
  for (const bad of [null, {}, { code: 'nexus-0123-abcd-wxyz' }, { code: 'NEXUS-0123-ABCD' }, { code: '<script>' }, { code: 42 }]) {
    assert.equal(mintedCodeFrom(bad), null, JSON.stringify(bad));
  }
});

test('lista: aceita o formato da API e rejeita resposta malformada com mensagem clara', () => {
  assert.equal(parseCodesResponse({ codes: [code(), code({ id: 'c2', periodDays: null })] }).length, 2);
  assert.deepEqual(parseCodesResponse({ codes: [] }), []);
  for (const bad of [null, {}, { codes: 'x' }, { codes: [{}] }, { codes: [code({ maxUses: 'muitos' })] }, { codes: [code({ suffix: 'ABCDE' })] }]) {
    assert.throws(() => parseCodesResponse(bad), /lista de códigos válida/, JSON.stringify(bad));
  }
});
