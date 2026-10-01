import test from 'node:test';
import assert from 'node:assert/strict';
import { JOYSTICK_RADIUS, joystickInput } from './touch.js';

test('a finger pushed forward accelerates and pushed sideways steers, with a dead zone in the middle', () => {
  assert.deepEqual(joystickInput(0, 0), { throttle: 0, steer: 0 });
  assert.deepEqual(joystickInput(3, -2), { throttle: 0, steer: 0 }, 'small wobble is ignored');
  const forward = joystickInput(0, -JOYSTICK_RADIUS);
  assert.equal(forward.throttle, 1);
  assert.equal(forward.steer, 0);
  const left = joystickInput(-JOYSTICK_RADIUS, 0);
  assert.equal(left.steer, 1, 'left on screen is a left turn, matching the A key');
  const back = joystickInput(0, JOYSTICK_RADIUS / 2);
  assert.ok(back.throttle < 0 && back.throttle > -1);
});

test('the input is clamped when the finger leaves the ring', () => {
  const far = joystickInput(JOYSTICK_RADIUS * 4, -JOYSTICK_RADIUS * 4);
  assert.ok(Math.hypot(far.throttle, far.steer) <= 1.0001);
  assert.ok(far.throttle > 0 && far.steer < 0);
});
