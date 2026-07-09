/**
 * Saúde do microfone do wake (PURO, sem deps de áudio — testável no vitest).
 *
 * A JARVIS pode ficar "surda" de três jeitos, cada um com correção diferente:
 *  1. sem permissão de mic (macOS entrega áudio mudo, sem erro) → pedir/open ajustes
 *  2. com permissão, mas dispositivo mudo/morto (ex.: fifine no mute físico) → open som
 *  3. grant TCC fantasma: macOS diz 'granted' mas entrega zeros digitais puros
 *     (rms === 0) após reinstalação/atualização → guided tccutil reset
 * Esta classificação decide qual banner mostrar.
 */

export type MicHealth = 'ok' | 'needsPermission' | 'silent' | 'phantomGrant';

/** Estado de permissão; 'unknown' = ainda não consultou (não alarmar). */
export type MicPermissionState = 'granted' | 'denied' | 'prompt' | 'unknown';

/** RMS abaixo disso = silêncio/ruído de fundo (mesmo piso do voice-level). */
export const MIC_NOISE_FLOOR = 0.006;

/** Um frame conta como silêncio se o RMS estiver abaixo do piso de ruído. */
export function frameIsSilent(rms: number, noiseFloor: number = MIC_NOISE_FLOOR): boolean {
  if (!Number.isFinite(rms)) return true;
  return rms < noiseFloor;
}

/** Zeros DIGITAIS puros (rms === 0) sustentados por isto = grant TCC fantasma:
 *  o macOS diz 'granted' mas entrega silêncio absoluto (WAKE-BROKEN-001).
 *  Sala quieta tem ruído de fundo pequeno mas > 0 — nunca zero exato. */
export const PHANTOM_ZERO_MS = 10_000;

/**
 * Classifica a saúde do mic a partir da permissão e de quanto tempo em
 * silêncio contínuo.
 * - denied/prompt → needsPermission (macOS: popup se prompt, ajustes se denied)
 * - granted + zeros digitais puros além do limiar → phantomGrant (TCC fantasma)
 * - granted + silêncio além do limiar → silent (dispositivo mudo/morto)
 * - caso contrário (incl. unknown) → ok
 */
export function classifyMicHealth(
  permission: MicPermissionState,
  silentMs: number,
  silentThresholdMs: number,
  zero?: { zeroMs: number; zeroThresholdMs?: number },
): MicHealth {
  if (permission === 'denied' || permission === 'prompt') return 'needsPermission';
  if (
    permission === 'granted' &&
    zero !== undefined &&
    zero.zeroMs >= (zero.zeroThresholdMs ?? PHANTOM_ZERO_MS)
  ) {
    return 'phantomGrant';
  }
  if (permission === 'granted' && silentMs >= silentThresholdMs) return 'silent';
  return 'ok';
}
