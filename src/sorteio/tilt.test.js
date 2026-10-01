import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tiltFor, TILT } from './tilt.js';

const rect = { left: 100, top: 200, width: 400, height: 300 };

test('no centro do bilhete ele fica reto e o brilho fica no meio', () => {
  const t = tiltFor(rect, 300, 350);
  assert.equal(t.rx, 0);
  assert.equal(t.ry, 0);
  assert.equal(t.mx, 50);
  assert.equal(t.my, 50);
});

test('o bilhete se inclina na direção do ponteiro, como se a ponta cedesse', () => {
  const right = tiltFor(rect, 500, 350);
  assert.equal(right.ry, TILT.max);
  const bottom = tiltFor(rect, 300, 500);
  assert.equal(bottom.rx, -TILT.max);
  const left = tiltFor(rect, 100, 350);
  assert.equal(left.ry, -TILT.max);
  const top = tiltFor(rect, 300, 200);
  assert.equal(top.rx, TILT.max);
});

test('o brilho acompanha o ponteiro em porcentagem do bilhete', () => {
  const t = tiltFor(rect, 150, 215);
  assert.equal(t.mx, 12.5);
  assert.equal(t.my, 5);
});

test('ponteiro fora do bilhete não passa do limite nem do bilhete', () => {
  const t = tiltFor(rect, 9999, -9999);
  assert.equal(t.ry, TILT.max);
  assert.equal(t.rx, TILT.max);
  assert.equal(t.mx, 100);
  assert.equal(t.my, 0);
});

test('bilhete sem tamanho não gera NaN', () => {
  const t = tiltFor({ left: 0, top: 0, width: 0, height: 0 }, 10, 10);
  for (const value of Object.values(t)) assert.ok(Number.isFinite(value));
});
