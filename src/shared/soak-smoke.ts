import { z } from 'zod';

/** Acceptance only. No method on window.nexus; ordinary launches never emit these. */
export const SOAK_ENV = 'NEXUS_SMOKE_SOAK';
export const SOAK_FILE = 'soak-smoke.json';
export const SOAK_CHANNELS = { run: 'smoke:soak:run', cycle: 'smoke:soak:cycle', ack: 'smoke:soak:ack', failed: 'smoke:soak:failed', done: 'smoke:soak:done', stop: 'smoke:soak:stop', stopped: 'smoke:soak:stopped' } as const;
/** Diagnostic only: never accept terminal content or thrown error bodies. */
const soakFailureStage = z.enum(['workspace', 'read', 'search', 'open', 'write', 'marker', 'view',
  'metrics', 'ack', 'final', 'close', 'cancelled', 'unknown']);
export type SoakFailureStage = z.infer<typeof soakFailureStage>;
export function parseSoakFailureStage(raw: unknown): SoakFailureStage {
  const parsed = soakFailureStage.safeParse(raw);
  return parsed.success ? parsed.data : 'unknown';
}

export const SOAK_DOM_REQUEST = 'nexus:soak:request';
export const SOAK_DOM_REPLY = 'nexus:soak:reply';
export const SOAK_URL_MARKER = 'nexusSmokeSoak';
export function isSoakRendererUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'nexus-app:' && url.host === 'bundle' && url.pathname === '/index.html' && url.searchParams.get(SOAK_URL_MARKER) === '1'; }
  catch { return false; }
}
const MiB = 1024 * 1024;
/** Fixed before launch. Changing a limit requires a new source/app receipt. */
export const SOAK_POLICY = Object.freeze({
  version: 1, requiredDurationMs: 300000, timeoutMs: 420000, intervalMs: 5000,
  maxGapMs: 15000, minSamples: 40, maxSamples: 80, warmupMs: 60000, windowMs: 60000,
  maxLivePtys: 3, maxRendererHosts: 2,
  limits: {
    mainHeap: { peakBytes: 512 * MiB, growthBytes: 64 * MiB, slopeBytesPerMin: 16 * MiB },
    mainRss: { peakBytes: 1536 * MiB, growthBytes: 192 * MiB, slopeBytesPerMin: 64 * MiB },
    rendererHeap: { peakBytes: 512 * MiB, growthBytes: 64 * MiB, slopeBytesPerMin: 16 * MiB },
    rendererRss: { peakBytes: 1536 * MiB, growthBytes: 192 * MiB, slopeBytesPerMin: 64 * MiB },
    electronRss: { peakBytes: 3072 * MiB, growthBytes: 256 * MiB, slopeBytesPerMin: 96 * MiB },
    paneRss: { peakBytes: 512 * MiB, growthBytes: 128 * MiB, slopeBytesPerMin: 32 * MiB },
  },
});
export const SOAK_ELECTRON = '43.7.4';
export const SOAK_HEAP_SOURCE = 'electron.process.getHeapStatistics/v43.7.4/KiB';
export const soakNonce = z.string().uuid().regex(/^[a-f0-9-]+$/u);
const integer = z.number().int().safe().nonnegative();
const positive = integer.positive();
const activity = z.object({ writeConfirmed: z.literal(true), executedMarker: z.literal(true), renderedMarker: z.literal(true),
  frames: integer.min(2).max(8), scroll: z.literal(true), resize: z.literal(true), workspaceRead: z.literal(true), search: z.literal(true) }).strict();
export const soakCycleSchema = z.object({ nonce: soakNonce, sequence: integer.max(SOAK_POLICY.maxSamples - 1),
  sessionId: z.string().min(1).max(256), paneId: z.string().min(1).max(256), rendererPid: positive,
  electronVersion: z.literal(SOAK_ELECTRON), heapUsedKiB: positive.max(4 * 1024 * 1024),
  rendererHosts: positive.max(SOAK_POLICY.maxRendererHosts), activity }).strict();
export type SoakCycle = z.infer<typeof soakCycleSchema>;
export function parseSoakCycle(raw: unknown): SoakCycle | null {
  const parsed = soakCycleSchema.safeParse(raw); return parsed.success ? parsed.data : null;
}
const memory = z.object({ mainHeap: positive, mainRss: positive, rendererHeap: positive,
  rendererRss: positive, electronRss: positive, paneRss: positive }).strict();
const sample = z.object({ sequence: integer.max(SOAK_POLICY.maxSamples - 1), elapsedMs: z.number().finite().positive().max(SOAK_POLICY.timeoutMs),
  rendererPid: positive, livePtys: positive.max(SOAK_POLICY.maxLivePtys), rendererHosts: positive.max(SOAK_POLICY.maxRendererHosts),
  memoryBytes: memory, activity: activity.extend({ physicalClose: z.literal(true) }).strict() }).strict();
export type SoakSample = z.infer<typeof sample>;
export function parseSoakSample(raw: unknown): SoakSample | null {
  const parsed = sample.safeParse(raw); return parsed.success ? parsed.data : null;
}
export interface SoakMetricSummary { peakBytes: number; baselineMedianBytes: number; finalMedianBytes: number; growthBytes: number; slopeBytesPerMin: number }
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
/** Independent consumers must recompute this from raw samples, never accept a summary alone. */
export function assertSoakSamples(raw: unknown, durationMs: number): Record<keyof SoakSample['memoryBytes'], SoakMetricSummary> {
  const values = z.array(sample).min(SOAK_POLICY.minSamples).max(SOAK_POLICY.maxSamples).parse(raw);
  if (!Number.isFinite(durationMs) || durationMs < SOAK_POLICY.requiredDurationMs || durationMs > SOAK_POLICY.timeoutMs ||
      values[0]!.elapsedMs > SOAK_POLICY.maxGapMs || values.at(-1)!.elapsedMs < SOAK_POLICY.requiredDurationMs ||
      values.at(-1)!.elapsedMs > durationMs || durationMs - values.at(-1)!.elapsedMs > SOAK_POLICY.maxGapMs) throw new Error('soak duration/activity coverage incomplete');
  for (let i = 0; i < values.length; i++) {
    if (values[i]!.sequence !== i || values[i]!.rendererPid !== values[0]!.rendererPid || i &&
      (values[i]!.elapsedMs <= values[i - 1]!.elapsedMs || values[i]!.elapsedMs - values[i - 1]!.elapsedMs > SOAK_POLICY.maxGapMs)) throw new Error('soak activity cadence or process changed');
  }
  const baseline = values.filter(v => v.elapsedMs >= SOAK_POLICY.warmupMs && v.elapsedMs < SOAK_POLICY.warmupMs + SOAK_POLICY.windowMs);
  const tail = values.filter(v => v.elapsedMs >= values.at(-1)!.elapsedMs - SOAK_POLICY.windowMs);
  const warm = values.filter(v => v.elapsedMs >= SOAK_POLICY.warmupMs);
  if (baseline.length < 4 || tail.length < 4) throw new Error('soak growth windows incomplete');
  return Object.fromEntries(Object.entries(SOAK_POLICY.limits).map(([name, limit]) => {
    const key = name as keyof SoakSample['memoryBytes'];
    const peakBytes = Math.max(...values.map(v => v.memoryBytes[key]));
    const baselineMedianBytes = median(baseline.map(v => v.memoryBytes[key]));
    const finalMedianBytes = median(tail.map(v => v.memoryBytes[key]));
    const growthBytes = finalMedianBytes - baselineMedianBytes;
    const xMean = warm.reduce((s, v) => s + v.elapsedMs / 60000, 0) / warm.length;
    const yMean = warm.reduce((s, v) => s + v.memoryBytes[key], 0) / warm.length;
    const slopeBytesPerMin = warm.reduce((s, v) => s + (v.elapsedMs / 60000 - xMean) * (v.memoryBytes[key] - yMean), 0) /
      warm.reduce((s, v) => s + (v.elapsedMs / 60000 - xMean) ** 2, 0);
    if (peakBytes > limit.peakBytes || growthBytes > limit.growthBytes || slopeBytesPerMin > limit.slopeBytesPerMin) throw new Error(`soak memory bound exceeded: ${name}`);
    return [key, { peakBytes, baselineMedianBytes, finalMedianBytes, growthBytes, slopeBytesPerMin }];
  })) as Record<keyof SoakSample['memoryBytes'], SoakMetricSummary>;
}
