import test from 'node:test';
import assert from 'node:assert/strict';
import { formatOffer, formatRelease, newestRelease, relativeTime } from './proof.js';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const HOUR = 3_600_000;

test('tempo relativo em português, sem exagero de precisão', () => {
  assert.equal(relativeTime(NOW - 30_000, NOW), 'agora há pouco');
  assert.equal(relativeTime(NOW - 5 * 60_000, NOW), 'há 5 min');
  assert.equal(relativeTime(NOW - 2 * HOUR, NOW), 'há 2 h');
  assert.equal(relativeTime(NOW - 26 * HOUR, NOW), 'ontem');
  assert.equal(relativeTime(NOW - 3 * 24 * HOUR, NOW), 'há 3 dias');
  assert.equal(relativeTime(NOW - 40 * 24 * HOUR, NOW), null, 'mais de 30 dias: não vale como prova de ritmo');
  assert.equal(relativeTime(NOW + HOUR, NOW), 'agora há pouco', 'relógio adiantado não vira data no futuro');
  assert.equal(relativeTime(NaN, NOW), null);
});

test('a oferta junta teste sem cartão e preço, só com o que o servidor confirmou', () => {
  const view = { state: 'disponivel', price: 'R$ 59,99 / mês', trial: { days: 15, maxAgents: 2, cloudSync: false } };
  assert.equal(formatOffer(view), '15 dias de teste, sem cartão · depois R$ 59,99 / mês');
  assert.equal(formatOffer({ ...view, price: null }), '15 dias de teste, sem cartão');
  assert.equal(formatOffer({ ...view, trial: { ...view.trial, days: 1 } }), '1 dia de teste, sem cartão · depois R$ 59,99 / mês');
  assert.equal(formatOffer({ state: 'indisponivel', price: null, trial: null }), null);
  assert.equal(formatOffer(null), null);
});

test('a release mais recente é a de maior data entre Mac e Windows', () => {
  const catalog = { macos: [{ version: '0.76.161', publishedAt: '2026-10-02T00:03:00Z' }], windows: [{ version: '0.76.160', publishedAt: '2026-10-01T22:50:00Z' }] };
  assert.deepEqual(newestRelease(catalog), { version: '0.76.161', publishedAt: '2026-10-02T00:03:00Z' });
  assert.deepEqual(newestRelease({ macos: [], windows: [{ version: '1.0.0', publishedAt: '2026-10-01T10:00:00Z' }] }), { version: '1.0.0', publishedAt: '2026-10-01T10:00:00Z' });
  assert.equal(newestRelease({ macos: [], windows: [] }), null);
  assert.equal(newestRelease(null), null);
  assert.equal(newestRelease({ macos: [{ version: 'x', publishedAt: 'ontem' }], windows: [] }), null, 'data inválida não vira prova');
});

test('a linha da release diz a versão e quando saiu', () => {
  assert.equal(formatRelease({ version: '0.76.161', publishedAt: '2026-10-02T10:00:00Z' }, NOW), 'v0.76.161 · publicada há 2 h');
  assert.equal(formatRelease({ version: '0.76.160', publishedAt: '2026-08-01T10:00:00Z' }, NOW), 'v0.76.160');
  assert.equal(formatRelease(null, NOW), null);
});
