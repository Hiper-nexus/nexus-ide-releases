/**
 * Voice pipeline IPC channel names. Dependency-free (no zod / node) so both the
 * sandboxed preload and the main process can import it.
 */

export const VOICE_CHANNELS = {
  /** invoke: renderer → main. Returns the secret-free VoiceRuntimeInfo. */
  getInfo: 'voice:getInfo',
  /** invoke: renderer → main. Persist a partial config patch, returns fresh info. */
  setConfig: 'voice:setConfig',
  /** invoke: renderer → main. Store/clear one voice API key in secure storage. */
  setKey: 'voice:setKey',
  /** invoke: renderer → main. Audio buffer → transcribed English text. */
  transcribe: 'voice:transcribe',
  /** invoke: renderer → main. Text → spoken (main plays `say`, or returns audio). */
  speak: 'voice:speak',
  /** send: renderer → main. Frames PCM 16 kHz para o detector de wake word. */
  wakeAudio: 'voice:wakeAudio',
  /** event: main → renderer. "Hey Jarvis" detectado pelo openWakeWord. */
  wakeDetected: 'voice:wake.detected',
  /** invoke: renderer → main. Fala transcrita → resposta JARVIS {say, action}. */
  jarvis: 'voice:jarvis',
  /** invoke: renderer → main. Confirmação nativa antes de rodar um comando de
   * voz (SEC#6 — anti prompt-injection voz→shell). Retorna boolean. */
  confirmCommand: 'voice:confirmCommand',

  /** invoke: renderer → main. Start/reuse the Jarvis Live session. */
  liveStart: 'voice:live.start',
  /** invoke: renderer → main. Stop the Jarvis Live session. */
  liveStop: 'voice:live.stop',
  /** invoke: renderer → main. End the current turn and keep the session dormant. */
  liveEndTurn: 'voice:live.endTurn',
  /** invoke: renderer → main. Update the live phase (listening/thinking/...). */
  liveStatus: 'voice:live.status',
  /** send: renderer → main. Report a transcript line into the live session. */
  liveTranscriptIn: 'voice:live.transcript.in',
  /** send: renderer → main. Report the result of a live tool/action. */
  liveToolResultIn: 'voice:live.tool.result.in',
  /** invoke: renderer → main. Mark barge-in/interruption for the live session. */
  liveInterrupt: 'voice:live.interrupt',

  /** event: main → renderer. Global push-to-talk key pressed. */
  pttStart: 'voice:ptt.start',
  /** event: main → renderer. Toggle-mode press — renderer decide start/stop. */
  pttToggle: 'voice:ptt.toggle',
  /** event: main → renderer. Push-to-talk key released (hold mode only). */
  pttStop: 'voice:ptt.stop',
  /** event: main → renderer. Runtime info changed (config reload / hot-reload). */
  infoChanged: 'voice:info.changed',
  /** event: main → renderer. Narração proativa da JARVIS (handoff chegou,
   * worker travou) — o renderer fala o texto se não houver turno de voz ativo. */
  narrate: 'voice:narrate',
  /** event: main → renderer. Jarvis Live state changed. */
  liveState: 'voice:live.state',
  /** event: main → renderer. Final/partial Jarvis Live transcript. */
  liveTranscript: 'voice:live.transcript',
  /** event: main → renderer. Jarvis Live is about to execute a tool/action. */
  liveToolCall: 'voice:live.tool.call',
  /** event: main → renderer. Jarvis Live tool/action finished. */
  liveToolResult: 'voice:live.tool.result',
  /** event: main → renderer. Jarvis Live speech was interrupted. */
  liveInterrupted: 'voice:live.interrupted',
} as const;
