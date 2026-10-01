/** Como o dev anda: intenção do jogador → direção no mundo → velocidade suave.
 * Puro. As funções do loop escrevem num objeto de saída para não alocar por quadro. */
export const WALK = {
  speed: 3.4,
  carryScale: 0.82,
  accel: 12,
  turn: 14,
  radius: 0.3,
};

/** Teclado e joystick viram uma intenção {x: direita, y: frente} com módulo até 1. */
export function intentFrom(keys, analog = null, out = { x: 0, y: 0 }) {
  let x = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  let y = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
  if (x === 0 && y === 0 && analog) { x = analog.x; y = analog.y; }
  const length = Math.hypot(x, y);
  if (length > 1) { x /= length; y /= length; }
  out.x = x || 0;
  out.y = y || 0;
  return out;
}

/** A câmera fica ao sul do dev quando yaw = 0: frente na tela é -z, direita é +x. */
export function worldDirection(intent, yaw, out = { x: 0, z: 0 }) {
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  out.x = intent.x * cos - intent.y * sin;
  out.z = -intent.x * sin - intent.y * cos;
  return out;
}

/** Menor diferença entre dois ângulos, em (-π, π]. */
export function angleDelta(from, to) {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta <= -Math.PI) delta += Math.PI * 2;
  return delta;
}

/** Um passo do corpo. `body` tem vx, vz e heading; devolve em `out` a nova velocidade,
 * o heading e o deslocamento pedido (a colisão decide quanto dele acontece). */
export function walkStep(body, direction, dt, scale = 1, out = {}) {
  const step = Math.max(0, Math.min(dt, 0.05));
  const target = WALK.speed * scale;
  const blend = Math.min(1, WALK.accel * step);
  const vx = body.vx + (direction.x * target - body.vx) * blend;
  const vz = body.vz + (direction.z * target - body.vz) * blend;
  const speed = Math.hypot(vx, vz);
  let heading = body.heading;
  // O modelo olha para +z com rotação zero, então o heading de (vx, vz) é atan2(vx, vz).
  if (speed > 0.15) heading += angleDelta(heading, Math.atan2(vx, vz)) * Math.min(1, WALK.turn * step);
  out.vx = speed < 0.01 ? 0 : vx;
  out.vz = speed < 0.01 ? 0 : vz;
  out.speed = speed < 0.01 ? 0 : speed;
  out.heading = heading;
  out.dx = out.vx * step;
  out.dz = out.vz * step;
  return out;
}
