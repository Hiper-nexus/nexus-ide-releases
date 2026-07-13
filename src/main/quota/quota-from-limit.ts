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
    // 5h pattern is common for Codex; Claude often session-like.
    if (adapterId === 'codex' || hit.cooldownMs >= 4 * 60 * 60 * 1000) {
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
    return [
      exhaustedWindow({
        kind: 'session',
        label: 'Sessão',
        resetsAt,
        source: 'limit-hit',
        now,
      }),
    ];
  }
  // auth — not a usage window; leave unknown shell
  return [
    unknownWindow('session', 'Sessão'),
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
  const kind =
    adapterId === 'codex'
      ? ('hours' as const)
      : ('session' as const);
  const label = kind === 'hours' ? '5 Horas' : 'Sessão';
  return [
    exhaustedWindow({
      kind,
      label,
      resetsAt: cooldownUntil,
      source: 'cooldown',
      now,
    }),
  ];
}
