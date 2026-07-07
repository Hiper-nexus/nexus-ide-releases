/**
 * Saúde do microfone do wake (PURO, sem deps de áudio — testável no vitest).
 *
 * A JARVIS pode ficar "surda" de dois jeitos, cada um com correção diferente:
 *  1. sem permissão de mic (macOS entrega áudio mudo, sem erro) → pedir/open ajustes
 *  2. com permissão, mas dispositivo mudo/morto (ex.: fifine no mute físico) → open som
 * Esta classificação decide qual banner mostrar.
 */

export type MicHealth = 'ok' | 'needsPermission' | 'silent';

/** Estado de permissão; 'unknown' = ainda não consultou (não alarmar). */
export type MicPermissionState = 'granted' | 'denied' | 'prompt' | 'unknown';

/** RMS abaixo disso = silêncio/ruído de fundo (mesmo piso do voice-level). */
export const MIC_NOISE_FLOOR = 0.006;

/** Um frame conta como silêncio se o RMS estiver abaixo do piso de ruído. */
export function frameIsSilent(rms: number, noiseFloor: number = MIC_NOISE_FLOOR): boolean {
  if (!Number.isFinite(rms)) return true;
  return rms < noiseFloor;
}

/**
 * Classifica a saúde do mic a partir da permissão e de quanto tempo em
 * silêncio contínuo.
 * - denied/prompt → needsPermission (macOS: popup se prompt, ajustes se denied)
 * - granted + silêncio além do limiar → silent (dispositivo mudo/morto)
 * - caso contrário (incl. unknown) → ok
 */
export function classifyMicHealth(
  permission: MicPermissionState,
  silentMs: number,
  silentThresholdMs: number,
): MicHealth {
  if (permission === 'denied' || permission === 'prompt') return 'needsPermission';
  if (permission === 'granted' && silentMs >= silentThresholdMs) return 'silent';
  return 'ok';
}
