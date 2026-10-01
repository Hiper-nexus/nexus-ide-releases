import test from 'node:test';
import assert from 'node:assert/strict';
import { WALK, intentFrom, worldDirection, walkStep, angleDelta } from './walk.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('teclado vence o joystick e a diagonal não anda mais rápido', () => {
  const diagonal = intentFrom({ up: true, right: true });
  close(Math.hypot(diagonal.x, diagonal.y), 1);
  assert.deepEqual(intentFrom({}, { x: 0.5, y: 0 }), { x: 0.5, y: 0 });
  assert.deepEqual(intentFrom({ down: true }, { x: 1, y: 1 }), { x: 0, y: -1 });
  assert.deepEqual(intentFrom({}), { x: 0, y: 0 });
});

test('com a câmera ao sul, frente é -z e direita é +x', () => {
  const forward = worldDirection({ x: 0, y: 1 }, 0);
  close(forward.x, 0); close(forward.z, -1);
  const right = worldDirection({ x: 1, y: 0 }, 0);
  close(right.x, 1); close(right.z, 0);
  const turned = worldDirection({ x: 0, y: 1 }, Math.PI / 2);
  close(turned.x, -1); close(turned.z, 0);
});

test('o dev acelera até a velocidade de caminhada e vira para onde anda', () => {
  let body = { vx: 0, vz: 0, heading: 0 };
  for (let i = 0; i < 60; i++) body = walkStep(body, { x: 1, z: 0 }, 1 / 60);
  close(body.speed, WALK.speed, 0.01);
  close(body.heading, Math.PI / 2, 0.01);
  close(body.dx, WALK.speed / 60, 0.001);
  let tired = { vx: 0, vz: 0, heading: 0 };
  for (let i = 0; i < 60; i++) tired = walkStep(tired, { x: 1, z: 0 }, 1 / 60, 0.5);
  close(tired.speed, WALK.speed * 0.5, 0.01);
});

test('soltar os controles para o dev sem girar o corpo', () => {
  let body = { vx: 3, vz: 0, heading: 1 };
  for (let i = 0; i < 120; i++) body = walkStep(body, { x: 0, z: 0 }, 1 / 60);
  assert.equal(body.speed, 0);
  assert.ok(Math.abs(body.heading - Math.PI / 2) < 0.5);
});

test('angleDelta escolhe o caminho mais curto', () => {
  close(angleDelta(Math.PI - 0.1, -Math.PI + 0.1), 0.2);
  close(angleDelta(0, Math.PI / 2), Math.PI / 2);
});
