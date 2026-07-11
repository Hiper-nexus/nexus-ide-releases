/**
 * Tiny indirection so voice-playback and voice-session-state can wire
 * wake suppression without circular import TDZ (bind at module load).
 */

export type WakeSuppressor = (ms: number) => void;

let current: WakeSuppressor | null = null;

export function bindWakeSuppressor(fn: WakeSuppressor): void {
  current = fn;
}

export function suppressWakeDetection(ms: number): void {
  current?.(ms);
}
