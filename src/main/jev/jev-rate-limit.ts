/**
 * Rate limit compartilhado das tools de julgamento (`nexus_judge`,
 * `nexus_rank`): janela deslizante de 30 chamadas/min por sessão (token do
 * agente quando não há sessão). Em memória — morre com o processo.
 */
const RATE_LIMIT_CALLS = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

const callsBySession = new Map<string, number[]>();

export function consumeJevRateSlot(key: string, now = Date.now()): boolean {
  return consumeJevRateSlots(key, 1, now);
}

/** Reserva `count` slots de uma vez — tudo ou nada (ex.: fan-out do rank). */
export function consumeJevRateSlots(
  key: string,
  count: number,
  now = Date.now(),
): boolean {
  const calls = (callsBySession.get(key) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS,
  );
  if (calls.length + count > RATE_LIMIT_CALLS) {
    callsBySession.set(key, calls);
    return false;
  }
  calls.push(...Array.from({ length: count }, () => now));
  callsBySession.set(key, calls);
  return true;
}

export function resetJevRateLimitsForTesting(): void {
  callsBySession.clear();
}
