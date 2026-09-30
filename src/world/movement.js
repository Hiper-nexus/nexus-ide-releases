export const WORLD_LIMIT = 12;
export const PLAYER_SPEED = 5;
export const COFFEE_RADIUS = 0.9;

export function movePlayer(position, direction, delta) {
  const length = Math.hypot(direction.x, direction.z);
  if (!length) return { ...position };
  const distance = Math.min(delta, 0.1) * PLAYER_SPEED;
  const clamp = value => Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, value));
  return {
    x: clamp(position.x + direction.x / length * distance),
    z: clamp(position.z + direction.z / length * distance),
  };
}

export function collectNearby(position, items, collected) {
  return items
    .filter(item => !collected.has(item.id) && Math.hypot(position.x-item.x,position.z-item.z)<COFFEE_RADIUS)
    .map(item => item.id);
}
