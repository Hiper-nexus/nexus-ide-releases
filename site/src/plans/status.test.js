import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_STATE, STATE_MESSAGES, validateStatus, formatPrice, describeStatus, planCopy } from './status.js';

const valid = {
  ready: true,
  auth: { google: true, github: true },
  billing: { available: true, amount: 5999, currency: 'brl', interval: 'month' },
  trial: { days: 15, maxAgents: 2, cloudSync: false },
};

test('accepts the contract payload and formats the price in pt-BR', () => {
  const view = describeStatus(valid);
  assert.equal(view.state, PLAN_STATE.AVAILABLE);
  assert.equal(view.price, 'R$ 59,99 / mês');
  assert.deepEqual(view.trial, { days: 15, maxAgents: 2, cloudSync: false });
  assert.equal(formatPrice(1200), 'R$ 12,00');
});

test('rejects prices that break the contract', () => {
  const billing = [
    { available: true, amount: 5999, currency: 'usd', interval: 'month' },
    { available: true, amount: 5999, currency: 'brl', interval: 'year' },
    { available: true, amount: 0, currency: 'brl', interval: 'month' },
    { available: true, amount: -5999, currency: 'brl', interval: 'month' },
    { available: true, amount: 59.99, currency: 'brl', interval: 'month' },
    { available: true, amount: '5999', currency: 'brl', interval: 'month' },
    { available: true, currency: 'brl', interval: 'month' },
  ];
  for (const value of billing) {
    assert.equal(validateStatus({ ...valid, billing: value }), null, JSON.stringify(value));
    assert.equal(describeStatus({ ...valid, billing: value }).state, PLAN_STATE.UNAVAILABLE);
  }
});

test('rejects trial limits that are not positive integers', () => {
  const trial = [
    { days: 0, maxAgents: 2, cloudSync: false },
    { days: -15, maxAgents: 2, cloudSync: false },
    { days: 15.5, maxAgents: 2, cloudSync: false },
    { days: '15', maxAgents: 2, cloudSync: false },
    { days: 15, maxAgents: 0, cloudSync: false },
    { days: 15, maxAgents: '2', cloudSync: false },
    { days: 15, maxAgents: 2, cloudSync: 'no' },
    null,
  ];
  for (const value of trial) assert.equal(validateStatus({ ...valid, trial: value }), null, JSON.stringify(value));
});

test('rejects payloads with wrong types elsewhere', () => {
  for (const patch of [
    { ready: 'true' },
    { auth: { google: true } },
    { auth: { google: 'yes', github: true } },
    { billing: null },
    { ready: 1 },
  ]) assert.equal(validateStatus({ ...valid, ...patch }), null, JSON.stringify(patch));
  for (const bad of [null, undefined, 'status', 42]) assert.equal(validateStatus(bad), null);
});

test('keeps the trial facts when billing is closed', () => {
  const view = describeStatus({ ...valid, billing: { available: false } });
  assert.equal(view.state, PLAN_STATE.UNAVAILABLE);
  assert.equal(view.price, null);
  assert.deepEqual(view.trial, { days: 15, maxAgents: 2, cloudSync: false });
});

test('an unready service is unavailable even with a valid price', () => {
  const view = describeStatus({ ...valid, ready: false });
  assert.equal(view.state, PLAN_STATE.UNAVAILABLE);
  assert.equal(view.price, null);
});

test('every state has copy, and the failure states promise no charge', () => {
  for (const state of Object.values(PLAN_STATE)) assert.equal(typeof STATE_MESSAGES[state], 'string');
  assert.match(STATE_MESSAGES.consultando, /Consultando/);
  for (const state of [PLAN_STATE.UNAVAILABLE, PLAN_STATE.ERROR]) {
    assert.match(STATE_MESSAGES[state], /indisponível/i, state);
    assert.match(STATE_MESSAGES[state], /nenhuma cobrança/i, state);
  }
});

test('plan copy reads the trial values confirmed by the server', () => {
  const copy = planCopy(describeStatus(valid));
  assert.equal(copy.trialDays, '15 dias para experimentar o NexusIDE.');
  assert.equal(copy.trialAgents, 'Até 2 agentes simultâneos.');
});

test('plan copy without server confirmation keeps the values marked as pending', () => {
  const copy = planCopy({ state: PLAN_STATE.ERROR });
  assert.equal(copy.price, 'Preço indisponível por enquanto.');
  assert.equal(copy.trialDays, 'Dias do teste indisponíveis por enquanto.');
  assert.equal(copy.trialAgents, 'Limite de agentes indisponível por enquanto.');
});

test('preserva períodos válidos e ignora uma lista malformada sem derrubar o mensal', () => {
  const intervals = [{ id: 'quarter', months: 3, amount: 17997, available: false }];
  const kept = validateStatus({ ...valid, billing: { ...valid.billing, intervals } });
  assert.deepEqual(kept.billing.intervals, intervals);
  assert.equal(describeStatus({ ...valid, billing: { ...valid.billing, intervals } }).price, 'R$\u00a059,99 / mês');
  const dropped = validateStatus({ ...valid, billing: { ...valid.billing, intervals: [{ id: 'week', months: 1, amount: 1, available: true }] } });
  assert.equal(dropped.billing.intervals, undefined);
  assert.equal(dropped.billing.amount, 5999);
});
