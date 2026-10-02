import test from 'node:test';
import assert from 'node:assert/strict';
import { ENERGY, createEnergy, energyStep, drink, refill, isTired, speedScale, energyLevel } from './energy.js';

test('andar cansa mais que ficar parado, e carregar cansa mais ainda', () => {
  const start = createEnergy();
  const idle = energyStep(start, 0.1, {});
  const walk = energyStep(start, 0.1, { moving: true });
  const carry = energyStep(start, 0.1, { moving: true, carrying: true });
  assert.ok(idle.value > walk.value && walk.value > carry.value);
  assert.equal(start.value, 1, 'o estado original não muda');
});

test('o dev cansa em 0.2 e só desperta acima de 0.35', () => {
  let energy = { value: 0.21, tired: false };
  while (!isTired(energy)) energy = energyStep(energy, 0.1, { moving: true });
  assert.ok(energy.value <= ENERGY.tiredAt);
  assert.equal(speedScale(energy), ENERGY.tiredSpeed);
  const almost = { value: 0.3, tired: true };
  assert.equal(energyStep(almost, 0.01, {}).tired, true, 'ainda na histerese');
  assert.equal(isTired(drink(almost)), false);
});

test('um café passa do máximo e o excedente se dissipa antes da queda normal', () => {
  const full = drink({ value: 0.1, tired: true });
  assert.equal(full.value, ENERGY.drink);
  assert.equal(energyLevel(full), 1);
  let energy = full;
  for (let i = 0; i < 18; i++) energy = energyStep(energy, 0.1, { moving: true });
  assert.ok(energy.value > ENERGY.max, 'ainda dissipando o excedente, sem queda');
  for (let i = 0; i < 7; i++) energy = energyStep(energy, 0.1, { moving: true });
  assert.ok(energy.value <= ENERGY.max && energy.value > ENERGY.max - 0.02, 'só depois volta a cair');
});

test('propriedade: a energia fica sempre entre 0 e o teto', () => {
  let seed = 7;
  const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let energy = createEnergy();
  for (let i = 0; i < 5000; i++) {
    energy = rng() < 0.01 ? drink(energy) : energyStep(energy, rng() * 0.3, { moving: rng() < 0.7, carrying: rng() < 0.4 });
    assert.ok(energy.value >= 0 && energy.value <= ENERGY.overflow);
  }
});

test('um passo sem mudança devolve o mesmo objeto', () => {
  const empty = { value: 0, tired: true };
  assert.equal(energyStep(empty, 0.1, { moving: true }), empty);
});

test('o energético enche a energia até o máximo, desperta o dev e não passa do pico do café', () => {
  const tired = { value: 0.1, tired: true };
  const full = refill(tired);
  assert.deepEqual(full, { value: ENERGY.max, tired: false });
  assert.deepEqual(tired, { value: 0.1, tired: true }, 'o estado original não muda');
  const peak = { value: ENERGY.overflow, tired: false };
  assert.equal(refill(peak).value, ENERGY.overflow, 'quem já está no pico do café não perde o excedente');
  assert.ok(refill(tired).value <= drink(tired).value);
});
