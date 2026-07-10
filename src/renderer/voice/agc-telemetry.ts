/**
 * Pure per-frame measurements for diagnosing the wake microphone AGC.
 *
 * `SoftAgc.process()` mutates its input, so callers that need this diagnostic
 * must preserve the raw frame before processing it. `appliedGain` is the
 * effective RMS gain at the output: it equals the scalar AGC gain until output
 * clipping begins, then intentionally reflects the compressed signal heard by
 * the wake detector.
 */
export interface AgcFrameTelemetry {
  rawRms: number;
  processedRms: number;
  appliedGain: number;
  clippedSampleRatio: number;
}

export function measureAgcFrame(
  rawFrame: Float32Array,
  processedFrame: Float32Array,
): AgcFrameTelemetry {
  if (rawFrame.length !== processedFrame.length) {
    throw new RangeError('AGC telemetry requires raw and processed frames with equal lengths');
  }

  let rawSquaredSum = 0;
  let processedSquaredSum = 0;
  let clippedSamples = 0;

  for (let index = 0; index < rawFrame.length; index += 1) {
    const raw = rawFrame[index];
    const processed = processedFrame[index];
    rawSquaredSum += raw * raw;
    processedSquaredSum += processed * processed;
    if (Math.abs(processed) >= 1) clippedSamples += 1;
  }

  const frameLength = rawFrame.length;
  const rawRms = Math.sqrt(rawSquaredSum / Math.max(1, frameLength));
  const processedRms = Math.sqrt(processedSquaredSum / Math.max(1, frameLength));

  return {
    rawRms,
    processedRms,
    appliedGain: rawRms > 0 ? processedRms / rawRms : 0,
    clippedSampleRatio: frameLength > 0 ? clippedSamples / frameLength : 0,
  };
}
