import test from 'node:test';
import assert from 'node:assert/strict';
import { SHIFT_SECONDS, createShift, shiftStep, shiftScore, formatClock } from './shift.js';

test('o turno conta para baixo, pontua enquanto corre e fecha em zero', () => {
  let shift = createShift();
  assert.equal(shift.left, SHIFT_SECONDS);
  shift = shiftScore(shiftStep(shift, 10), 60);
  assert.equal(shift.left, SHIFT_SECONDS - 10);
  assert.equal(shift.score, 60);
  shift = shiftStep(shift, SHIFT_SECONDS);
  assert.equal(shift.left, 0);
  assert.equal(shift.over, true);
  assert.equal(shiftScore(shift, 100).score, 60, 'turno encerrado não pontua');
  assert.equal(shiftStep(shift, 1), shift, 'turno encerrado não anda');
});

test('relógio do HUD em minutos e segundos', () => {
  assert.equal(formatClock(180), '3:00');
  assert.equal(formatClock(61.2), '1:02');
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(-3), '0:00');
});
