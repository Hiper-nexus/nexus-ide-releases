import test from 'node:test';
import assert from 'node:assert/strict';
import { COMBO, createCombo, comboHit, comboStep, comboMultiplier, comboLevel } from './combo.js';

test('entregas dentro da janela somam a sequência e o multiplicador sobe até o teto', () => {
  let combo = createCombo();
  assert.equal(comboMultiplier(combo), 1);
  combo = comboHit(combo);
  assert.equal(combo.streak, 1);
  assert.equal(comboMultiplier(combo), 1, 'a primeira entrega ainda não multiplica');
  combo = comboHit(comboStep(combo, COMBO.window - 1));
  assert.equal(combo.streak, 2);
  assert.equal(comboMultiplier(combo), 1 + COMBO.step);
  for (let i = 0; i < 20; i++) combo = comboHit(combo);
  assert.equal(comboMultiplier(combo), COMBO.max);
});

test('passou a janela, a sequência zera e a próxima entrega recomeça em 1', () => {
  let combo = comboHit(comboHit(createCombo()));
  combo = comboStep(combo, COMBO.window + 0.1);
  assert.deepEqual(combo, createCombo());
  assert.equal(comboHit(combo).streak, 1);
});

test('o medidor vai de 1 a 0 dentro da janela e parado não aloca', () => {
  const idle = createCombo();
  assert.equal(comboStep(idle, 1), idle, 'sem sequência devolve o mesmo objeto');
  const combo = comboHit(idle);
  assert.equal(comboLevel(combo), 1);
  assert.equal(comboLevel(comboStep(combo, COMBO.window / 2)), 0.5);
  assert.equal(comboLevel(idle), 0);
});

test('com o turbo a janela da sequência cresce 1,5 vez, e o medidor do HUD nunca passa de 1', () => {
  const boosted = comboHit(createCombo(), 1.5);
  assert.equal(boosted.left, COMBO.window * 1.5);
  assert.equal(boosted.streak, 1);
  assert.equal(comboLevel(boosted), 1, 'cheio até a janela normal acabar');
  assert.equal(comboLevel(comboStep(boosted, COMBO.window * 1.25)), 0.25);
  const next = comboHit(boosted, 1.5);
  assert.equal(next.streak, 2);
  assert.equal(next.left, COMBO.window * 1.5);
});

test('sem escala o combo é exatamente o de antes, e escala inválida vale 1', () => {
  assert.deepEqual(comboHit(createCombo()), { streak: 1, left: COMBO.window });
  for (const bad of [0, -2, NaN, Infinity, undefined, null, 'x']) assert.equal(comboHit(createCombo(), bad).left, COMBO.window, String(bad));
});
