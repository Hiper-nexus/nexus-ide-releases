/**
 * Voice pipeline IPC channel names. Dependency-free (no zod / node) so both the
 * sandboxed preload and the main process can import it.
 */

export const VOICE_CHANNELS = {
  /** invoke: renderer → main. Returns the secret-free VoiceRuntimeInfo. */
  getInfo: 'voice:getInfo',
  /** invoke: renderer → main. Persist a partial config patch, returns fresh info. */
  setConfig: 'voice:setConfig',
  /** invoke: renderer → main. Audio buffer → transcribed English text. */
  transcribe: 'voice:transcribe',
  /** invoke: renderer → main. Text → spoken (main plays `say`, or returns audio). */
  speak: 'voice:speak',

  /** event: main → renderer. Global push-to-talk key pressed. */
  pttStart: 'voice:ptt.start',
  /** event: main → renderer. Push-to-talk key released (hold mode only). */
  pttStop: 'voice:ptt.stop',
  /** event: main → renderer. Runtime info changed (config reload / hot-reload). */
  infoChanged: 'voice:info.changed',
} as const;
