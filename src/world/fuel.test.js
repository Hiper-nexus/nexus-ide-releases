import test from 'node:test';
import assert from 'node:assert/strict';
import { FUEL, initialFuel, fuelStep, fuelPower, refuel } from './fuel.js';

test('the tank starts full and drains while the engine is running', () => {
  const start = initialFuel();
  assert.equal(start.level, FUEL.max);
  const after = fuelStep(start, {}, 1);
  assert.ok(after.level < FUEL.max && after.level > FUEL.max - FUEL.drainIdle * 1.2);
});

test('driving and boosting drain the tank faster than idling', () => {
  const base = initialFuel();
  const idle = fuelStep(base, {}, 1).level;
  const drive = fuelStep(base, { driving: true }, 1).level;
  const boost = fuelStep(base, { driving: true, boosting: true }, 1).level;
  assert.ok(drive < idle, 'driving burns more than idling');
  assert.ok(boost < drive, 'boost burns more than driving alone');
});

test('parked at the cafe the tank refills and the sleepy flag lifts', () => {
  const dry = { level: 0.1, refueling: false, sleepy: FUEL.sleepyFade };
  const step = fuelStep(dry, { nearStation: true }, 0.5);
  assert.ok(step.level > dry.level);
  assert.equal(step.refueling, true);
  assert.ok(step.sleepy < dry.sleepy);
  const full = fuelStep({ level: 0.99, refueling: true, sleepy: 0 }, { nearStation: true }, 1);
  assert.equal(full.level, FUEL.max);
  assert.equal(full.refueling, false);
});

test('an empty tank keeps the rover sleepy but never negative', () => {
  const empty = fuelStep({ level: 0.01, refueling: false, sleepy: 0 }, { driving: true, boosting: true }, 1);
  assert.equal(empty.level, 0);
  assert.equal(empty.sleepy, FUEL.sleepyFade);
  const still = fuelStep(empty, { driving: true }, 10);
  assert.equal(still.level, 0);
  assert.equal(still.sleepy, FUEL.sleepyFade);
});

test('fuelPower fades acceleration and top speed out as the tank empties, never steering', () => {
  const full = fuelPower(initialFuel());
  assert.equal(full.accelScale, 1);
  assert.equal(full.maxScale, 1);
  assert.equal(full.sleepy, false);
  const dry = fuelPower({ level: 0, refueling: false, sleepy: FUEL.sleepyFade });
  assert.equal(dry.accelScale, FUEL.emptyAccel);
  assert.equal(dry.maxScale, FUEL.emptyMax);
  assert.equal(dry.sleepy, true);
  assert.equal(dry.empty, true);
  // Mid-tank sits between the extremes; the shape is monotonic.
  const mid = fuelPower({ level: 0.175, refueling: false, sleepy: 0 });
  assert.ok(mid.accelScale > dry.accelScale && mid.accelScale < full.accelScale);
  assert.ok(mid.low);
});

test('drinking a cup refills a slice of the tank and caps at full', () => {
  const sips = refuel({ level: 0.5, refueling: false, sleepy: 1 }, FUEL.pickup);
  assert.ok(Math.abs(sips.level - (0.5 + FUEL.pickup)) < 1e-9);
  const over = refuel({ level: 0.95, refueling: false, sleepy: 0 }, FUEL.pickup);
  assert.equal(over.level, FUEL.max);
});

test('a full tank, never driven, still drains only the idle drip per second', () => {
  let fuel = initialFuel();
  // Ten honest 0.1s frames make one second; a longer hitch would be clamped, not counted twice.
  for (let i = 0; i < 10; i++) fuel = fuelStep(fuel, {}, 0.1);
  assert.ok(Math.abs(fuel.level - (FUEL.max - 1 * FUEL.drainIdle)) < 1e-6);
});

test('delta is clamped so a long hitch cannot gulp the whole tank', () => {
  const after = fuelStep(initialFuel(), { driving: true, boosting: true }, 30);
  assert.ok(after.level > FUEL.max - 0.2, 'a 30s hitch burns at most one clamped step');
});
