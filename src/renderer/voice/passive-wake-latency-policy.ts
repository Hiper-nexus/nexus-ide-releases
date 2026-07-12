/**
 * Latency budget for the STT-backed wake path.
 *
 * This path is a safety net for the acoustic ONNX detector, so it must collect
 * enough speech to contain "Jarvis" without turning every wake into a multi-
 * second dictation. The trailing pre-roll is retained separately by WakeMic.
 */
export const PASSIVE_WAKE_LATENCY_POLICY = Object.freeze({
  // Commands such as "abrir ... novo workspace" commonly contain a short
  // planning pause after the verb. 520 ms clipped the real hardware sample to
  // just "Abrir."; 700 ms preserves that phrase while staying sub-second.
  silenceMs: 700,
  maxMs: 1_800,
  cooldownMs: 80,
  forceEmitMinPeakRms: 0.08,
});

export function passiveWakeWorstCaseCaptureMs(): number {
  return PASSIVE_WAKE_LATENCY_POLICY.maxMs + PASSIVE_WAKE_LATENCY_POLICY.silenceMs;
}
