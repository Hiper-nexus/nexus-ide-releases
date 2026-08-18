/**
 * Hang watchdog do main (campanha 0.50, C7; doutrina Orca hang-watchdog em
 * worker thread — PRs #11488/#11344): o main que pendura (familia real:
 * SecItemAdd síncrono com keychain trancado, timers mortos, IPC vivo) não
 * pode ser vigiado por ele mesmo. A worker thread mede o gap do heartbeat;
 * acima do limiar, marca evidência em disco — o diagnóstico "app congelou"
 * ganha duração e carimbo.
 */

export const HANG_WATCHDOG_HEARTBEAT_MS = 5_000;
export const HANG_WATCHDOG_THRESHOLD_MS = 30_000;

export function shouldMarkHang(input: {
  readonly lastHeartbeatAt: number | null;
  readonly now: number;
  readonly thresholdMs?: number;
}): boolean {
  if (input.lastHeartbeatAt === null) return false;
  const threshold = input.thresholdMs ?? HANG_WATCHDOG_THRESHOLD_MS;
  return input.now - input.lastHeartbeatAt > threshold;
}

export interface HangMarker {
  readonly kind: 'main-thread-hang';
  readonly hangDurationMs: number;
  readonly appVersion: string;
  readonly lastHeartbeatAt: number;
  readonly detectedAt: number;
}

export function buildHangMarker(input: {
  readonly hangDurationMs: number;
  readonly version: string;
  readonly lastHeartbeatAt: number;
  readonly detectedAt?: number;
}): HangMarker {
  return {
    kind: 'main-thread-hang',
    hangDurationMs: input.hangDurationMs,
    appVersion: input.version,
    lastHeartbeatAt: input.lastHeartbeatAt,
    detectedAt: input.detectedAt ?? Date.now(),
  };
}
