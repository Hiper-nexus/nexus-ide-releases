import test from 'node:test';
import assert from 'node:assert/strict';
import {
  couponFormToBody, couponIntervalsLabel, couponKindLabel, couponStatus, couponUsesLabel, couponValueLabel, parseCouponsResponse,
} from './admin-coupons.js';

const now = Date.parse('2026-10-04T12:00:00.000Z');

test('cria percentual e valor em reais sem perder centavos', () => {
  const percent = couponFormToBody({
    code: 'verao 10', kind: 'percent', value: '10', intervals: ['year', 'month'], expires: '2026-12-31', maxRedemptions: '5',
  }, now);
  assert.equal(percent.ok, true);
  assert.deepEqual(percent.body, {
    code: 'VERAO10', kind: 'percent', value: 10, intervals: ['year', 'month'],
    expiresAt: '2026-12-31T23:59:59.999Z', maxRedemptions: 5,
  });
  const amount = couponFormToBody({ code: 'DEZ', kind: 'amount', value: '10,50', intervals: ['quarter'], expires: '', maxRedemptions: '' }, now);
  assert.equal(amount.ok, true);
  assert.equal(amount.body.value, 1050);
  assert.equal(amount.body.expiresAt, undefined);
  assert.equal(amount.body.maxRedemptions, undefined);
});

test('recusa código, percentual, valor, período, prazo e limite ruins', () => {
  assert.equal(couponFormToBody({ code: '!!', kind: 'percent', value: '10', intervals: ['month'] }, now).error, 'Use letras, números e hífen, de 3 a 32 caracteres.');
  assert.match(couponFormToBody({ code: 'OKOK', kind: 'percent', value: '0', intervals: ['month'] }, now).error, /1 a 100/);
  assert.match(couponFormToBody({ code: 'OKOK', kind: 'percent', value: '101', intervals: ['month'] }, now).error, /1 a 100/);
  assert.match(couponFormToBody({ code: 'OKOK', kind: 'amount', value: 'dez', intervals: ['month'] }, now).error, /reais/);
  assert.match(couponFormToBody({ code: 'OKOK', kind: 'percent', value: '10', intervals: [] }, now).error, /pelo menos um período/);
  assert.match(couponFormToBody({ code: 'OKOK', kind: 'percent', value: '10', intervals: ['month'], expires: '2020-01-01' }, now).error, /data futura/);
  assert.match(couponFormToBody({ code: 'OKOK', kind: 'percent', value: '10', intervals: ['month'], maxRedemptions: '0' }, now).error, /limite de usos/);
});

test('mostra situação, valor, usos e períodos, e recusa lista inesperada', () => {
  const base = {
    id: 'c1', code: 'VERAO10', kind: 'percent', value: 10, intervals: ['month', 'year'],
    uses: 1, maxRedemptions: 2, active: true, expiresAt: '2026-12-31T23:59:59.999Z', disabledAt: null, createdAt: '2026-10-01T00:00:00.000Z',
  };
  assert.equal(couponStatus(base, now), 'active');
  assert.equal(couponStatus({ ...base, active: false }, now), 'off');
  assert.equal(couponStatus({ ...base, expiresAt: '2026-10-01T00:00:00.000Z' }, now), 'expired');
  assert.equal(couponStatus({ ...base, uses: 2 }, now), 'used');
  assert.equal(couponValueLabel(base), '10%');
  assert.equal(couponValueLabel({ ...base, kind: 'amount', value: 1050 }), 'R$\u00a010,50');
  assert.equal(couponKindLabel('amount'), 'Valor em reais');
  assert.equal(couponIntervalsLabel(['year', 'month']), 'Mensal, Anual');
  assert.equal(couponUsesLabel(base), '1 de 2');
  assert.equal(couponUsesLabel({ ...base, maxRedemptions: null }), '1');
  assert.equal(parseCouponsResponse({ coupons: [base] })[0].code, 'VERAO10');
  assert.throws(() => parseCouponsResponse({ coupons: [{ ...base, stripe_coupon_id: 'nxc_x' }] }), /lista de cupons/);
  assert.throws(() => parseCouponsResponse({ coupons: [{ ...base, code: '!!' }] }), /lista de cupons/);
});
