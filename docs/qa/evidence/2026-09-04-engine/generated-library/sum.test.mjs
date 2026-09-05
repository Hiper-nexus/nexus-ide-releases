import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sum } from './sum.mjs';

test('soma números positivos', () => {
  assert.equal(sum(2, 3), 5);
  assert.equal(sum(0.1, 0.2), 0.30000000000000004);
});

test('soma números negativos', () => {
  assert.equal(sum(-5, -3), -8);
  assert.equal(sum(-2, 7), 5);
  assert.equal(sum(4, -9), -5);
});

test('rejeita NaN', () => {
  assert.throws(() => sum(NaN, 1), TypeError);
  assert.throws(() => sum(1, NaN), TypeError);
  assert.throws(() => sum(NaN, NaN), TypeError);
});

test('rejeita texto', () => {
  assert.throws(() => sum('1', 2), TypeError);
  assert.throws(() => sum(1, '2'), TypeError);
  assert.throws(() => sum('a', 'b'), TypeError);
});

test('rejeita números não-finitos (Infinity)', () => {
  assert.throws(() => sum(Infinity, 1), TypeError);
  assert.throws(() => sum(1, -Infinity), TypeError);
});

test('rejeita outros tipos não-numéricos', () => {
  assert.throws(() => sum(null, 1), TypeError);
  assert.throws(() => sum(undefined, 1), TypeError);
  assert.throws(() => sum([1], 2), TypeError);
  assert.throws(() => sum({}, 1), TypeError);
});
