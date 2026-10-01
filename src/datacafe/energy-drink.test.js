import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRINK, createDrinks, drinkAdvance, drinkCan, drinkReason, drinkWait, turboLeft, turboLevel, turboEnding, turboEffects, NO_TURBO,
} from './energy-drink.js';

test('o freezer começa com 8 latas, sem turbo e sem lata bebida', () => {
  const state = createDrinks();
  assert.equal(state.stock, DRINK.stockStart);
  assert.equal(DRINK.stockStart, 8);
  assert.equal(DRINK.stockMax, 12);
  assert.equal(turboLeft(state, 0), 0);
  assert.equal(drinkReason(state, 0), 'ready');
});

test('beber tira uma lata, liga o turbo de 20 s e põe a lata seguinte para gelar 30 s', () => {
  const first = drinkCan(createDrinks(100), 100);
  assert.equal(first.ok, true);
  assert.equal(first.state.stock, 7);
  assert.equal(turboLeft(first.state, 100), 20);
  assert.equal(turboLeft(first.state, 112.5), 7.5);
  assert.equal(turboLeft(first.state, 125), 0);

  const early = drinkCan(first.state, 110);
  assert.equal(early.ok, false);
  assert.equal(early.reason, 'cooling');
  assert.equal(early.waitSeconds, 20);
  assert.equal(early.state.stock, 7, 'recusar não gasta lata');

  const later = drinkCan(first.state, 130);
  assert.equal(later.ok, true);
});

test('freezer vazio explica quanto falta para repor a próxima lata', () => {
  const empty = { ...createDrinks(0), stock: 0 };
  const result = drinkCan(empty, 4);
  assert.deepEqual([result.ok, result.reason, result.waitSeconds], [false, 'empty', 11]);
  assert.equal(drinkReason(empty, 4), 'empty');
  assert.equal(drinkWait(empty, 4), 11);
});

test('repõe uma lata a cada 15 s até o máximo de 12, inclusive depois de um salto grande de tempo', () => {
  const state = createDrinks(0);
  assert.equal(drinkAdvance(state, 14.9).stock, 8);
  assert.equal(drinkAdvance(state, 15).stock, 9);
  assert.equal(drinkAdvance(state, 45).stock, 11);
  assert.equal(drinkAdvance(state, 60).stock, 12);
  const full = drinkAdvance(state, 100000);
  assert.equal(full.stock, DRINK.stockMax);
  assert.equal(drinkAdvance(full, 200000), full, 'cheio e sem mudança devolve o mesmo estado');
});

test('o relógio da reposição recomeça quando a primeira lata sai de um freezer cheio', () => {
  const full = drinkAdvance(createDrinks(0), 1000);
  const taken = drinkCan(full, 1000);
  assert.equal(taken.state.stock, 11);
  assert.equal(drinkAdvance(taken.state, 1014).stock, 11);
  assert.equal(drinkAdvance(taken.state, 1015).stock, 12);
});

test('o estado é imutável: nenhuma função altera o que recebeu', () => {
  const frozen = Object.freeze(createDrinks(0));
  assert.doesNotThrow(() => { drinkCan(frozen, 50); drinkAdvance(frozen, 500); turboLeft(frozen, 5); drinkReason(frozen, 5); });
  assert.equal(frozen.stock, 8);
});

test('tempo que volta, NaN e infinito nunca quebram o estado', () => {
  const taken = drinkCan(createDrinks(), 100).state;
  assert.equal(drinkAdvance(taken, 50), taken, 'relógio para trás não repõe nada');
  assert.ok(turboLeft(taken, 90) <= DRINK.turbo, 'o turbo nunca passa de 20 s, nem com o relógio para trás');
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '5']) {
    assert.equal(turboLeft(taken, bad), 0);
    assert.equal(drinkAdvance(taken, bad), taken);
    const result = drinkCan(taken, bad);
    assert.equal(result.ok, false);
    assert.equal(result.state, taken);
    assert.ok(Number.isFinite(result.waitSeconds));
    assert.ok(Number.isFinite(drinkWait(taken, bad)));
  }
});

test('turbo: velocidade ×1,4 e janela do combo ×1,5 só enquanto dura, com constantes que nunca alocam', () => {
  const taken = drinkCan(createDrinks(), 10).state;
  const on = turboEffects(taken, 15);
  assert.deepEqual([on.speed, on.comboScale], [1.4, 1.5]);
  assert.equal(turboEffects(taken, 15), on, 'mesmo objeto a cada chamada');
  assert.equal(turboEffects(taken, 31), NO_TURBO);
  assert.deepEqual([NO_TURBO.speed, NO_TURBO.comboScale], [1, 1]);
  assert.throws(() => { NO_TURBO.speed = 9; }, TypeError);
});

test('o medidor do HUD vai de 1 a 0 e o aviso de fim vale nos últimos 3 s', () => {
  const taken = drinkCan(createDrinks(), 0).state;
  assert.equal(turboLevel(taken, 0), 1);
  assert.equal(turboLevel(taken, 10), 0.5);
  assert.equal(turboLevel(taken, 20), 0);
  assert.equal(turboEnding(taken, 16.9), false);
  assert.equal(turboEnding(taken, 17), true);
  assert.equal(turboEnding(taken, 19.99), true);
  assert.equal(turboEnding(taken, 20), false, 'acabou: não avisa mais');
});

test('beber enquanto gela ou com o freezer vazio nunca prolonga o turbo', () => {
  const first = drinkCan(createDrinks(), 0).state;
  const second = drinkCan(first, 5);
  assert.equal(second.ok, false);
  assert.equal(turboLeft(second.state, 5), 15);
});
