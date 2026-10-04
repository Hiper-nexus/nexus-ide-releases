import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutBody, clientCouponError, offerLabel, offersFromBilling } from './checkout-offer.js';

const billing = {
  available: true,
  amount: 5999,
  currency: 'brl',
  interval: 'month',
  intervals: [
    { id: 'month', months: 1, amount: 5999, available: true },
    { id: 'quarter', months: 3, amount: 17997, available: true },
    { id: 'semiannual', months: 6, amount: 35994, available: false },
    { id: 'year', months: 12, amount: 71988, available: true },
  ],
};

test('monta os quatro períodos pelo mensal vezes os meses', () => {
  const offers = offersFromBilling(billing);
  assert.deepEqual(offers.map((offer) => [offer.id, offer.amount, offer.available]), [
    ['month', 5999, true],
    ['quarter', 17997, true],
    ['semiannual', 35994, false],
    ['year', 71988, true],
  ]);
  assert.match(offerLabel(offers[1]), /Trimestral/);
  assert.match(offerLabel(offers[1]), /179,97/);
  assert.match(offerLabel(offers[2]), /indisponível/);
  assert.doesNotMatch(offerLabel(offers[3]), /desconto|%/);
});

test('um valor que não é o mensal vezes os meses fica indisponível', () => {
  const offers = offersFromBilling({
    ...billing,
    intervals: [{ id: 'quarter', months: 3, amount: 14997, available: true }],
  });
  assert.equal(offers.find((offer) => offer.id === 'quarter').available, false);
  assert.equal(offers.find((offer) => offer.id === 'quarter').amount, 17997);
});

test('sem a lista nova, só o mensal já publicado fica disponível', () => {
  const offers = offersFromBilling({ available: true, amount: 5999, currency: 'brl', interval: 'month' });
  assert.deepEqual(offers.map((offer) => offer.available), [true, false, false, false]);
});

test('o corpo do checkout leva o período e só inclui cupom válido', () => {
  const attemptId = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(checkoutBody({ interval: 'month', coupon: '  ', attemptId }), { plan: 'pro', attemptId, interval: 'month' });
  assert.deepEqual(checkoutBody({ interval: 'quarter', coupon: '', attemptId }), { plan: 'pro', attemptId, interval: 'quarter' });
  assert.deepEqual(checkoutBody({ interval: 'year', coupon: 'nexus 10', attemptId }), {
    plan: 'pro', attemptId, interval: 'year', coupon: 'NEXUS10',
  });
  assert.equal(clientCouponError(''), null);
  assert.equal(clientCouponError('  '), null);
  assert.equal(clientCouponError('!!'), 'Cupom inválido.');
  assert.equal(clientCouponError('ok'), 'Cupom inválido.');
  assert.equal(clientCouponError('NEXUS10'), null);
});
