/** Turno cronometrado: os pontos são o XP ganho enquanto o relógio corre.
 * Puro e imutável; o recorde fica no progresso salvo. */
export const SHIFT_SECONDS = 180;

export function createShift() {
  return { left: SHIFT_SECONDS, score: 0, over: false };
}

export function shiftStep(shift, dt) {
  if (shift.over) return shift;
  const left = Math.max(0, shift.left - dt);
  return { ...shift, left, over: left === 0 };
}

export function shiftScore(shift, points) {
  return shift.over ? shift : { ...shift, score: shift.score + Math.max(0, points) };
}

export function formatClock(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
