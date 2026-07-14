/**
 * Mission glance — tempo decorrido em linguagem humana para o rail
 * ("há 45 s", "há 12 min", "há 1 h 05"). Pure domain, `now` injetado.
 * Rótulos de estado vivem em mission-rail-groups (railStatusDisplay).
 */

/** "há 45 s" / "há 12 min" / "há 1 h 05". Vazio para âncora ausente/futura. */
export function humanElapsed(anchorMs: number | null, now: number): string {
  if (!anchorMs || anchorMs > now) return '';
  const totalSec = Math.floor((now - anchorMs) / 1_000);
  if (totalSec < 60) return `há ${Math.max(totalSec, 1)} s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `há ${totalMin} min`;
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return minutes > 0
    ? `há ${hours} h ${String(minutes).padStart(2, '0')}`
    : `há ${hours} h`;
}
