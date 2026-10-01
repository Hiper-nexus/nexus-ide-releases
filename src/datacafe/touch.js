/** One-finger joystick: the finger's offset from where it landed becomes
 * throttle (up is forward) and steer (left is a left turn, like the A key). */
export const JOYSTICK_RADIUS = 56;
const DEAD_ZONE = 0.12;

export function joystickInput(dx, dy, radius = JOYSTICK_RADIUS) {
  let throttle = -dy / radius, steer = -dx / radius;
  const magnitude = Math.hypot(throttle, steer);
  if (magnitude < DEAD_ZONE) return { throttle: 0, steer: 0 };
  if (magnitude > 1) { throttle /= magnitude; steer /= magnitude; }
  const round = value => Math.round(value * 1000) / 1000 || 0;
  return { throttle: round(throttle), steer: round(steer) };
}
