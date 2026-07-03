import { tapSessionData, tapSessionExit } from '../pty/pty-manager';
import { findPane } from './pane-registry';
import { estimateCost, estimateTokens } from './pricing';
import type { CostSnapshot, PaneCost } from '../../shared/cost-types';

/**
 * Per-pane token/cost accounting fed by the PTY data taps. Only cli-agent
 * panes are metered. Without provider usage APIs the counts are heuristic:
 * output tokens are estimated from the raw stream (~4 chars/token) and input
 * tokens are approximated as a multiple of output — agents re-read far more
 * context than they emit, so the multiplier keeps the estimate honest in
 * direction even if not in precision.
 *
 * Crossing a pane's capUsd only flags `paused` and emits a change event — the
 * integration layer decides what "paused" actually does (this module never
 * writes to sessions).
 */

/** Estimated input tokens per output token (context re-reads dominate input). */
const INPUT_PER_OUTPUT_RATIO = 3;
/** Rolling window for the $/min and tok/s rates. */
const RATE_WINDOW_MS = 60_000;
/** Change events are coalesced to at most one per second. */
const EMIT_THROTTLE_MS = 1_000;

interface PaneCostEntry {
  paneId: string;
  sessionId: string;
  adapterId?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  capUsd?: number;
  paused: boolean;
}

interface RateSample {
  at: number;
  outputTokens: number;
  usd: number;
}

export type CostChangeListener = (snapshot: CostSnapshot) => void;

const entries = new Map<string, PaneCostEntry>();
let rateSamples: RateSample[] = [];
const listeners = new Set<CostChangeListener>();

let initialized = false;
let emitTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

function pruneSamples(now: number): void {
  rateSamples = rateSamples.filter((s) => now - s.at <= RATE_WINDOW_MS);
}

function emitNow(): void {
  dirty = false;
  const snapshot = getCostSnapshot();
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (err) {
      console.warn('[cost-tracker] change listener threw:', err);
    }
  }
}

function scheduleEmit(): void {
  dirty = true;
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    if (dirty) emitNow();
  }, EMIT_THROTTLE_MS);
}

function handleChunk(sessionId: string, data: string): void {
  if (data.length === 0) return;
  const pane = findPane(sessionId);
  if (!pane || pane.kind !== 'cli-agent' || !pane.sessionId) return;

  let entry = entries.get(pane.paneId);
  if (!entry) {
    entry = {
      paneId: pane.paneId,
      sessionId: pane.sessionId,
      adapterId: pane.adapterId,
      model: pane.model,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      paused: false,
    };
    entries.set(pane.paneId, entry);
  }
  // Failover may re-spawn the pane on a new session — follow it.
  entry.sessionId = pane.sessionId;
  if (pane.model) entry.model = pane.model;

  const outputTokens = estimateTokens(data);
  const inputTokens = outputTokens * INPUT_PER_OUTPUT_RATIO;
  const usd = estimateCost(entry.model, inputTokens, outputTokens);

  entry.outputTokens += outputTokens;
  entry.inputTokens += inputTokens;
  entry.costUsd += usd;

  if (
    entry.capUsd !== undefined &&
    !entry.paused &&
    entry.costUsd >= entry.capUsd
  ) {
    entry.paused = true;
  }

  const now = Date.now();
  rateSamples.push({ at: now, outputTokens, usd });
  pruneSamples(now);
  scheduleEmit();
}

/** Start metering. Idempotent — safe to call once from registerCostIpc(). */
export function initCostTracker(): void {
  if (initialized) return;
  initialized = true;
  tapSessionData(handleChunk);
  // Exited sessions keep their accumulated cost (money already spent); the
  // exit tap exists only so rates decay promptly after the last chunk.
  tapSessionExit(() => scheduleEmit());
}

/** Aggregate snapshot of every metered pane. */
export function getCostSnapshot(): CostSnapshot {
  const now = Date.now();
  pruneSamples(now);
  let perMinuteUsd = 0;
  let windowTokens = 0;
  for (const sample of rateSamples) {
    perMinuteUsd += sample.usd;
    windowTokens += sample.outputTokens;
  }
  const panes: PaneCost[] = [...entries.values()].map((entry) => ({
    ...entry,
  }));
  return {
    totalUsd: panes.reduce((sum, pane) => sum + pane.costUsd, 0),
    perMinuteUsd,
    tokPerSec: windowTokens / (RATE_WINDOW_MS / 1_000),
    panes,
  };
}

/**
 * Set (or clear, with null) a pane's spending cap. Raising the cap above the
 * accumulated cost — or clearing it — un-pauses the pane. Returns false when
 * the pane id is unknown to the registry.
 */
export function setPaneCap(paneId: string, capUsd: number | null): boolean {
  let entry = entries.get(paneId);
  if (!entry) {
    const pane = findPane(paneId);
    if (!pane || pane.kind !== 'cli-agent') return false;
    entry = {
      paneId: pane.paneId,
      sessionId: pane.sessionId ?? '',
      adapterId: pane.adapterId,
      model: pane.model,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      paused: false,
    };
    entries.set(paneId, entry);
  }
  entry.capUsd = capUsd ?? undefined;
  entry.paused = capUsd !== null && entry.costUsd >= capUsd;
  scheduleEmit();
  return true;
}

/** Subscribe to throttled snapshot updates. Returns an unsubscribe handle. */
export function onCostChange(cb: CostChangeListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
