/**
 * Map limit-detector hits + cooldowns onto quota windows (no invented %).
 */

import type { LimitHit } from '../orch/limit-detector';
import type { QuotaWindow } from '../../shared/quota-types';
import { exhaustedWindow, mergeWindows, unknownWindow } from './quota-normalize';

/**
 * Map a limit hit onto exhausted windows. `hitAt` is when the hit was recorded
 * so `resetsAt = hitAt + cooldownMs` stays stable across rebuilds (not
 * `now + cooldownMs`, which would keep remaining forever full).
 */
export function windowsFromLimitHit(
  hit: LimitHit,
  adapterId: string,
  now = Date.now(),
  hitAt = now,
): QuotaWindow[] {
  const resetsAt = hitAt + hit.cooldownMs;
  // Expired: caller should have filtered, but stay honest if not.
  if (now >= resetsAt) {
    return [];
  }
  if (hit.kind === 'quota') {
    return [
      exhaustedWindow({
        kind: 'weekly',
        label: 'Semanal',
        resetsAt,
        source: 'limit-hit',
        now,
      }),
    ];
  }
  if (hit.kind === 'rate-limit') {
    // Majority of cloud LLMs share a rolling ~5h window (Codex, Claude, GLM…).
    // Long cooldowns (≥4h) and short rate-limits both paint the 5h bar.
    return [
      exhaustedWindow({
        kind: 'hours',
        label: '5 Horas',
        resetsAt,
        source: 'limit-hit',
        now,
      }),
    ];
  }
  // auth — not a usage window; leave unknown shell (same fleet slots)
  return [
    unknownWindow('hours', '5 Horas'),
    unknownWindow('weekly', 'Semanal'),
  ];
}

export function applyLimitHitToWindows(
  current: readonly QuotaWindow[],
  hit: LimitHit,
  adapterId: string,
  now = Date.now(),
  hitAt = now,
): QuotaWindow[] {
  if (now >= hitAt + hit.cooldownMs) {
    return [...current];
  }
  return mergeWindows(current, windowsFromLimitHit(hit, adapterId, now, hitAt));
}

export function windowsFromCooldown(
  cooldownUntil: number,
  adapterId: string,
  now = Date.now(),
): QuotaWindow[] {
  if (cooldownUntil <= now) {
    return [];
  }
  // Fleet-wide: cooldown paints the shared 5h window (not session).
  return [
    exhaustedWindow({
      kind: 'hours',
      label: '5 Horas',
      resetsAt: cooldownUntil,
      source: 'cooldown',
      now,
    }),
  ];
}
